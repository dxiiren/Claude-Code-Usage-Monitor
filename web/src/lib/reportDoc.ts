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
export const pct = (v: number) => `${Math.round(v)}%`;

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
/** Only 100% blocks an account; Settings can count a lower level as "limit reached". */
export const isBlocked = (h: Hit) => h.pct >= 100;
/** "2 h 15 min"; "at least ..." when it was reached before the first reading that saw it. */
export function blockedFor(h: Hit): string {
	if (!isBlocked(h)) return `not blocked (${pct(h.pct)})`;
	return `${h.before && h.blockedSeconds !== null ? 'at least ' : ''}${blockedLabel(h.blockedSeconds)}`;
}
/** A limit's row on the page: "blocked 2 h 0 min · until Tue, 6 Oct, 11:30". */
export function hitState(h: Hit, timezone: string): string {
	if (!isBlocked(h)) return `reached ${pct(h.pct)}${h.until === null ? '' : ` · resets ${whenLabel(h.until, timezone)}`}`;
	return h.until === null ? 'blocked' : `blocked ${blockedFor(h)} · until ${whenLabel(h.until, timezone)}`;
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
		label: 'Usage by time slot, one bar per account'
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

export function summaryLines(r: ReportPayload): string[] {
	if (!r.hasData) return [];
	const many = r.period !== 'day';
	const out = [
		`Total usage across ${r.accounts.length} ${r.accounts.length === 1 ? 'account' : 'accounts'} was ${pct(r.total)} of an hourly session${many ? ` over ${r.daysWithData} ${r.daysWithData === 1 ? 'day' : 'days'} with data` : ''}.`
	];
	if (r.busiestSlot !== null) out.push(`The busiest time slot was ${head(r.slots[r.busiestSlot])} with ${pct(r.slotTotals[r.busiestSlot])}.`);
	if (r.topAccount) out.push(`The most used account was ${r.topAccount} with ${pct(r.topTotal)}.`);
	const blocked = r.hits.filter(isBlocked);
	out.push(blocked.length ? `An account was blocked by a limit ${times(blocked.length)}: ${[...new Set(blocked.map((h) => h.account))].join(', ')}.` : 'No account was blocked by a limit.');
	const near = r.hits.length - blocked.length;
	if (near) out.push(`An account reached ${r.limitAt}% of a limit without being blocked ${times(near)}.`);
	if (r.idle.length) out.push(`${r.idleBelow > 1 ? `Used less than ${r.idleBelow}%` : 'Not used at all'}: ${r.idle.join(', ')}.`);
	if (r.noReadings.length) out.push(`No readings were saved for: ${r.noReadings.join(', ')}. Their use in this period is not known.`);
	if (r.outsideSlots >= 0.5) out.push(`${pct(r.outsideSlots)} was used at times no time slot covers and is in none of these figures.`);
	return out;
}

export function buildDoc(r: ReportPayload, doc: DocSettings, view: View, preparedBy: string): DocModel {
	const showG = view !== 'table';
	const showT = view !== 'graph';
	const many = r.period !== 'day';
	let fig = 0;
	let tab = 0;
	const sections: DocModel['sections'] = [];

	if (!r.hasData) {
		sections.push({ title: 'Summary', blocks: [{ type: 'p', text: 'No usage data was saved for this period.' }] });
	} else {
		sections.push({
			title: 'Summary',
			blocks: [
				{ type: 'p', text: `This report shows how the company's ${services(r)} accounts were used during the period, split by time slot.` },
				{ type: 'bullets', items: summaryLines(r) }
			]
		});

		const slotBlocks: Block[] = [];
		if (showG && r.accounts.length) slotBlocks.push({ type: 'figure', chart: slotChart(r), caption: `Figure ${++fig}. Hourly session used in each time slot, by account (%)` });
		if (showT)
			slotBlocks.push({
				type: 'table',
				head: ['Account', ...r.slots.map(head), 'Total', ...(many ? ['Days used'] : [])],
				rows: [
					...r.accounts.map((a) => [
						`${a.name}${a.provider === 'codex' ? ' (Codex)' : ''}${a.current ? '' : ' (removed)'}`,
						...a.slots.map(pct),
						pct(a.total),
						...(many ? [`${a.daysUsed} of ${r.daysWithData}`] : [])
					]),
					['All accounts', ...r.slotTotals.map(pct), pct(r.total), ...(many ? [''] : [])]
				],
				caption: `Table ${++tab}. Hourly session used in each time slot, by account`,
				totalRow: true
			});
		sections.push({ title: 'Usage by Time Slot', blocks: slotBlocks });

		if (many) {
			const dayBlocks: Block[] = [];
			if (showG) dayBlocks.push({ type: 'figure', chart: dayChart(r), caption: `Figure ${++fig}. Total hourly session used per day, all accounts (%)` });
			if (showT)
				dayBlocks.push({
					type: 'table',
					head: ['Date', ...r.slots.map(head), 'Total'],
					rows: r.days.map((d) => [dayLabel(d.date).replace(/ /g, '\u00a0'), ...(d.hasData ? [...d.slots.map(pct), pct(d.total)] : [...r.slots.map(() => '-'), '-'])]),
					caption: `Table ${++tab}. Daily usage by time slot, all accounts (- = no data saved that day)`
				});
			sections.push({ title: 'Usage by Day', blocks: dayBlocks });
		}

		sections.push({
			title: 'Limits Reached',
			blocks: r.hits.length
				? [
						{
							type: 'p',
							text: `Each time an account was at a limit and could not be used until that limit reset. A limit reached before the period and still in force during it is listed too.${r.limitAt < 100 ? ` Settings counts ${r.limitAt}% as a limit reached; an account is only blocked at 100%.` : ''}`
						},
						{
							type: 'table',
							head: ['Reached', 'Account', 'Limit', 'Blocked for', 'Blocked until'],
							rows: r.hits.map((h) => [
								reachedLabel(h, r.timezone),
								h.account,
								r.labels[h.window],
								blockedFor(h),
								!isBlocked(h) ? '-' : h.until === null ? 'not known' : whenLabel(h.until, r.timezone)
							]),
							caption: `Table ${++tab}. Limits reached`
						}
					]
				: [{ type: 'p', text: 'No account was blocked by a limit in this period.' }]
		});
	}

	sections.push({
		title: 'Notes on the Figures',
		blocks: [
			{
				type: 'p',
				text: `Figures are a percentage of one hourly session allowance per account. A value above 100% means the session reset and was used again within the period. Each report day runs for 24 hours from ${slotRange(r.slots[0]).split(' – ')[0]}, so a slot that runs past midnight belongs to the day it starts on. Times are in the ${r.timezone} time zone.`
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
		// a leading = + - @ (or tab / CR) would run as a formula when the file is opened
		const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
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
