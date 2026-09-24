// Port of kit/UsageKit.psm1 Write-UsageTheme: one row per account, 5h + 7d bars.
// Same geometry, bar colours, layer ids and bindings, so the widget renders it identically.
// Card theme modes (meta.card_theme):
//   dark  -> exactly the kit's layout (dark card)
//   light -> same layout, light palette
//   auto  -> surface background "none" + paired layers: the dark variant renders on
//            `system.dark`, the light variant on `1 - system.dark` (as classic-usage-widget.json does).

export interface ThemeAccount {
	id: string;
	name: string;
}

export type CardTheme = 'auto' | 'light' | 'dark';
export const CARD_THEMES: CardTheme[] = ['auto', 'light', 'dark'];

type Json = Record<string, unknown>;

interface Palette {
	bg: string;
	text: string;
	muted: string;
	track: string;
	divider: string;
	/** "Expired" text: needs AA contrast on this palette's bg, so it differs per palette. */
	alert: string;
}

export const DARK: Palette = { bg: '#0D1117FF', text: '#FFFFFFFF', muted: '#C9D1D9FF', track: '#4A515BFF', divider: '#2D333BFF', alert: '#FF7B72FF' };
export const LIGHT: Palette = { bg: '#FFFFFFFF', text: '#1F2328FF', muted: '#59636EFF', track: '#D0D7DEFF', divider: '#D8DEE4FF', alert: '#CF222EFF' };

/** Render expressions multiply (the widget treats non-zero as visible); '1' is the identity. */
export function mul(a: string, b: string): string {
	if (a === '1') return b;
	if (b === '1') return a;
	return `(${a}) * (${b})`;
}
// Bars keep the widget's colours in every mode (they are not text).
export const GREEN = '#3FB950FF';
export const AMBER = '#D29922FF';
export const RED = '#F85149FF';

interface Variant {
	p: Palette;
	render: string; // render expression for themed layers
	suffix: string; // id suffix ('' when there is only one variant)
}

export function variantsFor(mode: CardTheme): Variant[] {
	if (mode === 'dark') return [{ p: DARK, render: '1', suffix: '' }];
	if (mode === 'light') return [{ p: LIGHT, render: '1', suffix: '' }];
	return [
		{ p: DARK, render: 'system.dark', suffix: '-dark' },
		{ p: LIGHT, render: '1 - system.dark', suffix: '-light' }
	];
}

function textLayer(
	id: string,
	x: number,
	y: number,
	w: number | string,
	h: number,
	template: string,
	size: number,
	color: string,
	weight: string,
	render = '1'
): Json {
	return {
		id,
		name: id,
		render,
		visibility: '100',
		x: `${x}`,
		y: `${y}`,
		width: `${w}`,
		height: `${h}`,
		background: { type: 'none' },
		border: null,
		corner_radius: '0',
		layout: 'freeform',
		align: 'start',
		gap: '0',
		content: {
			type: 'text',
			template,
			font_family: 'Segoe UI Variable Text',
			font_size: `${size}`,
			weight,
			rendering: 'antialiased',
			contrast: '1',
			align: 'left',
			color: { color, opacity: '1' }
		}
	};
}

function boxLayer(
	id: string,
	x: number,
	y: number,
	w: number | string,
	h: number,
	color: string,
	render: string,
	radius: number,
	opacity: string
): Json {
	return {
		id,
		name: id,
		render,
		visibility: '100',
		x: `${x}`,
		y: `${y}`,
		width: `${w}`,
		height: `${h}`,
		background: { type: 'colour', colour: { color, opacity } },
		border: null,
		corner_radius: `${radius}`,
		layout: 'freeform',
		align: 'start',
		gap: '0',
		content: { type: 'none' }
	};
}

/** Card opacity 0.85: see-through, but still readable over light windows. */
export function buildTheme(accounts: ThemeAccount[], mode: CardTheme = 'dark', opacity = 0.85): Json {
	const PAD = 10, TOP = 16, LINE = 17, GAP = 9, BW = 44, TW = 96;
	const LX = 67, BX = LX + 20, TX = BX + BW + 6;
	const W = TX + TW + PAD - 6;
	const BLOCK = 2 * LINE + GAP;
	const empty = accounts.length === 0;
	// Zero accounts: title + one line of text instead of the account blocks.
	const H = empty ? PAD + TOP + LINE + PAD : PAD + TOP + BLOCK * accounts.length - GAP + PAD;
	const DOT = '·';
	const vs = variantsFor(mode);
	const paired = vs.length > 1;

	const kids: Json[] = [];
	if (paired) {
		// The surface itself is transparent; these two layers are the card background.
		for (const v of vs) kids.push(boxLayer(`bg${v.suffix}`, 0, 0, W, H, v.p.bg, v.render, 10, `${opacity}`));
	}
	for (const v of vs) {
		kids.push(textLayer(`title${v.suffix}`, 10, 6, 150, 16, 'Claude usage', 11, v.p.muted, 'semibold', v.render));
		const close = textLayer(`close-btn${v.suffix}`, W - 26, 3, 20, 20, '✕', 12, v.p.muted, 'regular', v.render);
		(close.content as Json).align = 'center';
		close.mouse_events = { click: 'show_context_menu("close-menu")' };
		kids.push(close);
	}

	if (empty) {
		for (const v of vs)
			kids.push(textLayer(`no-accounts${v.suffix}`, PAD, PAD + TOP, W - 2 * PAD, LINE, 'No accounts yet', 11, v.p.text, 'medium', v.render));
	}

	let n = 0;
	accounts.forEach((a, i) => {
		const y0 = PAD + TOP + i * BLOCK;
		const b = `accounts.claude.${a.id}`;
		// The widget sets login_required = 1 when the account's login expired, was rejected or is missing.
		const L = `${b}.login_required`;
		const live = `1 - ${L}`;
		if (i > 0) {
			n++;
			for (const v of vs)
				kids.push(boxLayer(`div${n}${v.suffix}`, PAD, y0 - Math.floor(GAP / 2) - 1, W - 2 * PAD, 1, v.p.divider, v.render, 0, '0.6'));
		}
		for (const v of vs)
			kids.push(textLayer(`name-${a.id}${v.suffix}`, PAD, y0 + Math.floor(LINE / 2), 56, 18, a.name, 13, v.p.text, 'semibold', v.render));
		const rows: [string, string][] = [
			['5h', 'session'],
			['7d', 'weekly']
		];
		rows.forEach(([lab, win], j) => {
			const y = y0 + j * LINE;
			const p = `${b}.${win}.percentage`;
			for (const v of vs) kids.push(textLayer(`lab-${a.id}-${win}${v.suffix}`, LX, y, 20, LINE, lab, 11, v.p.muted, 'medium', mul(live, v.render)));
			n++;
			for (const v of vs) kids.push(boxLayer(`track${n}${v.suffix}`, BX, y + 6, BW, 6, v.p.track, mul(live, v.render), 3, '1'));
			const fw = `max(1, ${BW} * clamp(${p}, 0, 100) / 100)`;
			for (const [color, cond] of [
				[GREEN, `${p} < 70`],
				[AMBER, `(${p} >= 70) * (${p} < 90)`],
				[RED, `${p} >= 90`]
			]) {
				n++;
				kids.push(boxLayer(`bar${n}`, BX, y + 6, fw, 6, color, mul(live, cond), 3, '1'));
			}
			for (const v of vs)
				kids.push(
					textLayer(`val-${a.id}-${win}${v.suffix}`, TX, y, TW, LINE, `{${p}:0}% ${DOT} {${b}.${win}.reset.seconds:duration}`, 11, v.p.text, 'medium', mul(live, v.render))
				);
		});
		// In place of the two bar rows while the login needs renewing.
		for (const v of vs)
			kids.push(
				textLayer(`expired-${a.id}${v.suffix}`, LX, y0 + Math.floor(LINE / 2), W - LX - PAD, LINE, `Expired ${DOT} re-login`, 11, v.p.alert, 'semibold', mul(L, v.render))
			);
	});

	return {
		schema_version: 1,
		id: 'multi-claude-accounts',
		name: 'Claude accounts',
		surfaces: [
			{
				id: 'main',
				name: 'Claude accounts',
				render: '1',
				visibility: '100',
				placement: {
					reference: { region: 'system_tray', display: 0 },
					nest: 'floating',
					horizontal: 'right',
					vertical: 'top',
					surface_horizontal: 'right',
					surface_vertical: 'bottom',
					offset_x: 0,
					offset_y: -12
				},
				width: `${W}`,
				height: `${H}`,
				background: paired ? { type: 'none' } : { type: 'colour', colour: { color: vs[0].p.bg, opacity: `${opacity}` } },
				border: null,
				mouse_events: { double_click: 'show_dashboard()', right_click: 'show_context_menu("dashboard-v2")' },
				corner_radius: '10',
				layout: 'freeform',
				align: 'start',
				gap: '0',
				content: { type: 'none' },
				children: kids
			}
		]
	};
}
