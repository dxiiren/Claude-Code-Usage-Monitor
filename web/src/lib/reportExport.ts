// Browser only: turns the report model into a Word file, a PDF or a CSV and hands it to the user.
// The Word and PDF libraries are large, so they load only when a download is asked for.
import { svgToPng } from './chart';
import { BRAND } from './brand';
import { toCsv, type Block, type DocModel } from './reportDoc';

const LOGO_URL = BRAND.logo;
const LOGO_RATIO = BRAND.logoRatio;

function save(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function logoBytes(): Promise<Uint8Array | null> {
	if (!LOGO_URL) return null;
	try {
		const res = await fetch(LOGO_URL);
		return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
	} catch {
		return null;
	}
}

const dataUrlBytes = (url: string): Uint8Array => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
const bytesDataUrl = (b: Uint8Array): string => {
	let s = '';
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return `data:image/png;base64,${btoa(s)}`;
};

/** Every figure of the model as a PNG data URL, in order. */
async function figures(m: DocModel): Promise<Map<Block, string>> {
	const out = new Map<Block, string>();
	for (const s of m.sections) for (const b of s.blocks) if (b.type === 'figure') out.set(b, await svgToPng(b.chart));
	return out;
}

export function downloadCsv(m: DocModel): void {
	save(new Blob([toCsv(m)], { type: 'text/csv;charset=utf-8' }), `${m.fileStem}.csv`);
}

// ---------- Word ----------

export async function downloadDocx(m: DocModel): Promise<void> {
	const d = await import('docx');
	const [pngs, logo] = await Promise.all([figures(m), m.logo ? logoBytes() : Promise.resolve(null)]);
	const FONT = 'Arial';
	const pt = (n: number) => n * 2; // docx sizes are half-points
	const run = (text: string, o: { bold?: boolean; size?: number; italics?: boolean } = {}) => new d.TextRun({ text, font: FONT, size: pt(o.size ?? 11), bold: o.bold, italics: o.italics });
	const para = (text: string, o: { bold?: boolean; size?: number; align?: 'center' | 'left' | 'both'; before?: number; after?: number } = {}) =>
		new d.Paragraph({
			alignment: o.align === 'center' ? d.AlignmentType.CENTER : o.align === 'both' ? d.AlignmentType.JUSTIFIED : d.AlignmentType.LEFT,
			spacing: { before: o.before ?? 0, after: o.after ?? 120 },
			children: [run(text, o)]
		});
	const logoRun = (widthPx: number) =>
		logo ? [new d.ImageRun({ type: 'png', data: logo, transformation: { width: widthPx, height: Math.round(widthPx * LOGO_RATIO) } })] : [];
	/** Company name in bold, then website and e-mail: only the ones that are set. */
	const contactParas = () => m.contact.map((t, i) => para(t, { bold: i === 0 && t === m.company, align: 'center', after: 40 }));
	const line = { style: d.BorderStyle.SINGLE, size: 4, color: '000000' };
	const none = { style: d.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
	const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };

	const header = new d.Header({
		children: [
			new d.Table({
				width: { size: 100, type: d.WidthType.PERCENTAGE },
				borders: { ...noBorders, bottom: line },
				rows: [
					new d.TableRow({
						children: [
							new d.TableCell({ borders: noBorders, width: { size: 30, type: d.WidthType.PERCENTAGE }, children: [new d.Paragraph({ children: logoRun(90) })] }),
							new d.TableCell({ borders: noBorders, width: { size: 40, type: d.WidthType.PERCENTAGE }, children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [run(m.title, { size: 9 })] })] }),
							new d.TableCell({ borders: noBorders, width: { size: 30, type: d.WidthType.PERCENTAGE }, children: [new d.Paragraph({ alignment: d.AlignmentType.RIGHT, children: [run('Internal', { size: 9 })] })] })
						]
					})
				]
			}),
			new d.Paragraph({ children: [] })
		]
	});
	const footer = new d.Footer({
		children: [
			new d.Paragraph({
				border: { top: { ...line, space: 4 } },
				tabStops: [
					{ type: d.TabStopType.CENTER, position: 4870 },
					{ type: d.TabStopType.RIGHT, position: 9740 }
				],
				children: [
					run(m.monthYear, { size: 7 }),
					run(`\t${m.footer}`, { size: 7 }),
					new d.TextRun({ font: FONT, size: pt(7), children: ['\tPage ', d.PageNumber.CURRENT, ' of ', d.PageNumber.TOTAL_PAGES] })
				]
			})
		]
	});

	const cell = (text: string, o: { bold?: boolean; align?: 'center' | 'right' | 'left' } = {}) =>
		new d.TableCell({
			margins: { top: 60, bottom: 60, left: 90, right: 90 },
			verticalAlign: d.VerticalAlign.CENTER,
			children: [
				new d.Paragraph({
					alignment: o.align === 'center' ? d.AlignmentType.CENTER : o.align === 'right' ? d.AlignmentType.RIGHT : d.AlignmentType.LEFT,
					children: [run(text, { size: 9, bold: o.bold })]
				})
			]
		});
	const body: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [];
	m.sections.forEach((s, i) => {
		body.push(new d.Paragraph({ heading: d.HeadingLevel.HEADING_1, keepNext: true, spacing: { before: 280, after: 140 }, children: [run(`${i + 1} ${s.title}`, { bold: true, size: 16 })] }));
		for (const b of s.blocks) {
			if (b.type === 'p') body.push(para(b.text, { align: 'both' }));
			else if (b.type === 'bullets') for (const item of b.items) body.push(new d.Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [run(item)] }));
			else if (b.type === 'figure') {
				const w = 600;
				body.push(
					new d.Paragraph({
						alignment: d.AlignmentType.CENTER,
						// stays on the page of its caption
						keepNext: true,
						spacing: { before: 120, after: 60 },
						children: [new d.ImageRun({ type: 'png', data: dataUrlBytes(pngs.get(b)!), transformation: { width: w, height: Math.round((w * b.chart.height) / b.chart.width) } })]
					})
				);
				body.push(para(b.caption, { bold: true, size: 10, align: 'center', after: 200 }));
			} else {
				body.push(
					new d.Table({
						width: { size: 100, type: d.WidthType.PERCENTAGE },
						borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
						rows: [
							new d.TableRow({ tableHeader: true, cantSplit: true, children: b.head.map((h) => cell(h, { bold: true, align: 'center' })) }),
							...b.rows.map(
								(r, ri) => new d.TableRow({ cantSplit: true, children: r.map((v, ci) => cell(v, { bold: !!b.totalRow && ri === b.rows.length - 1, align: ci === 0 ? 'left' : 'right' })) })
							)
						]
					})
				);
				body.push(para(b.caption, { bold: true, size: 10, align: 'center', before: 80, after: 200 }));
			}
		}
	});

	const pageProps = { page: { size: { width: 11909, height: 16834 }, margin: { top: 1100, right: 720, bottom: 900, left: 1440, header: 500, footer: 500 } } };
	const sections = [];
	if (m.cover)
		sections.push({
			properties: pageProps,
			footers: { default: footer },
			children: [
				para(m.coverLabel, { bold: true, size: 14, align: 'center', before: 1400, after: 600 }),
				para(m.title, { bold: true, size: 26, align: 'center', after: 200 }),
				para(m.period, { bold: true, size: 18, align: 'center', after: 400 }),
				para(m.subtitle, { bold: true, size: 14, align: 'center', after: 400 }),
				...(m.contact.length || logo ? [para('By', { bold: true, size: 14, align: 'center', after: 300 })] : []),
				new d.Paragraph({ alignment: d.AlignmentType.CENTER, spacing: { after: 200 }, children: logoRun(220) }),
				...contactParas(),
				para('', { after: 1300 }),
				para(`Prepared by: ${m.preparedBy}`, { after: 40 }),
				para(`Generated: ${m.generated}`, { after: 40 }),
				para(m.monthYear)
			]
		});
	if (m.contents)
		sections.push({
			properties: pageProps,
			headers: { default: header },
			footers: { default: footer },
			children: [
				para(m.footer ? m.footer.toUpperCase() : 'NOTICE', { bold: true, size: 16, align: 'center', after: 200 }),
				...(m.notice
					? [
							new d.Table({
								width: { size: 100, type: d.WidthType.PERCENTAGE },
								borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: none, insideVertical: none },
								rows: [
									new d.TableRow({
										children: [new d.TableCell({ margins: { top: 140, bottom: 140, left: 160, right: 160 }, children: [para(m.notice, { size: 9, align: 'both', after: 0 })] })]
									})
								]
							})
						]
					: []),
				para('', { after: 200 }),
				...contactParas(),
				para('', { after: 400 }),
				para('TABLE OF CONTENTS', { bold: true, size: 16, after: 200 }),
				new d.TableOfContents('Table of contents', { hyperlink: true, headingStyleRange: '1-1' })
			]
		});
	sections.push({ properties: pageProps, headers: { default: header }, footers: { default: footer }, children: body });

	const file = new d.Document({
		creator: m.preparedBy,
		title: m.title,
		description: m.period,
		// Word fills in the table of contents and its page numbers when the file is opened.
		features: { updateFields: m.contents },
		styles: { default: { document: { run: { font: FONT, size: pt(11) } }, heading1: { run: { font: FONT, size: pt(16), bold: true, color: '000000' } } } },
		sections
	});
	save(await d.Packer.toBlob(file), `${m.fileStem}.docx`);
}

// ---------- PDF ----------

export async function downloadPdf(m: DocModel): Promise<void> {
	const [{ default: pdfMake }, fonts] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
	// The bundled fonts file registers itself when pdfMake is a global; as a module we hand it over.
	const vfs = (fonts as { default?: unknown }).default ?? fonts;
	const pm = pdfMake as unknown as { addVirtualFileSystem?: (v: unknown) => void; vfs?: unknown; createPdf: (def: unknown) => { getBlob: (cb?: (b: Blob) => void) => Promise<Blob> | void } };
	if (pm.addVirtualFileSystem) pm.addVirtualFileSystem(vfs);
	else pm.vfs = vfs;

	const [pngs, logoRaw] = await Promise.all([figures(m), m.logo ? logoBytes() : Promise.resolve(null)]);
	const logo = logoRaw ? bytesDataUrl(logoRaw) : null;
	const contentWidth = 595.28 - 72 - 36;
	const rule = (y: number) => ({ canvas: [{ type: 'line', x1: 0, y1: y, x2: contentWidth, y2: y, lineWidth: 0.6 }] });
	/** Marks a node of the page header or footer (see pageBreakBefore below). */
	const furniture = <T extends object>(node: T) => ({ ...node, style: 'furniture' });
	const content: unknown[] = [];
	const contact = m.contact.map((t, i) => ({ text: t, bold: i === 0 && t === m.company, alignment: 'center' }));

	if (m.cover) {
		content.push(
			{ text: m.coverLabel, style: 'c1', margin: [0, 90, 0, 40] },
			{ text: m.title, style: 'ctitle', margin: [0, 0, 0, 10] },
			{ text: m.period, style: 'c2', margin: [0, 0, 0, 26] },
			{ text: m.subtitle, style: 'c1', margin: [0, 0, 0, 26] },
			...(m.contact.length || logo ? [{ text: 'By', style: 'c1', margin: [0, 0, 0, 16] }] : []),
			...(logo ? [{ image: logo, width: 170, alignment: 'center', margin: [0, 0, 0, 12] }] : []),
			...contact,
			{ text: '', margin: [0, 0, 0, 110] },
			{ text: `Prepared by: ${m.preparedBy}` },
			{ text: `Generated: ${m.generated}` },
			{ text: m.monthYear, pageBreak: 'after' }
		);
	}
	if (m.contents) {
		content.push({ text: m.footer ? m.footer.toUpperCase() : 'NOTICE', style: 'chead', alignment: 'center', margin: [0, 6, 0, 10] });
		if (m.notice) content.push({ table: { widths: ['*'], body: [[{ text: m.notice, fontSize: 9, alignment: 'justify', margin: [6, 6, 6, 6] }]] } });
		content.push(
			{ text: '', margin: [0, 18, 0, 0] },
			...contact,
			{ text: '', margin: [0, 0, 0, 26] },
			{ toc: { title: { text: 'TABLE OF CONTENTS', style: 'chead', margin: [0, 0, 0, 8] } }, pageBreak: 'after' }
		);
	}
	m.sections.forEach((s, i) => {
		content.push({ text: `${i + 1}    ${s.title}`, style: 'h1', headlineLevel: 1, tocItem: m.contents, margin: [0, i ? 16 : 0, 0, 8] });
		for (const b of s.blocks) {
			if (b.type === 'p') content.push({ text: b.text, alignment: 'justify', margin: [0, 0, 0, 6] });
			else if (b.type === 'bullets') content.push({ ul: b.items, margin: [0, 0, 0, 6] });
			else if (b.type === 'figure')
				content.push({ image: pngs.get(b), width: contentWidth, alignment: 'center', headlineLevel: 2, margin: [0, 6, 0, 3] }, { text: b.caption, style: 'cap', margin: [0, 0, 0, 10] });
			else
				content.push(
					{
						table: {
							headerRows: 1,
							dontBreakRows: true,
							widths: b.head.map((_, ci) => (ci === 0 ? '*' : 'auto')),
							body: [
								b.head.map((h) => ({ text: h, bold: true, alignment: 'center', fontSize: 9 })),
								...b.rows.map((r, ri) => r.map((v, ci) => ({ text: v, fontSize: 9, bold: !!b.totalRow && ri === b.rows.length - 1, alignment: ci === 0 ? 'left' : 'right' })))
							]
						},
						layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6 }
					},
					{ text: b.caption, style: 'cap', margin: [0, 4, 0, 10] }
				);
		}
	});

	const def = {
		pageSize: 'A4',
		// A section heading (level 1) or a figure (level 2) never ends a page on its own: it moves
		// to the next page together with what follows it. The page header and footer are laid out
		// after the content and so always "follow" it; they are told apart by their style.
		pageBreakBefore: (node: { headlineLevel?: number }, on: { getFollowingNodesOnPage: () => { style?: unknown }[] }) =>
			(node.headlineLevel === 1 || node.headlineLevel === 2) && on.getFollowingNodesOnPage().every((n) => n.style === 'furniture'),
		pageMargins: [72, 62, 36, 50],
		info: { title: m.title, author: m.preparedBy, subject: m.period },
		defaultStyle: { fontSize: 11, lineHeight: 1.2 },
		styles: {
			c1: { fontSize: 14, bold: true, alignment: 'center' },
			c2: { fontSize: 18, bold: true, alignment: 'center' },
			ctitle: { fontSize: 26, bold: true, alignment: 'center' },
			chead: { fontSize: 14, bold: true },
			h1: { fontSize: 14, bold: true },
			cap: { fontSize: 10, bold: true, alignment: 'center' },
			// changes nothing in the look: it only marks the nodes of the page header and footer
			furniture: {}
		},
		header: (page: number) =>
			m.cover && page === 1
				? null
				: furniture({
						margin: [72, 24, 36, 0],
						stack: [
							furniture({
								columns: [
									furniture(logo ? { image: logo, width: 62 } : { text: '' }),
									furniture({ text: m.title, alignment: 'center', fontSize: 9, margin: [0, 2, 0, 0] }),
									furniture({ text: 'Internal', alignment: 'right', fontSize: 9, margin: [0, 2, 0, 0] })
								]
							}),
							furniture(rule(4))
						]
					}),
		footer: (page: number, pages: number) =>
			furniture({
				margin: [72, 8, 36, 0],
				stack: [
					furniture(rule(0)),
					furniture({
						margin: [0, 4, 0, 0],
						columns: [
							furniture({ text: m.monthYear, fontSize: 7 }),
							furniture({ text: m.footer, alignment: 'center', fontSize: 7 }),
							furniture({ text: `Page ${page} of ${pages}`, alignment: 'right', fontSize: 7 })
						]
					})
				]
			}),
		content
	};
	const pdf = pm.createPdf(def);
	const blob = await new Promise<Blob>((resolve, reject) => {
		try {
			const maybe = pdf.getBlob((b) => resolve(b));
			if (maybe && typeof (maybe as Promise<Blob>).then === 'function') (maybe as Promise<Blob>).then(resolve, reject);
		} catch (e) {
			reject(e);
		}
	});
	save(blob, `${m.fileStem}.pdf`);
}
