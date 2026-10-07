import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ago, level, pctText, readingOver, refreshSummary, resetsIn, windowFull, windowOver } from '../../src/lib/format';

describe('level thresholds (same as the widget)', () => {
	it('green < 70, amber 70-89, red >= 90, full at 100', () => {
		expect([0, 69.9, 70, 89.9, 90, 99.9, 100, 120].map((p) => level(p))).toEqual(['ok', 'ok', 'warn', 'warn', 'high', 'high', 'full', 'full']);
		expect(level(null)).toBe('none');
	});
	it('the amber and red levels can be moved (Settings); 100 always means blocked', () => {
		expect([49, 50, 79, 80, 100].map((p) => level(p, 50, 80))).toEqual(['ok', 'warn', 'warn', 'high', 'full']);
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
	it('only a real 100 reads "100%"', () => {
		expect([0, 12.4, 99.4, 99.6, 99.99, 100, 100.4, 137].map((p) => pctText(p))).toEqual(['0%', '12%', '99%', '99%', '99%', '100%', '100%', '137%']);
		expect(pctText(null)).toBe('--');
	});
	it('a window stops counting once its reset time has passed', () => {
		const now = 1_000_000_000_000;
		const s = now / 1000;
		expect(windowOver(s - 1, now)).toBe(true);
		expect(windowOver(s + 60, now)).toBe(false);
		expect(windowOver(null, now)).toBe(false);
		expect(windowFull({ percentage: 100, resetsAt: s + 60 }, now)).toBe(true);
		expect(windowFull({ percentage: 100, resetsAt: null }, now)).toBe(true);
		// the limit that was reached has reset: the account is free until a new reading says otherwise
		expect(windowFull({ percentage: 100, resetsAt: s - 60 }, now)).toBe(false);
		expect(windowFull({ percentage: 99.6, resetsAt: s + 60 }, now)).toBe(false);
		expect(windowFull(null, now)).toBe(false);
	});
	it('a number read before the window reset is not quoted as the current one', () => {
		const now = 1_000_000_000_000;
		const s = now / 1000;
		expect(readingOver(100, s - 60, now)).toBe(true);
		expect(readingOver(100, s + 60, now)).toBe(false);
		// an unused window says nothing false at 0%, so it is left as it is
		expect(readingOver(0, s - 60, now)).toBe(false);
		expect(readingOver(null, s - 60, now)).toBe(false);
		expect(readingOver(40, null, now)).toBe(false);
	});
	it('says how old a reading is', () => {
		const now = 1_000_000_000_000;
		const s = now / 1000;
		expect([20, 240, 3 * 3600 + 300, 2 * 86400 + 4 * 3600].map((d) => ago(s - d, now))).toEqual(['1m', '4m', '3h 5m', '2d 4h']);
	});
	it('"Refresh now" reports what really happened', () => {
		expect(refreshSummary({ refreshed: 1, failed: 0, pending: 0, skipped: 0 })).toEqual({ ok: true, text: 'Refreshed 1 account.' });
		expect(refreshSummary({ refreshed: 4, failed: 2, pending: 0, skipped: 0 })).toEqual({ ok: false, text: 'Refreshed 4 accounts. 2 accounts could not be read: the reason is on their row.' });
		expect(refreshSummary({ refreshed: 0, failed: 6, pending: 0, skipped: 0 }).text).not.toMatch(/Refreshed/);
		expect(refreshSummary({ refreshed: 5, failed: 0, pending: 1, skipped: 0 })).toMatchObject({ ok: false, text: expect.stringContaining('1 account still being read') });
		expect(refreshSummary({ refreshed: 2, failed: 0, pending: 0, skipped: 1 })).toEqual({ ok: true, text: 'Refreshed 2 accounts. 1 skipped: the provider asked us to wait.' });
		expect(refreshSummary({ refreshed: 0, failed: 0, pending: 0, skipped: 3 })).toEqual({ ok: false, text: 'Nothing refreshed: the provider asked us to wait before reading again.' });
		expect(refreshSummary({ refreshed: 0, failed: 0, pending: 0, skipped: 0 })).toEqual({ ok: false, text: 'Nothing to refresh: no account is switched on.' });
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
		['card-link', 'card-bg'], ['card-pill-text', 'card-red'], ['card-text', 'card-track'],
		// login-needed notice + badge + Usage-page Re-login button
		['text', 'err-bg'], ['card-muted', 'card-bg'],
		// the small "Codex" provider tag (Accounts + Usage pages)
		['codex-text', 'codex-bg'], ['codex-text', 'surface'], ['codex-text', 'card-bg'],
		// side menu, zebra tables, notices and coloured figures on the Report, Settings and Users screens
		['text', 'soft'], ['muted', 'soft'], ['text', 'zebra'], ['muted', 'zebra'], ['card-link', 'surface'], ['card-link', 'soft'],
		['green', 'surface'], ['amber', 'surface'], ['text', 'warn-bg'], ['text', 'ok-bg']
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
