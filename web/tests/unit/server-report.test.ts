import { describe, expect, it } from 'vitest';
import { buildReport, increments, limitHits, periodDates, reportDateOf, slotWindows, wallToUnix, type ReportAccount, type Sample } from '../../src/lib/server/report';
import { slotsProblem, uncoveredMinutes, type Slot } from '../../src/lib/slots';
import { blockedLabel, buildDoc, summaryLines, toCsv, whenLabel, type DocModel, type DocSettings } from '../../src/lib/reportDoc';
import type { ReportPayload } from '../../src/lib/server/reportData';

const KL = 'Asia/Kuala_Lumpur'; // UTC+8, no DST
const SLOTS: Slot[] = [
	{ name: 'Morning', from: 540, to: 780 },
	{ name: 'Lunch', from: 780, to: 840 },
	{ name: 'Afternoon', from: 840, to: 1080 },
	{ name: 'After hours', from: 1080, to: 540 }
];
/** Kuala Lumpur wall time -> unix seconds */
const kl = (date: string, hhmm: string) => Math.floor(Date.parse(`${date}T${hhmm}:00+08:00`) / 1000);
const s = (date: string, hhmm: string, pct: number | null, resetIn: number | null = null): Sample => {
	const ts = kl(date, hhmm);
	return { ts, pct, reset: resetIn === null ? null : ts + resetIn };
};
const ACC: ReportAccount[] = [{ id: 'a', name: 'Alpha', provider: 'claude', current: true }];
const report = (samples: Sample[], over: Partial<Parameters<typeof buildReport>[0]> = {}) =>
	buildReport({ period: 'day', date: '2026-10-06', slots: SLOTS, timezone: KL, accounts: ACC, samples: new Map([['a', samples]]), limitAt: 100, idleBelow: 1, ...over });

describe('time zone and slot windows', () => {
	it('converts wall time in the zone to unix seconds', () => {
		expect(wallToUnix(KL, Date.UTC(2026, 9, 6, 9, 0))).toBe(kl('2026-10-06', '09:00'));
		// a zone with daylight saving: 09:00 New York on a summer and a winter day
		expect(wallToUnix('America/New_York', Date.UTC(2026, 6, 1, 9, 0))).toBe(Date.parse('2026-07-01T09:00:00-04:00') / 1000);
		expect(wallToUnix('America/New_York', Date.UTC(2026, 0, 15, 9, 0))).toBe(Date.parse('2026-01-15T09:00:00-05:00') / 1000);
	});
	it('gives each slot its real start and end; the overnight slot ends the next morning', () => {
		const w = slotWindows('2026-10-06', SLOTS, KL);
		expect(w[0]).toEqual({ start: kl('2026-10-06', '09:00'), end: kl('2026-10-06', '13:00') });
		expect(w[1]).toEqual({ start: kl('2026-10-06', '13:00'), end: kl('2026-10-06', '14:00') });
		expect(w[3]).toEqual({ start: kl('2026-10-06', '18:00'), end: kl('2026-10-07', '09:00') });
	});
	it('a moment before the day starts belongs to the previous report day', () => {
		expect(reportDateOf(KL, kl('2026-10-07', '02:00'), SLOTS)).toBe('2026-10-06');
		expect(reportDateOf(KL, kl('2026-10-07', '09:00'), SLOTS)).toBe('2026-10-07');
	});
	it('week runs Monday to Sunday, month covers every day', () => {
		expect(periodDates('week', '2026-10-06')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
		expect(periodDates('month', '2026-02-10')).toHaveLength(28);
	});
});

describe('usage between readings', () => {
	it('adds each rise, ignores flat readings, and the first reading has no baseline', () => {
		expect(increments([s('2026-10-06', '09:00', 10), s('2026-10-06', '09:05', 10), s('2026-10-06', '09:10', 25)])).toEqual([{ ts: kl('2026-10-06', '09:10'), use: 15 }]);
	});
	it('a drop means the session reset: the new level is fresh use, never negative', () => {
		const inc = increments([s('2026-10-06', '10:00', 80), s('2026-10-06', '10:05', 5)]);
		expect(inc).toEqual([{ ts: kl('2026-10-06', '10:05'), use: 5 }]);
	});
	it('a moved reset time means a new session even when the level went up', () => {
		const a: Sample = { ts: 1000, pct: 20, reset: 5000 };
		const b: Sample = { ts: 1300, pct: 30, reset: 5000 + 5 * 3600 };
		expect(increments([a, b])).toEqual([{ ts: 1300, use: 30 }]);
	});
	it('a silence longer than the window counts the new level as fresh use', () => {
		expect(increments([s('2026-10-06', '09:00', 40, null), s('2026-10-06', '16:00', 45, null)])).toEqual([{ ts: kl('2026-10-06', '16:00'), use: 45 }]);
	});
	it('an inactive window (no percentage) is treated as zero', () => {
		expect(increments([s('2026-10-06', '09:00', null, null), s('2026-10-06', '09:05', 12)])).toEqual([{ ts: kl('2026-10-06', '09:05'), use: 12 }]);
	});
});

describe('the report', () => {
	const day = [
		s('2026-10-06', '08:55', 0),
		s('2026-10-06', '10:00', 30), // morning +30
		s('2026-10-06', '12:55', 62), // morning +32
		s('2026-10-06', '13:30', 66), // lunch +4
		s('2026-10-06', '14:30', 20), // reset during the afternoon: +20
		s('2026-10-06', '17:55', 91), // afternoon +71
		s('2026-10-06', '23:00', 12), // after hours: reset, +12
		s('2026-10-07', '08:00', 15) // still the 6th's after-hours slot; 9 h of silence, so fresh use: +15
	];
	it('credits usage to the slot of the reading that saw it', () => {
		const r = report(day);
		expect(r.accounts[0].slots).toEqual([62, 4, 91, 27]);
		expect(r.accounts[0].total).toBe(184);
		expect(r.slotTotals).toEqual([62, 4, 91, 27]);
		expect(r.busiestSlot).toBe(2);
		expect(r.topAccount).toBe('Alpha');
		expect(r.hasData).toBe(true);
	});
	it('a reading exactly on a boundary belongs to the slot that just ended', () => {
		const r = report([s('2026-10-06', '09:00', 0), s('2026-10-06', '13:00', 40)]);
		expect(r.accounts[0].slots).toEqual([40, 0, 0, 0]);
	});
	it('re-cuts the same readings when the slots change', () => {
		const two: Slot[] = [
			{ name: 'Day', from: 540, to: 1080 },
			{ name: 'Night', from: 1080, to: 540 }
		];
		const r = report(day, { slots: two });
		expect(r.accounts[0].slots).toEqual([157, 27]);
		expect(r.accounts[0].total).toBe(184);
	});
	it('leaves out usage that falls in time no slot covers', () => {
		const gap: Slot[] = [{ name: 'Morning only', from: 540, to: 780 }];
		expect(uncoveredMinutes(gap)).toBe(1200);
		const r = report(day, { slots: gap });
		expect(r.accounts[0].slots).toEqual([62]);
		// ...but says how much that was, and such an account is not "not used"
		expect(r.outsideSlots).toBe(122);
		const afternoonOnly = report([s('2026-10-06', '14:00', 0), s('2026-10-06', '14:30', 50), s('2026-10-06', '15:00', 90)], { slots: gap });
		expect(afternoonOnly.total).toBe(0);
		expect(afternoonOnly.outsideSlots).toBe(90);
		expect(afternoonOnly.idle).toEqual([]);
		expect(report(day).outsideSlots).toBe(0);
	});
	it('a reading exactly at the start of a report day is counted once, in the day that just ended', () => {
		const readings = [s('2026-10-07', '08:55', 10), s('2026-10-07', '09:00', 30), s('2026-10-07', '09:05', 31)];
		const sixth = report(readings, { date: '2026-10-06' });
		const seventh = report(readings, { date: '2026-10-07' });
		expect(sixth.accounts[0].slots).toEqual([0, 0, 0, 20]);
		expect(seventh.accounts[0].slots).toEqual([1, 0, 0, 0]);
		expect(report(readings, { period: 'week', date: '2026-10-06' }).total).toBe(sixth.total + seventh.total);
	});
	it('a reading with no percentage inside a running session is a missing answer, not a reset', () => {
		const at = kl('2026-10-06', '14:00');
		const same = [{ ts: kl('2026-10-06', '10:00'), pct: 60, reset: at }, { ts: kl('2026-10-06', '10:05'), pct: null, reset: null }, { ts: kl('2026-10-06', '10:10'), pct: 62, reset: at }];
		expect(increments(same)).toEqual([{ ts: kl('2026-10-06', '10:10'), use: 2 }]);
		// between two different sessions it does mean the window was not active
		const next = [same[0], same[1], { ts: kl('2026-10-06', '14:30'), pct: 12, reset: at + 5 * 3600 }];
		expect(increments(next)).toEqual([{ ts: kl('2026-10-06', '14:30'), use: 12 }]);
		expect(limitHits([{ ...same[0], pct: 100 }, same[1], { ...same[2], pct: 100 }], 100)).toHaveLength(1);
	});
	it('week: per-day totals, days used and days with data', () => {
		const r = report([...day, s('2026-10-08', '10:00', 15), s('2026-10-08', '11:00', 35)], { period: 'week' });
		expect(r.dates).toHaveLength(7);
		expect(r.days[1].total).toBe(184);
		// the 8th: the reading at 10:00 follows a silence longer than a window, so its level is fresh use
		expect(r.days[3].slots[0]).toBe(35);
		// the 08:55 reading is before the day starts at 09:00, so it belongs to Monday the 5th
		expect(r.days.map((d) => d.hasData)).toEqual([true, true, false, true, false, false, false]);
		expect(r.accounts[0].daysUsed).toBe(2);
		expect(r.daysWithData).toBe(3);
	});
	it('no readings: no data, nothing marked idle', () => {
		const r = report([]);
		expect(r.hasData).toBe(false);
		expect(r.idle).toEqual([]);
		expect(r.busiestSlot).toBeNull();
	});
	it('marks an unused current account idle, and drops a removed account with nothing in the period', () => {
		const accounts: ReportAccount[] = [...ACC, { id: 'b', name: 'Beta', provider: 'claude', current: true }, { id: 'gone', name: 'Old', provider: 'claude', current: false }];
		const r = buildReport({ period: 'day', date: '2026-10-06', slots: SLOTS, timezone: KL, accounts, samples: new Map([['a', day], ['b', [s('2026-10-06', '09:30', 0), s('2026-10-06', '10:30', 0)]]]), limitAt: 100, idleBelow: 1 });
		expect(r.accounts.map((a) => a.name)).toEqual(['Alpha', 'Beta']);
		expect(r.idle).toEqual(['Beta']);
		expect(r.noReadings).toEqual([]);
	});
	it('an account with no reading at all is "not known", never "not used"', () => {
		const accounts: ReportAccount[] = [...ACC, { id: 'b', name: 'Beta', provider: 'claude', current: true }];
		const r = buildReport({ period: 'day', date: '2026-10-06', slots: SLOTS, timezone: KL, accounts, samples: new Map([['a', day]]), limitAt: 100, idleBelow: 1 });
		expect(r.idle).toEqual([]);
		expect(r.noReadings).toEqual(['Beta']);
	});
	it('the top account keeps its own total when a removed account shares its name', () => {
		const accounts: ReportAccount[] = [{ id: 'new', name: 'Ali', provider: 'claude', current: true }, { id: 'old', name: 'Ali', provider: 'claude', current: false }];
		const samples = new Map([
			['new', [s('2026-10-06', '09:30', 0), s('2026-10-06', '10:30', 40)]],
			['old', [s('2026-10-06', '09:30', 0), s('2026-10-06', '10:30', 60)]]
		]);
		const r = buildReport({ period: 'day', date: '2026-10-06', slots: SLOTS, timezone: KL, accounts, samples, limitAt: 100, idleBelow: 1 });
		expect([r.topAccount, r.topTotal]).toEqual(['Ali', 60]);
	});
	it('"not used" is judged on the whole percentage the page shows', () => {
		const r = report([s('2026-10-06', '09:30', 0), s('2026-10-06', '10:30', 0.6)]);
		expect(r.idle).toEqual([]);
		expect(report([s('2026-10-06', '09:30', 0), s('2026-10-06', '10:30', 0.4)]).idle).toEqual(['Alpha']);
	});
});

describe('limits', () => {
	const DAY_S = 86_400;
	/** A reading that carries the weekly window too: `week` % used, resetting `weekResetIn` seconds later. */
	const sw = (date: string, hhmm: string, pct: number | null, week: number | null, weekResetIn: number | null = null): Sample => {
		const base = s(date, hhmm, pct);
		return { ...base, weekPct: week, weekReset: weekResetIn === null ? null : base.ts + weekResetIn };
	};

	it('lists each time a limit was reached, with how long it stayed blocked', () => {
		const r = report([s('2026-10-06', '09:00', 80), s('2026-10-06', '09:30', 100, 2 * 3600), s('2026-10-06', '09:35', 100, 2 * 3600 - 300)]);
		expect(r.hits).toEqual([
			{ ts: kl('2026-10-06', '09:30'), window: 'session', pct: 100, before: false, until: kl('2026-10-06', '11:30'), blockedSeconds: 7200, accountId: 'a', account: 'Alpha' }
		]);
	});
	it('a session that resets and fills again is two hits', () => {
		const r = report([s('2026-10-06', '09:00', 80), s('2026-10-06', '09:30', 100, 2 * 3600), s('2026-10-06', '11:32', 5), s('2026-10-06', '12:00', 100, 4 * 3600)]);
		expect(r.hits.map((h) => [h.ts, h.blockedSeconds])).toEqual([
			[kl('2026-10-06', '09:30'), 7200],
			[kl('2026-10-06', '12:00'), 14_400]
		]);
	});
	it('a weekly limit counts even when the hourly session was never touched', () => {
		const r = report([sw('2026-10-06', '09:00', 0, 96, 2 * DAY_S), sw('2026-10-06', '09:30', 0, 100, 2 * DAY_S - 1800), sw('2026-10-06', '09:35', 0, 100, 2 * DAY_S - 2100)]);
		expect(r.hits).toEqual([
			{ ts: kl('2026-10-06', '09:30'), window: 'weekly', pct: 100, before: false, until: kl('2026-10-08', '09:00'), blockedSeconds: 2 * DAY_S - 1800, accountId: 'a', account: 'Alpha' }
		]);
		// blocked is not the same as not used
		expect(r.accounts[0].total).toBe(0);
		expect(r.idle).toEqual([]);
	});
	it('an account already at its limit at the first reading is listed, marked as reached earlier', () => {
		expect(limitHits([{ ts: 1, pct: 100, reset: null }], 100)).toEqual([{ ts: 1, last: 1, window: 'session', pct: 100, before: true, until: null, blockedSeconds: null }]);
		const r = report([sw('2026-10-06', '12:22', 0, 100, 2 * DAY_S), sw('2026-10-06', '12:24', 0, 100, 2 * DAY_S - 120)]);
		expect(r.hits).toMatchObject([{ ts: kl('2026-10-06', '12:22'), window: 'weekly', before: true, until: kl('2026-10-08', '12:22') }]);
		expect(r.idle).toEqual([]);
	});
	it('a limit reached on an earlier day is listed on every day it is still in force, and not after it resets', () => {
		const readings = [
			sw('2026-10-05', '09:55', 0, 97, 2 * DAY_S + 300),
			sw('2026-10-05', '10:00', 0, 100, 2 * DAY_S),
			sw('2026-10-05', '20:00', 0, 100, 2 * DAY_S - 10 * 3600),
			sw('2026-10-06', '10:00', 0, 100, DAY_S),
			sw('2026-10-06', '20:00', 0, 100, DAY_S - 10 * 3600),
			sw('2026-10-07', '09:58', 0, 100, 120),
			sw('2026-10-07', '10:02', 0, 0, 7 * DAY_S),
			sw('2026-10-08', '10:00', 0, 3, 6 * DAY_S)
		];
		const reached = kl('2026-10-05', '10:00');
		for (const date of ['2026-10-05', '2026-10-06', '2026-10-07'])
			expect(report(readings, { date }).hits, date).toMatchObject([{ ts: reached, window: 'weekly', before: false, until: kl('2026-10-07', '10:00') }]);
		expect(report(readings, { date: '2026-10-08' }).hits).toEqual([]);
		// one stretch at the limit is one entry in a week, however many days it covers
		expect(report(readings, { period: 'week', date: '2026-10-06' }).hits).toHaveLength(1);
	});
	it('a silence longer than the window hides when the limit was reached', () => {
		const hits = limitHits([s('2026-10-06', '09:00', 20), s('2026-10-06', '16:00', 100, 3600)], 100);
		expect(hits).toMatchObject([{ ts: kl('2026-10-06', '16:00'), before: true }]);
	});
	it('only an unused account that could have been used is marked not used', () => {
		const accounts: ReportAccount[] = [...ACC, { id: 'b', name: 'Beta', provider: 'claude', current: true }];
		const samples = new Map([
			['a', [sw('2026-10-06', '09:30', 0, 100, DAY_S), sw('2026-10-06', '10:30', 0, 100, DAY_S - 3600)]],
			['b', [sw('2026-10-06', '09:30', 0, 10, DAY_S), sw('2026-10-06', '10:30', 0, 10, DAY_S - 3600)]]
		]);
		const r = buildReport({ period: 'day', date: '2026-10-06', slots: SLOTS, timezone: KL, accounts, samples, limitAt: 100, idleBelow: 1 });
		expect(r.idle).toEqual(['Beta']);
		expect(r.hits.map((h) => h.account)).toEqual(['Alpha']);
	});
	it('the limit level from Settings applies to both windows', () => {
		const r = report([sw('2026-10-06', '09:00', 50, 80, DAY_S), sw('2026-10-06', '09:30', 92, 95, DAY_S - 1800)], { limitAt: 90 });
		expect(r.hits.map((h) => h.window).sort()).toEqual(['session', 'weekly']);
	});
	it('a limit holds until its reset even when the readings stop before the day begins', () => {
		// the last reading is at 08:58, two minutes before the 7th starts; the weekly window resets at 09:50
		const stopped = [sw('2026-10-07', '08:40', 0, 95, 70 * 60), sw('2026-10-07', '08:50', 0, 100, 60 * 60), sw('2026-10-07', '08:58', 0, 100, 52 * 60)];
		const r = report(stopped, { date: '2026-10-07' });
		expect(r.hasData).toBe(false);
		expect(r.hits).toMatchObject([{ ts: kl('2026-10-07', '08:50'), window: 'weekly', until: kl('2026-10-07', '09:50') }]);
		expect(report(stopped, { date: '2026-10-08' }).hits).toEqual([]);
		// a reading exactly on the boundary belongs to the day before, and the limit still shows on the new day
		const onTheLine = [sw('2026-10-07', '08:40', 0, 95, 70 * 60), sw('2026-10-07', '09:00', 0, 100, 50 * 60)];
		expect(report(onTheLine, { date: '2026-10-07' }).hits).toHaveLength(1);
	});
	it('reads one reset time, whichever second the provider reports it at', () => {
		const at = kl('2026-10-08', '13:00');
		const wobble = [at - 1, at, at - 1].map((weekReset, i) => ({ ...s('2026-10-06', `12:2${2 + i * 2}`, 0), weekPct: 100, weekReset }));
		expect(report(wobble).hits[0].until).toBe(at);
	});
});

describe('the limits in the document', () => {
	const DOC: DocSettings = { title: 'Usage', company: '', website: '', email: '', footer: '', notice: '', format: 'docx', cover: false, contents: false, logo: false };
	const payload = (samples: Sample[], limitAt = 100, date = '2026-10-06'): ReportPayload => ({
		...report(samples, { limitAt, date }),
		today: '2026-10-06',
		firstDate: '2026-10-06',
		generatedUnix: kl('2026-10-06', '18:00'),
		labels: { session: 'Hourly session', weekly: 'Weekly session' },
		limitAt,
		idleBelow: 1
	});
	const limitsOf = (r: ReportPayload) => buildDoc(r, DOC, 'table', 'admin').sections.find((x) => x.title === 'Limits Reached')!.blocks;

	it('names the limit that ran out and when the account is free again', () => {
		const r = payload([
			{ ...s('2026-10-06', '12:22', 0), weekPct: 100, weekReset: kl('2026-10-08', '12:59') },
			{ ...s('2026-10-06', '12:24', 0), weekPct: 100, weekReset: kl('2026-10-08', '12:59') }
		]);
		const table = limitsOf(r).find((b) => b.type === 'table');
		expect(table).toMatchObject({ head: ['Reached', 'Account', 'Limit', 'Blocked for', 'Blocked until'] });
		// the date wording comes from the runtime's own formatter, so build it the same way
		expect((table as { rows: string[][] }).rows).toEqual([
			['Before ' + whenLabel(kl('2026-10-06', '12:22'), KL), 'Alpha', 'Weekly session', 'at least 2 d 0 h', whenLabel(kl('2026-10-08', '12:59'), KL)]
		]);
		expect(whenLabel(kl('2026-10-08', '12:59'), KL)).toMatch(/Thu,? 8 Oct, 12:59/);
		expect(summaryLines(r)).toContain('An account was blocked by a limit 1 time: Alpha.');
		expect(summaryLines(r).join(' ')).not.toMatch(/Not used/);
	});
	it('says so when no account was blocked', () => {
		const r = payload([s('2026-10-06', '09:00', 10), s('2026-10-06', '10:00', 30)]);
		expect(limitsOf(r)).toEqual([{ type: 'p', text: 'No account was blocked by a limit in this period.' }]);
		expect(summaryLines(r)).toContain('No account was blocked by a limit.');
	});
	it('a lower "limit reached" level in Settings never reads as blocked', () => {
		const r = payload([s('2026-10-06', '09:00', 50, 3 * 3600), s('2026-10-06', '09:30', 92, 3 * 3600 - 1800)], 90);
		expect(summaryLines(r)).toContain('No account was blocked by a limit.');
		expect(summaryLines(r)).toContain('An account reached 90% of a limit without being blocked 1 time.');
		const rows = (limitsOf(r).find((b) => b.type === 'table') as { rows: string[][] }).rows;
		expect(rows[0].slice(2)).toEqual(['Hourly session', 'not blocked (92%)', '-']);
	});
	it('a day with no readings still lists a limit that held during it', () => {
		const week = (date: string, hhmm: string, pct: number, resetIn: number): Sample => ({ ...s(date, hhmm, 0), weekPct: pct, weekReset: kl(date, hhmm) + resetIn });
		const r = payload([week('2026-10-07', '08:40', 95, 70 * 60), week('2026-10-07', '08:58', 100, 52 * 60)], 100, '2026-10-07');
		expect(r.hasData).toBe(false);
		expect(buildDoc(r, DOC, 'table', 'admin').sections.map((x) => x.title)).toEqual(['Summary', 'Limits Reached', 'Notes on the Figures']);
		expect((limitsOf(r).find((b) => b.type === 'table') as { rows: string[][] }).rows[0].slice(1, 3)).toEqual(['Alpha', 'Weekly session']);
		// with nothing to list, a day without readings says only that
		expect(buildDoc(payload([], 100, '2026-10-07'), DOC, 'table', 'admin').sections.map((x) => x.title)).toEqual(['Summary', 'Notes on the Figures']);
	});
	it('writes a long block in days', () => {
		expect(blockedLabel(45 * 60)).toBe('45 min');
		expect(blockedLabel(2 * 3600 + 15 * 60)).toBe('2 h 15 min');
		expect(blockedLabel(2 * 86_400 + 3 * 3600 + 59 * 60)).toBe('2 d 3 h');
		expect(blockedLabel(null)).toBe('not known');
	});
});

describe('slot rules', () => {
	it('refuses overlaps, allows gaps and a single all-day slot', () => {
		expect(slotsProblem(SLOTS)).toBeNull();
		expect(slotsProblem([{ name: '', from: 0, to: 0 }])).toBeNull();
		expect(slotsProblem([{ name: 'a', from: 540, to: 780 }, { name: 'b', from: 600, to: 840 }])).toMatch(/overlap/);
		expect(slotsProblem([{ name: 'a', from: 1320, to: 120 }, { name: 'b', from: 60, to: 180 }])).toMatch(/overlap/);
		expect(slotsProblem([])).toMatch(/at least one/);
		expect(slotsProblem(Array.from({ length: 13 }, (_, i) => ({ name: '', from: i * 60, to: i * 60 + 30 })))).toMatch(/12/);
	});
});

describe('spreadsheet download', () => {
	it('quotes commas and neutralises cells that would run as formulas', () => {
		const model = {
			title: '=HYPERLINK("http://evil.example")',
			period: 'Tuesday, 6 October 2026',
			sections: [{ title: 'Usage', blocks: [{ type: 'table', head: ['Account', 'Total'], rows: [['+cmd, inc', '45%'], ['@home', '-3'], ['plain', '10%'], ['Mon 5 Oct', '-']], caption: 'Table 1. Usage' }] }]
		} as unknown as DocModel;
		const lines = toCsv(model).replace(/^\uFEFF/, '').split('\r\n');
		expect(lines[0]).toBe(`"'=HYPERLINK(""http://evil.example"")"`);
		expect(lines).toContain(`"'+cmd, inc",45%`);
		expect(lines).toContain(`'@home,'-3`);
		expect(lines).toContain('plain,10%');
		// a dash on its own marks a day with no data: it is not a formula and is kept as typed
		expect(lines).toContain('Mon 5 Oct,-');
	});
});
