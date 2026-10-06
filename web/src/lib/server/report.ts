// Report maths: pure functions, no database and no clock, so every case is testable with explicit
// timestamps. The poller keeps raw readings (usage_samples); a report cuts them into the
// configured time slots when it is opened, which is why slots can change at any time.
import { slotLength, type Slot } from '../slots';

/** One stored reading of the 5-hour ("hourly session") window. */
export interface Sample {
	ts: number;
	/** % used, or null when the window was not active */
	pct: number | null;
	reset: number | null;
}

export interface ReportAccount {
	id: string;
	name: string;
	provider: string;
	/** false = the account was removed; its history is still reported */
	current: boolean;
}

export type Period = 'day' | 'week' | 'month';

const DAY_MS = 86_400_000;
/** A reading this long after the previous one cannot belong to the same 5-hour window. */
const WINDOW_S = 5 * 3600;
/** Jitter allowed in a window's reported reset time before it counts as a new window. */
const RESET_JITTER_S = 600;

// ---------- time zone helpers (Intl only, no date library) ----------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string, ms: number): { y: number; mo: number; d: number; h: number; mi: number } {
	let f = fmtCache.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
		fmtCache.set(tz, f);
	}
	const o: Record<string, number> = {};
	for (const p of f.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = Number(p.value);
	return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute };
}

/** Wall-clock fields as if they were UTC ("naive" ms): convenient for date arithmetic. */
function naive(tz: string, ms: number): number {
	const p = parts(tz, ms);
	return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
}

/** Naive wall-clock ms in `tz` -> real unix seconds (two passes settle DST edges). */
export function wallToUnix(tz: string, naiveMs: number): number {
	let guess = naiveMs;
	for (let i = 0; i < 3; i++) guess += naiveMs - naive(tz, guess);
	return Math.floor(guess / 1000);
}

export const parseDate = (date: string): number => {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) return NaN;
	const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
	return new Date(ms).getUTCDate() === +m[3] ? ms : NaN;
};
export const formatDate = (naiveMs: number): string => new Date(naiveMs).toISOString().slice(0, 10);

/**
 * The report day a moment belongs to. A report day runs 24 hours from the first slot's start,
 * so 02:00 on the 7th belongs to the 6th when the day starts at 09:00.
 */
export function reportDateOf(tz: string, unix: number, slots: Slot[]): string {
	const n = naive(tz, unix * 1000) - slots[0].from * 60_000;
	return formatDate(Math.floor(n / DAY_MS) * DAY_MS);
}

export interface SlotWindow {
	start: number;
	end: number;
}

/** Real start/end (unix s) of every slot on one report day. */
export function slotWindows(date: string, slots: Slot[], tz: string): SlotWindow[] {
	const day = parseDate(date);
	const first = slots[0].from;
	return slots.map((s) => {
		// minutes after the report day's start; a slot "before" the first one belongs to the next morning
		const offset = (s.from - first + 1440) % 1440;
		const startNaive = day + (first + offset) * 60_000;
		return { start: wallToUnix(tz, startNaive), end: wallToUnix(tz, startNaive + slotLength(s) * 60_000) };
	});
}

/** The report days a period covers. Week = Monday to Sunday. */
export function periodDates(period: Period, date: string): string[] {
	const day = parseDate(date);
	if (period === 'day') return [date];
	if (period === 'week') {
		const mon = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
		return Array.from({ length: 7 }, (_, k) => formatDate(mon + k * DAY_MS));
	}
	const d = new Date(day);
	const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
	return Array.from({ length: n }, (_, k) => formatDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), k + 1)));
}

/** Unix range [from, to) that holds every slot of the given report days. */
export function rangeOf(dates: string[], slots: Slot[], tz: string): { from: number; to: number } {
	const first = wallToUnix(tz, parseDate(dates[0]) + slots[0].from * 60_000);
	const last = wallToUnix(tz, parseDate(dates[dates.length - 1]) + slots[0].from * 60_000 + DAY_MS);
	return { from: first, to: last };
}

// ---------- usage between readings ----------

export interface Increment {
	ts: number;
	use: number;
}

/**
 * How much of the session allowance was used between each pair of readings. A drop in the level,
 * a moved reset time or a silence longer than the window all mean the window reset, so the new
 * level counts as fresh use. The very first reading has no baseline and adds nothing.
 */
export function increments(samples: Sample[]): Increment[] {
	const out: Increment[] = [];
	let prev: Sample | null = null;
	for (const cur of samples) {
		if (prev) {
			const now = cur.pct ?? 0;
			const before = prev.pct ?? 0;
			const reset =
				now < before - 0.5 ||
				(cur.reset !== null && prev.reset !== null && cur.reset > prev.reset + RESET_JITTER_S) ||
				cur.ts - prev.ts > WINDOW_S;
			const use = reset ? now : Math.max(0, now - before);
			if (use > 0) out.push({ ts: cur.ts, use });
		}
		prev = cur;
	}
	return out;
}

export interface LimitHit {
	ts: number;
	accountId: string;
	account: string;
	pct: number;
	/** seconds until the window reset, when the reading carried a reset time */
	blockedSeconds: number | null;
}

/** Each time a level crosses `limitAt` from below. */
export function limitHits(samples: Sample[], limitAt: number): { ts: number; pct: number; blockedSeconds: number | null }[] {
	const out: { ts: number; pct: number; blockedSeconds: number | null }[] = [];
	let prev: Sample | null = null;
	for (const cur of samples) {
		const now = cur.pct ?? 0;
		const sameWindow = prev && !(now < (prev.pct ?? 0) - 0.5) && cur.ts - prev.ts <= WINDOW_S;
		const wasBelow = !prev || !sameWindow || (prev.pct ?? 0) < limitAt;
		if (now >= limitAt && wasBelow && prev) out.push({ ts: cur.ts, pct: now, blockedSeconds: cur.reset && cur.reset > cur.ts ? cur.reset - cur.ts : null });
		prev = cur;
	}
	return out;
}

// ---------- the report itself ----------

export interface ReportInput {
	period: Period;
	date: string;
	slots: Slot[];
	timezone: string;
	accounts: ReportAccount[];
	/** readings per account id, oldest first, covering rangeOf(...) plus a few hours before it */
	samples: Map<string, Sample[]>;
	limitAt: number;
	idleBelow: number;
}

export interface Report {
	period: Period;
	date: string;
	dates: string[];
	timezone: string;
	slots: { name: string; from: number; to: number }[];
	hasData: boolean;
	accounts: { id: string; name: string; provider: string; current: boolean; slots: number[]; total: number; daysUsed: number }[];
	days: { date: string; hasData: boolean; slots: number[]; total: number }[];
	slotTotals: number[];
	total: number;
	daysWithData: number;
	hits: LimitHit[];
	busiestSlot: number | null;
	topAccount: string | null;
	idle: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function buildReport(input: ReportInput): Report {
	const { slots, timezone: tz } = input;
	const dates = periodDates(input.period, input.date);
	const range = rangeOf(dates, slots, tz);
	const windows = dates.map((d) => slotWindows(d, slots, tz));
	const zero = () => slots.map(() => 0);

	const days = dates.map((date) => ({ date, hasData: false, slots: zero(), total: 0 }));
	const hits: LimitHit[] = [];
	const accounts = input.accounts.map((a) => {
		const all = input.samples.get(a.id) ?? [];
		const perSlot = zero();
		const usedOn = new Set<number>();
		const inRange = all.filter((s) => s.ts >= range.from && s.ts < range.to);
		for (const s of inRange) {
			const di = dates.indexOf(reportDateOf(tz, s.ts, slots));
			if (di >= 0) days[di].hasData = true;
		}
		for (const inc of increments(all)) {
			if (inc.ts < range.from || inc.ts >= range.to) continue;
			for (let di = 0; di < windows.length; di++) {
				// a reading exactly on a boundary belongs to the slot that just ended
				const si = windows[di].findIndex((w) => inc.ts > w.start && inc.ts <= w.end);
				if (si < 0) continue;
				perSlot[si] += inc.use;
				days[di].slots[si] += inc.use;
				usedOn.add(di);
				break;
			}
		}
		for (const h of limitHits(all, input.limitAt))
			if (h.ts >= range.from && h.ts < range.to) hits.push({ ...h, accountId: a.id, account: a.name });
		const total = perSlot.reduce((x, y) => x + y, 0);
		return { id: a.id, name: a.name, provider: a.provider, current: a.current, slots: perSlot.map(round1), total: round1(total), daysUsed: usedOn.size, had: inRange.length > 0 };
	});

	// an account that was removed and has nothing in this period would only be noise
	const shown = accounts.filter((a) => a.current || a.had).map(({ had: _had, ...a }) => a);
	for (const d of days) {
		d.total = round1(d.slots.reduce((x, y) => x + y, 0));
		d.slots = d.slots.map(round1);
	}
	const slotTotals = slots.map((_, i) => round1(shown.reduce((x, a) => x + a.slots[i], 0)));
	const total = round1(slotTotals.reduce((x, y) => x + y, 0));
	const hasData = days.some((d) => d.hasData);
	const best = Math.max(...slotTotals);
	const top = [...shown].sort((x, y) => y.total - x.total)[0];
	hits.sort((x, y) => x.ts - y.ts);
	return {
		period: input.period,
		date: input.date,
		dates,
		timezone: tz,
		slots: slots.map((s) => ({ ...s })),
		hasData,
		accounts: shown,
		days,
		slotTotals,
		total,
		daysWithData: days.filter((d) => d.hasData).length,
		hits,
		busiestSlot: hasData && best > 0 ? slotTotals.indexOf(best) : null,
		topAccount: hasData && top && top.total > 0 ? top.name : null,
		idle: hasData ? shown.filter((a) => a.current && a.total < input.idleBelow).map((a) => a.name) : []
	};
}
