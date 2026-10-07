// Report maths: pure functions, no database and no clock, so every case is testable with explicit
// timestamps. The poller keeps raw readings (usage_samples); a report cuts them into the
// configured time slots when it is opened, which is why slots can change at any time.
import { slotLength, type Slot } from '../slots';

/** One stored reading: the 5-hour ("hourly session") window, and the 7-day one when it was kept. */
export interface Sample {
	ts: number;
	/** % of the 5-hour window used, or null when the window was not active */
	pct: number | null;
	reset: number | null;
	/** the 7-day window of the same reading */
	weekPct?: number | null;
	weekReset?: number | null;
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
/** A reading this long after the previous one cannot belong to the same window. */
const WINDOW_S = { session: 5 * 3600, weekly: 7 * 86_400 } as const;
export type LimitWindow = keyof typeof WINDOW_S;
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

interface Level {
	ts: number;
	pct: number;
	reset: number | null;
}

/**
 * One window of the readings as plain levels. A reading without a percentage means the window was
 * not active (0), unless the readings on both sides of it carry the same reset time: then the
 * window never stopped, the reading is only a missing answer, and it is left out.
 */
function levels(samples: Sample[], window: LimitWindow): Level[] {
	const weekly = window === 'weekly';
	const raw = samples.map((s) => ({ ts: s.ts, pct: (weekly ? s.weekPct : s.pct) ?? null, reset: (weekly ? s.weekReset : s.reset) ?? null }));
	// for each position, the next reading that has a percentage
	const next: ((typeof raw)[number] | null)[] = new Array(raw.length).fill(null);
	for (let i = raw.length - 2; i >= 0; i--) next[i] = raw[i + 1].pct !== null ? raw[i + 1] : next[i + 1];
	const out: Level[] = [];
	let known: (typeof raw)[number] | null = null;
	for (let i = 0; i < raw.length; i++) {
		const cur = raw[i];
		if (cur.pct !== null) {
			out.push({ ts: cur.ts, pct: cur.pct, reset: cur.reset });
			known = cur;
			continue;
		}
		const before = known?.reset ?? null;
		const after = next[i]?.reset ?? null;
		const sameWindow = before !== null && after !== null && Math.abs(after - before) <= RESET_JITTER_S;
		if (!sameWindow) out.push({ ts: cur.ts, pct: 0, reset: cur.reset });
	}
	return out;
}

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
	let prev: Level | null = null;
	for (const cur of levels(samples, 'session')) {
		if (prev) {
			const reset =
				cur.pct < prev.pct - 0.5 ||
				(cur.reset !== null && prev.reset !== null && cur.reset > prev.reset + RESET_JITTER_S) ||
				cur.ts - prev.ts > WINDOW_S.session;
			const use = reset ? cur.pct : Math.max(0, cur.pct - prev.pct);
			if (use > 0) out.push({ ts: cur.ts, use });
		}
		prev = cur;
	}
	return out;
}

/** One stretch an account spent at or above the limit level in one window. */
export interface LimitSpell {
	/** the first reading that saw the account at its limit */
	ts: number;
	/** the last reading that still saw it there */
	last: number;
	/** which allowance ran out: the 5-hour session or the 7-day one */
	window: LimitWindow;
	/** the highest level seen */
	pct: number;
	/** no reading saw it get there (they start, or resume after a long silence, with it at the limit): reached some time before `ts` */
	before: boolean;
	/** when the window resets and the account is free again, when a reading carried it */
	until: number | null;
	/** seconds from `ts` to that reset */
	blockedSeconds: number | null;
}

export interface LimitHit extends Omit<LimitSpell, 'last'> {
	accountId: string;
	account: string;
}

/**
 * Every stretch at or above `limitAt` in one window, from the first reading that saw the account
 * there to the last. A stretch already running at the first reading is kept: the account was
 * blocked, even though no reading saw it get there.
 */
export function limitHits(samples: Sample[], limitAt: number, window: LimitWindow = 'session'): LimitSpell[] {
	const out: LimitSpell[] = [];
	let open: LimitSpell | null = null;
	let prev: Level | null = null;
	for (const cur of levels(samples, window)) {
		const silent = prev !== null && cur.ts - prev.ts > WINDOW_S[window];
		// a later reset time means the window turned over, even with the level still at the limit
		const turned = open !== null && open.until !== null && cur.reset !== null && cur.reset > open.until + RESET_JITTER_S;
		if (cur.pct < limitAt || silent || turned) open = null;
		if (cur.pct >= limitAt) {
			if (!open) out.push((open = { ts: cur.ts, last: cur.ts, window, pct: cur.pct, before: prev === null || silent, until: null, blockedSeconds: null }));
			open.last = cur.ts;
			open.pct = Math.max(open.pct, cur.pct);
			if (cur.reset !== null && cur.reset > cur.ts) {
				// to the minute: the provider reports the same reset a second early or late from reading to reading
				open.until = Math.round(cur.reset / 60) * 60;
				open.blockedSeconds = open.until - open.ts;
			}
		}
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
	/** readings per account id, oldest first, covering rangeOf(...) plus a week before it */
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
	/** when the period really starts and ends (unix seconds): report days run from the first slot */
	from: number;
	to: number;
	/** every limit in force at some moment of the period, whenever it was reached */
	hits: LimitHit[];
	busiestSlot: number | null;
	topAccount: string | null;
	/** the top account's own total (a name can repeat once an account was removed and added again) */
	topTotal: number;
	/** current accounts that had readings, were never at a limit, and stayed under the "not used" level */
	idle: string[];
	/** current accounts without a single reading in the period: nothing is known about their use */
	noReadings: string[];
	/** % used at times no slot covers; it is in none of the figures above */
	outsideSlots: number;
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
		// a reading exactly on a boundary belongs to the slot, and so to the day, that just ended
		const inRange = all.filter((s) => s.ts > range.from && s.ts <= range.to);
		for (const s of inRange) {
			const di = dates.indexOf(reportDateOf(tz, s.ts - 1, slots));
			if (di >= 0) days[di].hasData = true;
		}
		let outside = 0;
		for (const inc of increments(all)) {
			if (inc.ts <= range.from || inc.ts > range.to) continue;
			let placed = false;
			for (let di = 0; di < windows.length && !placed; di++) {
				const si = windows[di].findIndex((w) => inc.ts > w.start && inc.ts <= w.end);
				if (si < 0) continue;
				perSlot[si] += inc.use;
				days[di].slots[si] += inc.use;
				usedOn.add(di);
				placed = true;
			}
			if (!placed) outside += inc.use;
		}
		let limited = false;
		for (const window of ['session', 'weekly'] as const)
			for (const { last, ...h } of limitHits(all, input.limitAt, window)) {
				// In force at some moment of the period, whenever it began. A level only falls when the
				// window resets, so the limit held until then even if the readings stopped earlier.
				if (h.ts > range.to || Math.max(last, h.until ?? 0) <= range.from) continue;
				hits.push({ ...h, accountId: a.id, account: a.name });
				limited = true;
			}
		const total = perSlot.reduce((x, y) => x + y, 0);
		return {
			id: a.id,
			name: a.name,
			provider: a.provider,
			current: a.current,
			slots: perSlot.map(round1),
			total: round1(total),
			daysUsed: usedOn.size,
			had: inRange.length > 0,
			outside,
			limited
		};
	});

	// an account that was removed and has nothing in this period would only be noise
	const kept = accounts.filter((a) => a.current || a.had);
	const shown = kept.map(({ had: _had, outside: _outside, limited: _limited, ...a }) => a);
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
		from: range.from,
		to: range.to,
		hits,
		busiestSlot: hasData && best > 0 ? slotTotals.indexOf(best) : null,
		topAccount: hasData && top && top.total > 0 ? top.name : null,
		topTotal: hasData && top ? top.total : 0,
		// judged as the page shows it (whole %), and counting use that fell outside the slots
		idle: hasData ? kept.filter((a) => a.current && a.had && !a.limited && Math.round(a.total + a.outside) < input.idleBelow).map((a) => a.name) : [],
		noReadings: hasData ? kept.filter((a) => a.current && !a.had).map((a) => a.name) : [],
		outsideSlots: round1(kept.reduce((x, a) => x + a.outside, 0))
	};
}
