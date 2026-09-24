import { describe, expect, it } from 'vitest';
import { AMBER, DARK, GREEN, LIGHT, RED, buildTheme, mul, type CardTheme, type ThemeAccount } from '../../src/lib/server/theme';

type Layer = {
	id: string;
	render: string;
	width: string;
	background: { type: string; colour?: { color: string } };
	content: { type: string; template?: string; color?: { color: string } };
	mouse_events?: Record<string, string>;
};

const acc = (n: number): ThemeAccount[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `acct${i}` }));
function surface(t: Record<string, unknown>) {
	const s = (t.surfaces as Record<string, unknown>[])[0];
	return { s, kids: s.children as Layer[] };
}
/** Round-trips through JSON text exactly as it is written to disk. */
const roundTrip = (t: unknown) => JSON.parse(JSON.stringify(t, null, 2));

describe('buildTheme - dark (kit parity)', () => {
	it('0 accounts: valid small card that says no accounts yet', () => {
		const t = roundTrip(buildTheme([], 'dark'));
		const { s, kids } = surface(t);
		expect(t.id).toBe('multi-claude-accounts');
		expect(t.schema_version).toBe(1);
		expect(`${s.width}x${s.height}`).toBe('237x53');
		expect(kids.map((k) => k.id)).toEqual(['title', 'close-btn', 'no-accounts']);
		expect(kids[2].content.template).toBe('No accounts yet');
	});

	it('1 account: exactly the kit layer list, close button wired, bar expressions', () => {
		const { s, kids } = surface(roundTrip(buildTheme(acc(1), 'dark')));
		expect(`${s.width}x${s.height}`).toBe('237x70');
		expect((s.background as { colour: { color: string } }).colour.color).toBe(DARK.bg);
		expect(kids.map((k) => k.id)).toEqual([
			'title', 'close-btn', 'name-a0',
			'lab-a0-session', 'track1', 'bar2', 'bar3', 'bar4', 'val-a0-session',
			'lab-a0-weekly', 'track5', 'bar6', 'bar7', 'bar8', 'val-a0-weekly',
			'expired-a0'
		]);
		const close = kids.find((k) => k.id === 'close-btn')!;
		expect(close.mouse_events).toEqual({ click: 'show_context_menu("close-menu")' });
		const p = 'accounts.claude.a0.session.percentage';
		const bars = kids.filter((k) => k.id.startsWith('bar')).slice(0, 3);
		const live = '1 - accounts.claude.a0.login_required';
		expect(bars.map((b) => [b.background.colour!.color, b.render])).toEqual([
			[GREEN, `(${live}) * (${p} < 70)`],
			[AMBER, `(${live}) * ((${p} >= 70) * (${p} < 90))`],
			[RED, `(${live}) * (${p} >= 90)`]
		]);
		expect(bars[0].width).toBe(`max(1, 44 * clamp(${p}, 0, 100) / 100)`);
		expect(kids.find((k) => k.id === 'val-a0-session')!.content.template).toBe(
			`{${p}:0}% · {accounts.claude.a0.session.reset.seconds:duration}`
		);
	});

	it('4 accounts: one block per account, dividers between them', () => {
		const { s, kids } = surface(roundTrip(buildTheme(acc(4), 'dark')));
		expect(s.height).toBe(`${10 + 16 + 43 * 4 - 9 + 10}`);
		expect(kids.filter((k) => k.id.startsWith('name-')).map((k) => k.content.template)).toEqual(['acct0', 'acct1', 'acct2', 'acct3']);
		expect(kids.filter((k) => /^div\d+$/.test(k.id))).toHaveLength(3);
		expect(kids.filter((k) => /^bar\d+$/.test(k.id))).toHaveLength(4 * 2 * 3);
		expect(kids.filter((k) => k.id === 'close-btn')).toHaveLength(1);
	});
});

describe('buildTheme - card theme modes', () => {
	it('light: single variant with the light palette, same layer ids as dark', () => {
		const dark = surface(buildTheme(acc(2), 'dark'));
		const light = surface(buildTheme(acc(2), 'light'));
		expect(light.kids.map((k) => k.id)).toEqual(dark.kids.map((k) => k.id));
		expect((light.s.background as { colour: { color: string } }).colour.color).toBe(LIGHT.bg);
		expect(light.kids.find((k) => k.id === 'name-a0')!.content.color!.color).toBe(LIGHT.text);
		expect(light.kids.find((k) => k.id === 'track1')!.background.colour!.color).toBe(LIGHT.track);
		expect(light.kids.every((k) => !k.render.includes('system.dark'))).toBe(true);
	});

	it('auto: transparent surface, paired dark/light layers on system.dark, bars shared', () => {
		const { s, kids } = surface(buildTheme(acc(1), 'auto'));
		expect(s.background).toEqual({ type: 'none' });
		expect(kids.slice(0, 2).map((k) => [k.id, k.render, k.background.colour!.color])).toEqual([
			['bg-dark', 'system.dark', DARK.bg],
			['bg-light', '1 - system.dark', LIGHT.bg]
		]);
		// 2 bg + 2x(title, close, name, expired) + per window 2x(lab, track, val) + 3 shared bars
		expect(kids).toHaveLength(2 + 2 * 4 + 2 * (2 * 3 + 3));
		// alone, or gated as "(<login gate>) * (<variant>)"
		for (const k of kids.filter((x) => x.id.endsWith('-dark'))) expect(k.render).toMatch(/^(system\.dark|\(.+\) \* \(system\.dark\))$/);
		for (const k of kids.filter((x) => x.id.endsWith('-light'))) expect(k.render).toMatch(/^(1 - system\.dark|\(.+\) \* \(1 - system\.dark\))$/);
		expect(kids.filter((k) => k.id.endsWith('-dark'))).toHaveLength(kids.filter((k) => k.id.endsWith('-light')).length);
		expect(kids.filter((k) => /^bar\d+$/.test(k.id))).toHaveLength(6);
		expect(kids.find((k) => k.id === 'name-a0-light')!.content.color!.color).toBe(LIGHT.text);
		expect(kids.find((k) => k.id === 'close-btn-dark')!.mouse_events).toBeDefined();
		expect(new Set(kids.map((k) => k.id)).size).toBe(kids.length); // ids unique
	});

	it('auto with 0 and 4 accounts stays valid', () => {
		const zero = surface(roundTrip(buildTheme([], 'auto')));
		expect(zero.kids.map((k) => k.id)).toEqual(['bg-dark', 'bg-light', 'title-dark', 'close-btn-dark', 'title-light', 'close-btn-light', 'no-accounts-dark', 'no-accounts-light']);
		const four = surface(roundTrip(buildTheme(acc(4), 'auto')));
		expect(four.kids.filter((k) => /^div\d+-(dark|light)$/.test(k.id))).toHaveLength(6);
		expect(new Set(four.kids.map((k) => k.id)).size).toBe(four.kids.length);
	});
});

describe('buildTheme - login_required (expired login)', () => {
	const L = (id: string) => `accounts.claude.${id}.login_required`;
	const modes: [CardTheme, { suffix: string; render: string; alert: string }[]][] = [
		['dark', [{ suffix: '', render: '1', alert: DARK.alert }]],
		['light', [{ suffix: '', render: '1', alert: LIGHT.alert }]],
		[
			'auto',
			[
				{ suffix: '-dark', render: 'system.dark', alert: DARK.alert },
				{ suffix: '-light', render: '1 - system.dark', alert: LIGHT.alert }
			]
		]
	];
	for (const [mode, variants] of modes) {
		it(`${mode}: bar rows hide and "Expired" shows on accounts.claude.<id>.login_required`, () => {
			const { kids } = surface(roundTrip(buildTheme(acc(2), mode)));
			for (const id of ['a0', 'a1']) {
				const live = `1 - ${L(id)}`;
				// every layer of the two bar rows is gated by (1 - L): per variant lab+track+val per window, plus 6 shared bars
				const gated = kids.filter((k) => k.render.includes(L(id)) && !k.id.startsWith('expired-'));
				expect(gated).toHaveLength(variants.length * 2 * 3 + 6);
				for (const k of gated) expect(k.render === live || k.render.startsWith(`(${live}) * (`)).toBe(true);
				// one red "Expired" text per variant, rendered only when login_required
				const exp = kids.filter((k) => k.id.startsWith(`expired-${id}`));
				expect(exp.map((k) => [k.id, k.render, k.content.color!.color, k.content.template])).toEqual(
					variants.map((v) => [`expired-${id}${v.suffix}`, mul(L(id), v.render), v.alert, 'Expired · re-login'])
				);
				// name, title and dividers stay visible either way
				expect(kids.filter((k) => k.id.startsWith(`name-${id}`)).every((k) => !k.render.includes('login_required'))).toBe(true);
			}
			const tracks = kids.filter((k) => /^track1(-|$)/.test(k.id));
			expect(tracks.map((k) => k.render)).toEqual(variants.map((v) => mul(`1 - ${L('a0')}`, v.render)));
		});
	}

	it('mul keeps plain expressions readable', () => {
		expect(mul('1', 'x < 70')).toBe('x < 70');
		expect(mul('1 - a.login_required', '1')).toBe('1 - a.login_required');
		expect(mul('1 - a.login_required', 'system.dark')).toBe('(1 - a.login_required) * (system.dark)');
	});

	it('the expired text has AA contrast on its card background', () => {
		const lum = (hex: string) =>
			[1, 3, 5]
				.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
				.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
				.reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);
		const ratio = (a: string, b: string) => {
			const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
			return (x + 0.05) / (y + 0.05);
		};
		expect(ratio(DARK.alert, DARK.bg)).toBeGreaterThanOrEqual(4.5);
		expect(ratio(LIGHT.alert, LIGHT.bg)).toBeGreaterThanOrEqual(4.5);
	});

	it('ids in every expression are theme-safe', () => {
		const { kids } = surface(buildTheme([{ id: 'my_work', name: 'my-work!' }], 'auto'));
		for (const k of kids) for (const m of k.render.matchAll(/accounts\.claude\.([^.]+)\./g)) expect(m[1]).toMatch(/^[A-Za-z0-9_]+$/);
	});
});
