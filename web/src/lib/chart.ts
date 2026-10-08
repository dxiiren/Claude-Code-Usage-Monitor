// Bar charts as SVG text. The same drawing serves the page (colours from CSS variables) and the
// Word / PDF downloads (fixed print colours, turned into a picture), so the two cannot drift apart.

export interface Palette {
	text: string;
	muted: string;
	grid: string;
	series: string[];
	font: string;
}

/** On the page: follows the light / dark theme. */
export const PAGE_PALETTE: Palette = {
	text: 'var(--text)',
	muted: 'var(--muted)',
	grid: 'var(--border)',
	series: [1, 2, 3, 4, 5, 6].map((n) => `var(--series-${n})`),
	font: 'inherit'
};

/** In a document: always dark ink on white paper. */
export const PRINT_PALETTE: Palette = {
	text: '#1c1917',
	muted: '#57534e',
	grid: '#d6d3d1',
	series: ['#7e57c8', '#2f7fd0', '#1b8a7c', '#c8741f', '#bf3989', '#5c6b7a'],
	font: 'Arial, Helvetica, sans-serif'
};

/**
 * The palette has six colours. A seventh series takes the first colour again, drawn as an outline,
 * so that no two series on a chart look alike (up to twelve).
 */
export const isOutlined = (i: number, colours = 6) => Math.floor(i / colours) % 2 === 1;
const paint = (p: Palette, i: number) => {
	const c = p.series[i % p.series.length];
	return isOutlined(i, p.series.length) ? `fill="${c}" fill-opacity="0.28" stroke="${c}" stroke-width="1.5"` : `fill="${c}"`;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const n1 = (v: number) => v.toFixed(1);

/** A round axis top and step for values up to `max` (percentages). */
export function axis(max: number): { top: number; step: number } {
	const m = Math.max(max, 10) * 1.08;
	const step = m > 400 ? 200 : m > 200 ? 100 : m > 80 ? 50 : m > 40 ? 25 : 10;
	return { top: Math.ceil(m / step) * step, step };
}

function frame(W: number, H: number, L: number, R: number, T: number, B: number, top: number, step: number, p: Palette) {
	const ph = H - T - B;
	const y = (v: number) => T + ph - (v / top) * ph;
	let g = '';
	for (let v = 0; v <= top; v += step)
		g += `<line x1="${L}" x2="${W - R}" y1="${n1(y(v))}" y2="${n1(y(v))}" stroke="${p.grid}" stroke-width="1"/><text x="${L - 6}" y="${n1(y(v) + 4)}" text-anchor="end" fill="${p.muted}" font-size="11">${v}%</text>`;
	return { g, y };
}

const open = (W: number, H: number, p: Palette, label: string, minWidth: number) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}" font-family="${esc(p.font)}" style="width:100%;height:auto;min-width:${minWidth}px;display:block">`;

export interface Drawn {
	svg: string;
	width: number;
	height: number;
}

/**
 * One group of bars per time slot, one bar per account, value written on top.
 * `values[group][series]` in percent.
 */
export function groupedBars(o: {
	groups: { label: string; sub?: string }[];
	series: string[];
	values: number[][];
	palette: Palette;
	label: string;
	/** draw the names of the series under the chart (a document has no page around it to do that) */
	legend?: boolean;
}): Drawn {
	const W = 800;
	const PLOT = 306;
	const [L, R, T, B] = [46, 8, 18, 46];
	const p = o.palette;
	// the legend, laid out in rows before the height is known
	const keys: { x: number; row: number; name: string; si: number }[] = [];
	let rows = 0;
	if (o.legend && o.series.length > 1) {
		let x = L;
		rows = 1;
		o.series.forEach((name, si) => {
			const w = 16 + name.length * 6.6 + 18;
			if (x > L && x + w > W - R) {
				x = L;
				rows++;
			}
			keys.push({ x, row: rows - 1, name, si });
			x += w;
		});
	}
	const H = PLOT + (rows ? rows * 18 + 10 : 0);
	const { top, step } = axis(Math.max(0, ...o.values.flat()));
	const f = frame(W, PLOT, L, R, T, B, top, step, p);
	const cw = (W - L - R) / Math.max(1, o.groups.length);
	const n = Math.max(1, o.series.length);
	const bw = Math.min((cw * 0.8) / n, 56);
	const pad = (cw - bw * n) / 2;
	// value labels only while a bar is wide enough to carry one
	const showValues = bw >= 22;
	let g = f.g;
	o.groups.forEach((grp, gi) => {
		const x0 = L + gi * cw + pad;
		(o.values[gi] ?? []).forEach((v, si) => {
			const x = x0 + si * bw;
			const y = f.y(v);
			const w = Math.max(1, bw - 3);
			g += `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(Math.max(0, f.y(0) - y))}" rx="2" ${paint(p, si)}><title>${esc(o.series[si])}, ${esc(grp.label)}: ${Math.round(v)}%</title></rect>`;
			if (showValues) g += `<text x="${n1(x + w / 2)}" y="${n1(y - 4)}" text-anchor="middle" fill="${p.text}" font-size="11">${Math.round(v)}%</text>`;
		});
		const cx = n1(L + gi * cw + cw / 2);
		g += `<text x="${cx}" y="${PLOT - B + 17}" text-anchor="middle" fill="${p.text}" font-size="12" font-weight="600">${esc(grp.label)}</text>`;
		if (grp.sub) g += `<text x="${cx}" y="${PLOT - B + 32}" text-anchor="middle" fill="${p.muted}" font-size="11">${esc(grp.sub)}</text>`;
	});
	for (const k of keys) {
		const y = PLOT + 6 + k.row * 18;
		g += `<rect x="${n1(k.x)}" y="${y}" width="10" height="10" rx="2" ${paint(p, k.si)}/><text x="${n1(k.x + 16)}" y="${y + 9}" fill="${p.text}" font-size="11">${esc(k.name)}</text>`;
	}
	return { svg: `${open(W, H, p, o.label, Math.min(560, 140 * o.groups.length))}${g}</svg>`, width: W, height: H };
}

/** One column per day; `null` = no data that day (drawn as a dash). */
export function columns(o: { labels: string[]; values: (number | null)[]; palette: Palette; label: string }): Drawn {
	const W = 800;
	const H = 240;
	const [L, R, T, B] = [46, 8, 18, 30];
	const p = o.palette;
	const n = Math.max(1, o.labels.length);
	const { top, step } = axis(Math.max(0, ...o.values.map((v) => v ?? 0)));
	const f = frame(W, H, L, R, T, B, top, step, p);
	const cw = (W - L - R) / n;
	const every = n <= 10 ? 1 : 3;
	let g = f.g;
	o.labels.forEach((lab, k) => {
		const x = L + k * cw;
		const v = o.values[k];
		if (v === null) g += `<text x="${n1(x + cw / 2)}" y="${n1(f.y(0) - 6)}" text-anchor="middle" fill="${p.muted}" font-size="11">–</text>`;
		else {
			const y = f.y(v);
			const w = Math.min(cw * 0.64, 56);
			g += `<rect x="${n1(x + (cw - w) / 2)}" y="${n1(y)}" width="${n1(w)}" height="${n1(Math.max(0, f.y(0) - y))}" rx="2" fill="${p.series[0]}"><title>${esc(lab)}: ${Math.round(v)}%</title></rect>`;
			if (n <= 10) g += `<text x="${n1(x + cw / 2)}" y="${n1(y - 4)}" text-anchor="middle" fill="${p.text}" font-size="11">${Math.round(v)}%</text>`;
		}
		if (k % every === 0) g += `<text x="${n1(x + cw / 2)}" y="${H - 9}" text-anchor="middle" fill="${p.muted}" font-size="11">${esc(lab)}</text>`;
	});
	return { svg: `${open(W, H, p, o.label, n <= 10 ? 320 : 520)}${g}</svg>`, width: W, height: H };
}

/** Browser only: an SVG drawn with fixed colours -> PNG data URL (for Word and PDF). */
export async function svgToPng(d: Drawn, scale = 2): Promise<string> {
	const img = new Image();
	const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.svg)}`;
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error('Could not draw the chart for the document.'));
		img.src = url;
	});
	const canvas = document.createElement('canvas');
	canvas.width = d.width * scale;
	canvas.height = d.height * scale;
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL('image/png');
}
