import { describe, expect, it } from 'vitest';
import { AMBER, DARK, GREEN, LIGHT, RED, buildTheme, type ThemeAccount } from '../../src/lib/server/theme';

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
			'lab-a0-weekly', 'track5', 'bar6', 'bar7', 'bar8', 'val-a0-weekly'
		]);
		const close = kids.find((k) => k.id === 'close-btn')!;
		expect(close.mouse_events).toEqual({ click: 'show_context_menu("close-menu")' });
		const p = 'accounts.claude.a0.session.percentage';
		const bars = kids.filter((k) => k.id.startsWith('bar')).slice(0, 3);
		expect(bars.map((b) => [b.background.colour!.color, b.render])).toEqual([
			[GREEN, `${p} < 70`],
			[AMBER, `(${p} >= 70) * (${p} < 90)`],
			[RED, `${p} >= 90`]
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
		// 2 bg + 2x(title, close, name) + per window 2x(lab, track, val) + 3 shared bars
		expect(kids).toHaveLength(2 + 2 * 3 + 2 * (2 * 3 + 3));
		for (const k of kids.filter((x) => x.id.endsWith('-dark'))) expect(k.render).toBe('system.dark');
		for (const k of kids.filter((x) => x.id.endsWith('-light'))) expect(k.render).toBe('1 - system.dark');
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
