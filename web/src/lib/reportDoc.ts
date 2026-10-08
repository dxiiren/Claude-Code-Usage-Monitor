// The downloaded report as plain data: sections of paragraphs, bullet lists, figures and tables.
// One model feeds the on-screen "Download preview", the Word file, the PDF and the CSV, so all
// four always say the same thing. Layout: cover page, optional notice and contents page, numbered sections.
import { PRINT_PALETTE, columns, groupedBars, type Drawn } from './chart';
import { slotName, slotRange, type Slot } from './slots';
import type { ReportPayload } from './server/reportData';

export type View = 'both' | 'graph' | 'table';

export interface DocSettings {
	title: string;
	company: string;
	website: string;
	email: string;
	footer: string;
	notice: string;
	format: 'docx' | 'pdf' | 'csv';
	cover: boolean;
	contents: boolean;
	logo: boolean;
}

export type Block =
	| { type: 'p'; text: string }
	| { type: 'bullets'; items: string[] }
	| { type: 'figure'; chart: Drawn; caption: string }
	| { type: 'table'; head: string[]; rows: string[][]; caption: string; totalRow?: boolean };

export interface DocModel {
	title: string;
	subtitle: string;
	period: string;
	company: string;
	/** company, website and e-mail, the ones that are set, for the centred block */
	contact: string[];
	/** line above the title on the cover */
	coverLabel: string;
	footer: string;
	notice: string;
	monthYear: string;
	preparedBy: string;
	generated: string;
	cover: boolean;
	contents: boolean;
	logo: boolean;
	sections: { title: string; blocks: Block[] }[];
	fileStem: string;
}

const utc = (date: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(`${date}T00:00:00Z`));
/** Whole percent. Something used but under half a percent reads "<1%": as "0%" it would add up to a total it does not explain. */
export const pct = (v: number) => (v > 0 && v < 0.5 ? '<1%' : `${Math.round(v)}%`);
/** "A", "A and B", "A, B and C" */
const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** "Tuesday, 6 October 2026" / "Week of 5 Oct to 11 Oct 2026" / "October 2026" */
export function periodLabel(r: Pick<ReportPayload, 'period' | 'dates'>): string {
	const first = r.dates[0];
	const last = r.dates[r.dates.length - 1];
	if (r.period === 'day') return utc(first, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	if (r.period === 'week') return `Week of ${utc(first, { day: 'numeric', month: 'short' })} to ${utc(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
	return utc(first, { month: 'long', year: 'numeric' });
}
export const dayLabel = (date: string) => utc(date, { weekday: 'short', day: 'numeric', month: 'short' });
export const shortDay = (date: string, many: boolean) => (many ? utc(date, { day: 'numeric' }) : utc(date, { weekday: 'short', day: 'numeric' }));

/** A moment in the report's time zone: "Tue, 6 Oct, 15:42". */
export function whenLabel(unix: number, timezone: string): string {
	// a moment no date can hold must not take the whole report down
	if (!Number.isFinite(unix) || Math.abs(unix) > 8.64e12) return 'not known';
	return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(unix * 1000);
}

/** "45 min", "2 h 15 min", "2 d 3 h" */
export function blockedLabel(seconds: number | null): string {
	if (seconds === null) return 'not known';
	const m = Math.round(seconds / 60);
	if (m >= 1440) return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
	return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

type Hit = ReportPayload['hits'][number];

/** When a limit was reached; "Before ..." when no reading saw the account get there. */
export const reachedLabel = (h: Hit, timezone: string) => `${h.before ? 'Before ' : ''}${whenLabel(h.ts, timezone)}`;
/** Which limit a row is about: one of the two windows by its name from Settings, or "Opus limit" for a limit of its own. */
export const limitName = (h: Hit, labels: ReportPayload['labels']) => (h.scope === 'window' ? labels[h.window] : `${h.model} limit`);
/** One model's own limit is used up: only that model stops, the account is not blocked. */
export const modelOut = (h: Hit) => h.scope === 'model' && h.pct >= 100;
/** Another allowance the provider reports (a feature, a team) is used up: what it stops is not known, so it is not called blocked. */
export const otherOut = (h: Hit) => h.scope === 'other' && h.pct >= 100;
/** Past 100% on paid extra usage the whole time: the account kept working. */
export const onExtra = (h: Hit) => h.scope === 'window' && h.pct >= 100 && h.extra === 'all';
/** Only 100% of a whole window blocks an account, and not while paid extra usage covers it; Settings can count a lower level as "limit reached". */
export const isBlocked = (h: Hit) => h.scope === 'window' && h.pct >= 100 && h.extra !== 'all';
/** The account as a limit row names it: one removed since says so. */
export const hitAccount = (h: Hit) => `${h.account}${h.current ? '' : ' (removed)'}`;
/** A whole-window limit blocked the same account during this stretch: "other models still work" would then be untrue. */
export const alsoBlocked = (h: Hit, hits: Hit[]) =>
	hits.some((x) => x !== h && x.accountId === h.accountId && isBlocked(x) && x.ts <= (h.until ?? Infinity) && (x.until ?? Infinity) >= h.ts);
/** "2 h 15 min"; "at least ..." when it was reached before the first reading that saw it. `hits` = the report's other rows. */
export function blockedFor(h: Hit, hits: Hit[] = []): string {
	if (onExtra(h)) return 'not blocked (paid extra usage)';
	if (modelOut(h)) return alsoBlocked(h, hits) ? 'this model only (the account was blocked as well)' : 'not blocked (other models still work)';
	if (otherOut(h)) return 'not known (this limit only)';
	if (!isBlocked(h)) return `not blocked (${pct(h.pct)})`;
	return `${h.before && h.blockedSeconds !== null ? 'at least ' : ''}${blockedLabel(h.blockedSeconds)}${h.extra === 'part' ? ' (the rest on paid extra usage)' : ''}`;
}
/**
 * A limit's row on the page: "blocked 2 h 0 min · until Tue, 6 Oct, 11:30". `ctx.hits` = the report's
 * other rows; `ctx.now` = when the report was made, so a limit still in force is not worded as if its
 * whole length had passed.
 */
export function hitState(h: Hit, timezone: string, ctx: { hits?: Hit[]; now?: number } = {}): string {
	const resets = h.until === null ? '' : ` · resets ${whenLabel(h.until, timezone)}`;
	if (onExtra(h)) return `not blocked: on paid extra usage${resets}`;
	if (modelOut(h)) return `${h.model} used up${alsoBlocked(h, ctx.hits ?? []) ? '' : ', other models still work'}${resets}`;
	if (otherOut(h)) return `${h.model} limit reached${resets}`;
	if (!isBlocked(h)) return `reached ${pct(h.pct)}${resets}`;
	if (h.until === null) return h.extra === 'part' ? 'blocked (part of the time on paid extra usage)' : 'blocked';
	return `blocked ${blockedFor(h)}${ctx.now !== undefined && h.until > ctx.now ? ' in all' : ''} · until ${whenLabel(h.until, timezone)}`;
}

const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;
/** "Claude", "Codex" or "Claude and Codex": whose accounts the report covers. */
function services(r: ReportPayload): string {
	const codex = r.accounts.some((a) => a.provider === 'codex');
	const claude = r.accounts.some((a) => a.provider !== 'codex');
	return codex && claude ? 'Claude and Codex' : codex ? 'Codex' : 'Claude';
}

const head = (s: Slot) => (s.name.trim() ? `${slotName(s)} (${slotRange(s)})` : slotRange(s));

/** The charts of a report. `palette` = page colours on screen, print colours in a document. */
export function slotChart(r: ReportPayload, palette = PRINT_PALETTE): Drawn {
	return groupedBars({
		groups: r.slots.map((s) => ({ label: slotName(s), sub: s.name.trim() ? slotRange(s) : undefined })),
		series: r.accounts.map((a) => a.name),
		values: r.slots.map((_, si) => r.accounts.map((a) => a.slots[si])),
		palette,
		label: 'Usage by time slot, one bar per account',
		// the page has its own legend under the chart; in a document the chart carries it
		legend: palette === PRINT_PALETTE
	});
}
export function dayChart(r: ReportPayload, palette = PRINT_PALETTE): Drawn {
	return columns({
		labels: r.days.map((d) => shortDay(d.date, r.days.length > 10)),
		values: r.days.map((d) => (d.hasData ? d.total : null)),
		palette,
		label: 'Total usage per day, all accounts'
	});
}

/**
 * What the "not used" list really says. With the level at 1% an account that used a little (its row
 * reads "<1%") is on it too, and "not used at all" would contradict that row.
 */
export function idleWording(r: ReportPayload): string {
	const touched = r.accounts.some((a) => r.idle.includes(a.name) && a.total > 0);
	return r.idleBelow > 1 || touched ? `Used less than ${Math.max(1, r.idleBelow)}%` : 'Not used at all';
}

/** The 5-hour window by its name from Settings, in running text ("hourly session"). */
export const windowName = (r: Pick<ReportPayload, 'labels'>) => r.labels.session.trim().toLowerCase() || 'hourly session';
/**
 * The kept readings begin inside the period (history started then, or older readings were removed
 * by "Keep history for"): the part before them is not covered, and the figures are low by its use.
 */
export function startsLate(r: ReportPayload): string | null {
	if (r.firstUnix === null || r.firstUnix <= r.from + 600 || r.firstUnix > r.to) return null;
	return `The saved readings start on ${whenLabel(r.firstUnix, r.timezone)}. The part of the period before that is not covered by these figures.`;
}

export function summaryLines(r: ReportPayload): string[] {
	if (!r.hasData) return [];
	const many = r.period !== 'day';
	// an account without a single reading is not "0% used": it is left out of the count and named further down
	const read = r.accounts.filter((a) => a.had).length;
	const out = [
		`Total usage across ${read} ${read === 1 ? 'account' : 'accounts'} was ${pct(r.total)} of one ${windowName(r)}${many ? ` over ${r.daysWithData} ${r.daysWithData === 1 ? 'day' : 'days'} with data` : ''}.`
	];
	if (r.busiestSlots.length > 1) out.push(`The busiest time slots were ${list(r.busiestSlots.map((i) => head(r.slots[i])))} with ${pct(r.slotTotals[r.busiestSlots[0]])} each.`);
	else if (r.busiestSlot !== null) out.push(`The busiest time slot was ${head(r.slots[r.busiestSlot])} with ${pct(r.slotTotals[r.busiestSlot])}.`);
	if (r.topAccounts.length > 1) out.push(`The most used accounts were ${list(r.topAccounts)} with ${pct(r.topTotal)} each.`);
	else if (r.topAccount) out.push(`The most used account was ${r.topAccount} with ${pct(r.topTotal)}.`);
	const blocked = r.hits.filter(isBlocked);
	out.push(blocked.length ? `An account was blocked by a limit ${times(blocked.length)}: ${[...new Set(blocked.map(hitAccount))].join(', ')}.` : 'No account was blocked by a limit.');
	const paid = r.hits.filter(onExtra);
	if (paid.length) out.push(`An account went past a limit and kept working on paid extra usage ${times(paid.length)}: ${[...new Set(paid.map(hitAccount))].join(', ')}.`);
	const models = r.hits.filter(modelOut);
	if (models.length)
		out.push(
			`A limit on one model was reached ${times(models.length)}${models.some((h) => alsoBlocked(h, r.hits)) ? '' : ', with the other models still working'}: ${[...new Set(models.map((h) => `${hitAccount(h)} (${h.model})`))].join(', ')}.`
		);
	const others = r.hits.filter(otherOut);
	if (others.length) out.push(`Another limit was reached ${times(others.length)}: ${[...new Set(others.map((h) => `${hitAccount(h)} (${h.model})`))].join(', ')}.`);
	const near = r.hits.length - blocked.length - paid.length - models.length - others.length;
	if (near) out.push(`An account reached ${r.limitAt}% of a limit without being blocked ${times(near)}.`);
	if (r.idle.length) out.push(`${idleWording(r)}: ${r.idle.join(', ')}.`);
	if (r.noReadings.length) out.push(`No readings were saved for: ${r.noReadings.join(', ')}. Their use in this period is not known.`);
	if (r.outsideSlots >= 0.5) out.push(`${pct(r.outsideSlots)} was used at times no time slot covers and is in none of these figures.`);
	const uncovered = startsLate(r);
	if (uncovered) out.push(uncovered);
	return out;
}

export function buildDoc(r: ReportPayload, doc: DocSettings, view: View, preparedBy: string): DocModel {
	const showG = view !== 'table';
	const showT = view !== 'graph';
	const many = r.period !== 'day';
	let fig = 0;
	let tab = 0;
	const sections: DocModel['sections'] = [];

	const limits = (): DocModel['sections'][number] => ({
		title: 'Limits Reached',
		blocks: r.hits.length
			? [
					{
						type: 'p',
						text: `Each time an account was at a limit and could not be used until that limit reset. A limit reached before the period and still in force during it is listed too.${r.hits.some((h) => h.extra !== 'none') ? ' An account with paid extra usage kept working past its limit for as long as that lasted; that time is not counted as blocked.' : ''}${r.hits.some((h) => h.scope === 'model') ? ' A limit on one model stops that model only; the account itself is not blocked.' : ''}${r.hits.some((h) => h.scope === 'other') ? ' Other limits the provider reports are listed by its own name for them; what such a limit stops is not known.' : ''}${r.limitAt < 100 ? ` Settings counts ${r.limitAt}% as a limit reached; an account is only blocked at 100%.` : ''}`
					},
					{
						type: 'table',
						head: ['Reached', 'Account', 'Limit', 'Blocked for', 'Blocked until'],
						rows: r.hits.map((h) => [
							reachedLabel(h, r.timezone),
							hitAccount(h),
							limitName(h, r.labels),
							blockedFor(h, r.hits),
							!isBlocked(h) ? '-' : h.until === null ? 'not known' : whenLabel(h.until, r.timezone)
						]),
						caption: `Table ${++tab}. Limits reached`
					}
				]
			: [{ type: 'p', text: 'No account was blocked by a limit in this period.' }]
	});

	if (!r.hasData) {
		sections.push({ title: 'Summary', blocks: [{ type: 'p', text: 'No usage data was saved for this period.' }] });
		// no reading in the period, yet a limit reached earlier still held during it
		if (r.hits.length) sections.push(limits());
	} else {
		sections.push({
			title: 'Summary',
			blocks: [
				{ type: 'p', text: `This report shows how the company's ${services(r)} accounts were used during the period, split by time slot.` },
				{ type: 'bullets', items: summaryLines(r) }
			]
		});

		const slotBlocks: Block[] = [];
		if (showG && r.accounts.length) slotBlocks.push({ type: 'figure', chart: slotChart(r), caption: `Figure ${++fig}. ${r.labels.session} used in each time slot, by account (%)` });
		if (showT)
			slotBlocks.push({
				type: 'table',
				head: ['Account', ...r.slots.map(head), 'Total', ...(many ? ['Days used'] : [])],
				rows: [
					...r.accounts.map((a) => [
						`${a.name}${a.provider === 'codex' ? ' (Codex)' : ''}${a.current ? '' : ' (removed)'}${a.had ? '' : ' (no readings)'}`,
						// no reading in the period: its use is not known, which is not the same as 0%
						...(a.had ? [...a.slots.map(pct), pct(a.total), ...(many ? [`${a.daysUsed} of ${r.daysWithData}`] : [])] : [...a.slots.map(() => '-'), '-', ...(many ? ['-'] : [])])
					]),
					['All accounts', ...r.slotTotals.map(pct), pct(r.total), ...(many ? [''] : [])]
				],
				caption: `Table ${++tab}. ${r.labels.session} used in each time slot, by account${r.accounts.some((a) => !a.had) ? ' (- = no readings saved for the account)' : ''}`,
				totalRow: true
			});
		sections.push({ title: 'Usage by Time Slot', blocks: slotBlocks });

		if (many) {
			const dayBlocks: Block[] = [];
			if (showG) dayBlocks.push({ type: 'figure', chart: dayChart(r), caption: `Figure ${++fig}. Total ${windowName(r)} used per day, all accounts (%)` });
			if (showT)
				dayBlocks.push({
					type: 'table',
					head: ['Date', ...r.slots.map(head), 'Total'],
					rows: r.days.map((d) => [dayLabel(d.date).replace(/ /g, '\u00a0'), ...(d.hasData ? [...d.slots.map(pct), pct(d.total)] : [...r.slots.map(() => '-'), '-'])]),
					caption: `Table ${++tab}. Daily usage by time slot, all accounts (- = no data saved that day)`
				});
			sections.push({ title: 'Usage by Day', blocks: dayBlocks });
		}

		sections.push(limits());
	}

	sections.push({
		title: 'Notes on the Figures',
		blocks: [
			{
				type: 'p',
				text: `Figures are a percentage of one ${windowName(r)} allowance per account. In an account's own row, a value above 100% means its ${windowName(r)} reset and was used again within the period; rows that add up accounts or days pass 100% simply by adding. Figures are rounded to whole percent, so a total can differ by 1% from the sum of the figures shown under it. Each report day runs from ${slotRange(r.slots[0]).split(' – ')[0]} to the same time the next day, so a slot that runs past midnight belongs to the day it starts on. Times are in the ${r.timezone} time zone.`
			}
		]
	});

	const generated = new Date(r.generatedUnix * 1000);
	return {
		title: doc.title,
		subtitle: '(Usage by Time Slot)',
		period: periodLabel(r),
		company: doc.company,
		contact: [doc.company, doc.website, doc.email].filter((x) => x.trim()),
		coverLabel: `${doc.company.replace(/\s*Sdn\.?\s*Bhd\.?$/i, '')} Internal Report`.trim(),
		footer: doc.footer,
		notice: doc.notice,
		monthYear: new Intl.DateTimeFormat('en-GB', { timeZone: r.timezone, month: 'long', year: 'numeric' }).format(generated),
		preparedBy,
		generated: new Intl.DateTimeFormat('en-GB', { timeZone: r.timezone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(generated),
		cover: doc.cover,
		contents: doc.contents,
		logo: doc.logo,
		sections,
		fileStem: `${doc.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Usage-Report'}-${r.period === 'day' ? r.date : `${r.dates[0]}-to-${r.dates[r.dates.length - 1]}`}`
	};
}

/** The tables only, as CSV (opens in Excel: UTF-8 with a byte-order mark, CRLF lines). */
export function toCsv(m: DocModel): string {
	const cell = (raw: string) => {
		// a leading = + - @ (or tab / CR) would run as a formula when the file is opened;
		// a dash on its own is the "no data" mark and runs nothing, so it stays as it is
		const v = raw !== '-' && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
		return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
	};
	const lines: string[] = [cell(m.title), cell(m.period), ''];
	for (const s of m.sections)
		for (const b of s.blocks)
			if (b.type === 'table') {
				lines.push(cell(b.caption.replace(/^Table \d+\. /, '')));
				lines.push(b.head.map(cell).join(','));
				for (const r of b.rows) lines.push(r.map(cell).join(','));
				lines.push('');
			}
	return `﻿${lines.join('\r\n')}`;
}
