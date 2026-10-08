import { describe, expect, it } from 'vitest';
import { headline, headlines, type HeadAccount } from '../../src/lib/headline';
import { resetsIn } from '../../src/lib/format';

const NOW = 1_790_000_000_000;
const S = NOW / 1000;
type Usage = NonNullable<HeadAccount['usage']>;
const win = (percentage: number, resetsIn = 3600) => ({ percentage, resetsAt: S + resetsIn });
const usage = (session: number | null, weekly: number | null, over: Partial<Usage> = {}): Usage => ({
	session: session === null ? null : win(session),
	weekly: weekly === null ? null : win(weekly, 3 * 86_400),
	models: [],
	extra: null,
	...over
});
const acc = (name: string, u: Usage | null, over: Partial<HeadAccount> & { old?: boolean } = {}): HeadAccount & { old?: boolean } => ({
	id: name.toLowerCase(),
	name,
	provider: 'claude',
	enabled: true,
	email: `${name}@example.com`,
	status: { state: 'ok' },
	usage: u,
	...over
});
const head = (list: (HeadAccount & { old?: boolean })[]) => headline(list, NOW, (a) => !!a.old);

describe('the Usage headline', () => {
	it('names the account whose tighter window has most room, not just the emptier 5-hour one', () => {
		const h = head([acc('A', usage(5, 99)), acc('B', usage(20, 5))]);
		expect(h).toMatchObject({ kind: 'best', account: { name: 'B' } });
		// a plan with the weekly window only is judged by that window, not counted as unused
		expect(head([acc('A', usage(null, 85)), acc('B', usage(10, 20))])).toMatchObject({ kind: 'best', account: { name: 'B' } });
	});
	it('a window that has reset since it was read counts as empty', () => {
		const reset = usage(90, 10);
		reset.session = { percentage: 90, resetsAt: S - 60 };
		expect(head([acc('A', reset), acc('B', usage(30, 30))])).toMatchObject({ kind: 'best', account: { name: 'A' } });
	});
	it('an account with every limit free comes before one that is out of a model', () => {
		const opusOut = usage(5, 5, { models: [{ label: 'Opus', ...win(100) }] });
		expect(head([acc('A', opusOut), acc('B', usage(60, 60))])).toMatchObject({ kind: 'best', account: { name: 'B' } });
		// ... but it is still the best when it is the only one under its limits
		expect(head([acc('A', opusOut), acc('B', usage(100, 60))])).toMatchObject({ kind: 'best', account: { name: 'A' } });
	});
	it('never names a hidden account, an old reading, or one that needs a login', () => {
		const list = [
			acc('Hidden', usage(1, 1), { enabled: false }),
			acc('Old', usage(2, 2), { old: true }),
			acc('Expired', usage(3, 3), { status: { state: 'expired' } }),
			acc('Fine', usage(70, 70))
		];
		expect(head(list)).toMatchObject({ kind: 'best', account: { name: 'Fine' } });
	});
	it('says "all at their limit" only when that is known of every account shown', () => {
		const blocked = acc('A', usage(100, 40));
		expect(head([blocked, acc('B', usage(20, 100))])).toEqual({ kind: 'blocked', blocked: 2, unknown: 0, nextFree: S + 3600 });
		// B may be fine: its reading is old, so "all" would be a guess
		expect(head([blocked, acc('B', usage(10, 10), { old: true })])).toMatchObject({ kind: 'blocked', blocked: 1, unknown: 1 });
		expect(head([blocked, acc('B', null, { status: { state: 'expired' } })])).toMatchObject({ kind: 'blocked', blocked: 1, unknown: 1 });
		// a hidden account is not part of the question
		expect(head([blocked, acc('B', usage(10, 10), { enabled: false })])).toMatchObject({ kind: 'blocked', blocked: 1, unknown: 0 });
	});
	it('an account that still works on paid extra usage is not "at its limit" news', () => {
		const paid = acc('A', usage(100, 40, { extra: { remaining: 12 } }));
		expect(head([paid])).toMatchObject({ kind: 'extra', accounts: [{ name: 'A' }] });
		expect(head([paid, acc('B', usage(100, 100))])).toMatchObject({ kind: 'extra', accounts: [{ name: 'A' }] });
		// used up: blocked like any other
		expect(head([acc('A', usage(100, 40, { extra: { remaining: 0 } }))])).toMatchObject({ kind: 'blocked', blocked: 1 });
		// with a free account around, that one is the news
		expect(head([paid, acc('B', usage(50, 50))])).toMatchObject({ kind: 'best', account: { name: 'B' } });
	});
	it('with nothing to go by it says why, and never "not polled yet" when it was', () => {
		expect(head([acc('A', usage(10, 10), { old: true })])).toEqual({ kind: 'old' });
		expect(head([acc('A', usage(10, 10), { enabled: false })])).toEqual({ kind: 'none', why: 'hidden' });
		expect(head([acc('A', null, { status: { state: 'expired' } }), acc('B', null, { email: null, status: { state: 'logged_out' } })])).toEqual({ kind: 'none', why: 'login' });
		expect(head([acc('A', null, { status: { state: 'error' } })])).toEqual({ kind: 'none', why: 'failed' });
		expect(head([acc('A', null)])).toEqual({ kind: 'none', why: 'unread' });
	});
	it('Claude and Codex each get their own line: one cannot stand in for the other', () => {
		const list = [acc('C', usage(100, 50)), acc('X', usage(10, 10), { provider: 'codex' })];
		const out = headlines(list, NOW, () => false);
		expect(out.map((h) => [h.provider, h.head.kind])).toEqual([
			['claude', 'blocked'],
			['codex', 'best']
		]);
		expect(headlines([acc('C', usage(1, 1))], NOW, () => false)).toHaveLength(1);
	});
});

describe('reset wording', () => {
	it('under a minute without seconds is not "0m"', () => {
		expect(resetsIn(S + 30, NOW)).toBe('under 1m');
		expect(resetsIn(S + 30, NOW, true)).toBe('0m 30s');
		expect(resetsIn(S + 90, NOW)).toBe('1m');
	});
});
