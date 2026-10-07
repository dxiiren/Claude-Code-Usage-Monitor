// Reads the stored readings and the current settings, and hands them to the pure report maths.
import { UserError } from './db';
import { SERVER } from './paths';
import { buildReport, formatDate, parseDate, periodDates, rangeOf, reportDateOf, type Period, type Report } from './report';
import { firstSampleUnix, reportAccounts, sampleHours, samplesBetween } from './serverUsage';
import { getSettings } from './settings';

const PERIODS: Period[] = ['day', 'week', 'month'];
/**
 * Readings this far before the period are loaded too. They give each account a baseline level to
 * measure rises from, and they show when a weekly limit still in force at the start was reached.
 */
const LOOKBACK_S = 7 * 86_400 + 6 * 3600;

export function asPeriod(raw: unknown): Period {
	return PERIODS.includes(raw as Period) ? (raw as Period) : getSettings().reportPeriod;
}

/** Today's report day in the configured time zone. */
export function todayDate(nowMs = Date.now()): string {
	const s = getSettings();
	return reportDateOf(s.timezone, Math.floor(nowMs / 1000), s.slots);
}

export function asDate(raw: unknown, nowMs = Date.now()): string {
	if (raw === undefined || raw === null || raw === '') return todayDate(nowMs);
	if (typeof raw !== 'string' || Number.isNaN(parseDate(raw))) throw new UserError('That date is not valid. Use the form 2026-10-06.');
	return raw;
}

export interface ReportPayload extends Report {
	today: string;
	/** first report day that has any reading, or null when history has not started */
	firstDate: string | null;
	generatedUnix: number;
	/** the two windows' names from Settings, as the Usage page shows them */
	labels: { session: string; weekly: string };
	/** the levels from Settings the report was cut with */
	limitAt: number;
	idleBelow: number;
}

export function loadReport(rawPeriod: unknown, rawDate: unknown, nowMs = Date.now()): ReportPayload {
	if (!SERVER) throw new UserError('Reports are only available on the server.', 404);
	const s = getSettings();
	const period = asPeriod(rawPeriod);
	const date = asDate(rawDate, nowMs);
	const range = rangeOf(periodDates(period, date), s.slots, s.timezone);
	const first = firstSampleUnix();
	return {
		...buildReport({
			period,
			date,
			slots: s.slots,
			timezone: s.timezone,
			accounts: reportAccounts(),
			samples: samplesBetween(range.from - LOOKBACK_S, range.to),
			limitAt: s.limitAt,
			idleBelow: s.idleBelow
		}),
		today: todayDate(nowMs),
		firstDate: first === null ? null : reportDateOf(s.timezone, first, s.slots),
		generatedUnix: Math.floor(nowMs / 1000),
		labels: { session: s.hourlyLabel, weekly: s.weeklyLabel },
		limitAt: s.limitAt,
		idleBelow: s.idleBelow
	};
}

/** The report days of a month ("2026-10") that have at least one reading: the calendar dots. */
export function daysWithData(rawMonth: unknown): string[] {
	if (!SERVER) return [];
	const m = typeof rawMonth === 'string' ? /^(\d{4})-(\d{2})$/.exec(rawMonth) : null;
	if (!m || +m[2] < 1 || +m[2] > 12) throw new UserError('That month is not valid. Use the form 2026-10.');
	const s = getSettings();
	const dates = periodDates('month', formatDate(Date.UTC(+m[1], +m[2] - 1, 1)));
	const range = rangeOf(dates, s.slots, s.timezone);
	const have = new Set<string>();
	// Hour buckets start on the UTC hour; probing inside the hour covers zones offset by 30 or 45 minutes too.
	for (const h of sampleHours(range.from - 3600, range.to)) {
		for (const t of [h, h + 1799, h + 3599]) {
			if (t < range.from || t >= range.to) continue;
			have.add(reportDateOf(s.timezone, t, s.slots));
		}
	}
	return dates.filter((d) => have.has(d));
}
