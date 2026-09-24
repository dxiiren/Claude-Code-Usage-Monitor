import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { level, resetsIn } from '../../src/lib/format';

describe('level thresholds (same as the widget)', () => {
	it('green < 70, amber 70-89, red >= 90, full at 100', () => {
		expect([0, 69.9, 70, 89.9, 90, 99.9, 100, 120].map(level)).toEqual(['ok', 'ok', 'warn', 'warn', 'high', 'high', 'full', 'full']);
		expect(level(null)).toBe('none');
	});
	it('resetsIn formats like kit Format-Reset, optional seconds', () => {
		const now = 1_000_000_000_000;
		const s = now / 1000;
		expect(resetsIn(s + 2 * 86400 + 3 * 3600, now)).toBe('2d 3h');
		expect(resetsIn(s + 3 * 3600 + 5 * 60, now)).toBe('3h 5m');
		expect(resetsIn(s + 125, now)).toBe('2m');
		expect(resetsIn(s + 125, now, true)).toBe('2m 05s');
		expect(resetsIn(s - 1, now)).toBe('now');
		expect(resetsIn(null, now)).toBe('-');
	});
});

// WCAG AA contrast for the text pairs the pages actually use, in both themes.
function lum(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
};
function tokens(block: string): Record<string, string> {
	return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

describe('colour tokens meet WCAG AA', () => {
	const css = fs.readFileSync(path.join(__dirname, '../../src/app.css'), 'utf8');
	const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media')));
	const darkBlock = css.slice(css.indexOf(":root[data-theme='dark']"));
	const dark = tokens(darkBlock.slice(0, darkBlock.indexOf('}')));
	const mediaDark = tokens(css.slice(css.indexOf('@media'), css.indexOf(":root[data-theme='dark']")));

	it('the forced-dark and OS-dark blocks define the same colours', () => {
		expect(mediaDark).toEqual(dark);
	});

	const pairs: [string, string][] = [
		['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'],
		['accent-text', 'accent'], ['red', 'surface'], ['tag-text', 'green'], ['tag-text', 'red'], ['tag-text', 'muted'],
		['card-text', 'card-bg'], ['card-muted', 'card-bg'], ['card-red', 'card-bg'], ['card-amber', 'card-bg'],
		['card-link', 'card-bg'], ['card-pill-text', 'card-red'], ['card-text', 'card-track']
	];
	for (const [name, t] of [['light', light], ['dark', dark]] as const) {
		it(`${name}: every text pair >= 4.5:1`, () => {
			const failing = pairs
				.map(([fg, bg]) => ({ fg, bg, r: ratio(t[fg], t[bg]) }))
				.filter((p) => !(p.r >= 4.5));
			expect(failing).toEqual([]);
			expect(ratio('#ffffff', t['danger-solid'])).toBeGreaterThanOrEqual(4.5);
		});
	}
});
