import { describe, expect, it } from 'vitest';
import { buildReport, increments, limitHits, periodDates, reportDateOf, slotWindows, wallToUnix, type ReportAccount, type Sample } from '../../src/lib/server/report';
import { slotsProblem, uncoveredMinutes, type Slot } from '../../src/lib/slots';
import { toCsv, type DocModel } from '../../src/lib/reportDoc';

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
		expect(report(day, { slots: gap }).accounts[0].slots).toEqual([62]);
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
	});
	it('lists each time a limit was reached, with how long it stayed blocked', () => {
		const r = report([s('2026-10-06', '09:00', 80), s('2026-10-06', '09:30', 100, 2 * 3600), s('2026-10-06', '09:35', 100, 2 * 3600 - 300)]);
		expect(r.hits).toEqual([{ ts: kl('2026-10-06', '09:30'), pct: 100, blockedSeconds: 7200, accountId: 'a', account: 'Alpha' }]);
		expect(limitHits([{ ts: 1, pct: 100, reset: null }], 100)).toEqual([]);
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
			sections: [{ title: 'Usage', blocks: [{ type: 'table', head: ['Account', 'Total'], rows: [['+cmd, inc', '45%'], ['@home', '-3'], ['plain', '10%']], caption: 'Table 1. Usage' }] }]
		} as unknown as DocModel;
		const lines = toCsv(model).replace(/^\uFEFF/, '').split('\r\n');
		expect(lines[0]).toBe(`"'=HYPERLINK(""http://evil.example"")"`);
		expect(lines).toContain(`"'+cmd, inc",45%`);
		expect(lines).toContain(`'@home,'-3`);
		expect(lines).toContain('plain,10%');
	});
});
