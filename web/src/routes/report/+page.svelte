<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { BRAND } from '$lib/brand';
	import { PAGE_PALETTE } from '$lib/chart';
	import { getJson } from '$lib/format';
	import { buildDoc, dayChart, dayLabel, hitState, pct, periodLabel, reachedLabel, slotChart, type View } from '$lib/reportDoc';
	import { clock, slotName, slotRange } from '$lib/slots';

	let { data } = $props();
	const r = $derived(data.report);
	const many = $derived(r.period !== 'day');

	// svelte-ignore state_referenced_locally
	let view = $state<View>(data.view);
	let layout = $state<'web' | 'doc'>('web');
	let menu = $state<'none' | 'calendar' | 'download'>('none');
	let busy = $state('');
	let error = $state('');

	const showG = $derived(view !== 'table');
	const showT = $derived(view !== 'graph');
	const label = $derived(periodLabel(r));
	const dateButton = $derived(r.period === 'day' ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${r.date}T00:00:00Z`)) : label);
	const maxSlot = $derived(Math.max(10, ...r.accounts.flatMap((a) => a.slots)));
	const model = $derived(buildDoc(r, data.doc, view, data.username));
	const showLogo = $derived(model.logo && !!BRAND.logo);
	const slotSvg = $derived(r.hasData && r.accounts.length ? slotChart(r, PAGE_PALETTE).svg : '');
	const daySvg = $derived(r.hasData && many ? dayChart(r, PAGE_PALETTE).svg : '');

	function open(period: string, date: string) {
		menu = 'none';
		goto(`/report?period=${period}&date=${date}`, { keepFocus: true, noScroll: true });
	}

	// ---- moving between periods ----
	const DAY = 86_400_000;
	const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
	const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
	function shifted(dir: 1 | -1): string {
		const t = ms(r.date);
		if (r.period === 'day') return iso(t + dir * DAY);
		if (r.period === 'week') return iso(t + dir * 7 * DAY);
		const d = new Date(t);
		return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1));
	}
	/** Earlier: only while history reaches that far. Later: never past today. */
	const canPrev = $derived(!!r.firstDate && r.dates[0] > r.firstDate);
	const canNext = $derived(r.dates[r.dates.length - 1] < r.today);

	// ---- calendar ----
	let calMonth = $state('');
	let dots = $state<string[]>([]);
	const cells = $derived.by(() => {
		if (!calMonth) return [];
		const [y, m] = calMonth.split('-').map(Number);
		const first = Date.UTC(y, m - 1, 1);
		const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
		const pad = (new Date(first).getUTCDay() + 6) % 7;
		return [...Array.from({ length: pad }, () => null), ...Array.from({ length: count }, (_, k) => iso(first + k * DAY))];
	});
	const calTitle = $derived(calMonth ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${calMonth}-01T00:00:00Z`)) : '');
	async function loadDots(month: string) {
		calMonth = month;
		dots = [];
		try {
			dots = (await getJson<{ days: string[] }>(`/api/report/days?month=${month}`)).days;
		} catch {
			/* the calendar still works without dots */
		}
	}
	function toggleCalendar() {
		if (menu === 'calendar') return void (menu = 'none');
		menu = 'calendar';
		loadDots(r.date.slice(0, 7));
	}
	function calStep(dir: 1 | -1) {
		const [y, m] = calMonth.split('-').map(Number);
		loadDots(iso(Date.UTC(y, m - 1 + dir, 1)).slice(0, 7));
	}

	// ---- downloads ----
	async function download(format: 'docx' | 'pdf' | 'csv') {
		menu = 'none';
		error = '';
		busy = format;
		try {
			const x = await import('$lib/reportExport');
			if (format === 'docx') await x.downloadDocx(model);
			else if (format === 'pdf') await x.downloadPdf(model);
			else x.downloadCsv(model);
		} catch (e) {
			error = `The ${format === 'docx' ? 'Word file' : format === 'pdf' ? 'PDF' : 'CSV'} could not be made: ${(e as Error).message}`;
		}
		busy = '';
	}
	const FORMATS: { id: 'docx' | 'pdf' | 'csv'; label: string }[] = [
		{ id: 'docx', label: 'Word document (.docx)' },
		{ id: 'pdf', label: 'PDF (.pdf)' },
		{ id: 'csv', label: 'Spreadsheet (.csv)' }
	];
	// the default format (Settings) is listed first
	const formats = $derived([...FORMATS].sort((a, b) => Number(b.id === data.doc.format) - Number(a.id === data.doc.format)));

	onMount(() => {
		// menus close on a click anywhere else and on Escape
		const away = (e: MouseEvent) => {
			if (menu !== 'none' && !(e.target as Element).closest('.k-anchor')) menu = 'none';
		};
		const esc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') menu = 'none';
		};
		document.addEventListener('click', away);
		document.addEventListener('keydown', esc);
		return () => {
			document.removeEventListener('click', away);
			document.removeEventListener('keydown', esc);
		};
	});
</script>

<svelte:head><title>Report - Claude Usage</title></svelte:head>

{#snippet limits()}
	<section class="k-card" data-testid="limits">
		<div class="k-cardhead"><h2>Limits reached</h2><span class="k-small k-muted">{r.hits.length} in this period</span></div>
		{#if r.hits.length}
			{#each r.hits as h (`${h.accountId}-${h.window}-${h.ts}`)}
				<div class="kv"><span><b>{h.account}</b> <span class="k-small k-muted">{r.labels[h.window]} &middot; {reachedLabel(h, r.timezone)}</span></span><span class="k-num blocked">{hitState(h, r.timezone)}</span></div>
			{/each}
		{:else}<p class="empty k-muted">No account was blocked by a limit.</p>{/if}
	</section>
{/snippet}

<div class="k-stack">
	<h1>Report</h1>

	<div class="k-row k-end head">
		<div class="k-seg" role="group" aria-label="Layout">
			<button type="button" aria-pressed={layout === 'web'} onclick={() => (layout = 'web')}>Web view</button>
			<button type="button" aria-pressed={layout === 'doc'} onclick={() => (layout = 'doc')}>Download preview</button>
		</div>
		<div class="k-anchor dl">
			<button class="k-btn primary" type="button" aria-haspopup="menu" aria-expanded={menu === 'download'} disabled={!!busy} onclick={() => (menu = menu === 'download' ? 'none' : 'download')}>
				{busy ? 'Preparing...' : 'Download'} <span aria-hidden="true">▾</span>
			</button>
			{#if menu === 'download'}
				<div class="k-pop dlmenu" role="menu">
					{#each formats as f (f.id)}
						<button class="item" type="button" role="menuitem" onclick={() => download(f.id)}>{f.label}</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>
	{#if error}<p class="k-flash err" role="alert">{error}</p>{/if}

	<div class="k-row k-between">
		<div class="k-row">
			<span class="k-label">Period</span>
			<div class="k-seg" role="group" aria-label="Period">
				{#each [['day', 'Day'], ['week', 'Week'], ['month', 'Month']] as p (p[0])}
					<button type="button" aria-pressed={r.period === p[0]} onclick={() => open(p[0], r.date)}>{p[1]}</button>
				{/each}
			</div>
			<button class="k-btn" type="button" aria-label="Earlier" disabled={!canPrev} onclick={() => open(r.period, shifted(-1))}>‹</button>
			<div class="k-anchor">
				<button class="k-btn datebtn" type="button" data-testid="date-button" aria-haspopup="dialog" aria-expanded={menu === 'calendar'} onclick={toggleCalendar}>{dateButton} <span aria-hidden="true">▾</span></button>
				{#if menu === 'calendar'}
					<div class="k-pop cal" role="dialog" aria-label="Pick a date">
						<div class="calhead">
							<button class="k-btn" type="button" aria-label="Previous month" onclick={() => calStep(-1)}>‹</button>
							<span>{calTitle}</span>
							<button class="k-btn" type="button" aria-label="Next month" disabled={calMonth >= r.today.slice(0, 7)} onclick={() => calStep(1)}>›</button>
						</div>
						<div class="calgrid">
							{#each ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as d (d)}<span class="dow">{d}</span>{/each}
							{#each cells as c, i (c ?? `pad-${i}`)}
								{#if c}
									<button type="button" class:has={dots.includes(c)} class:sel={c === r.date} disabled={c > r.today} onclick={() => open(r.period, c)}>{Number(c.slice(8))}</button>
								{:else}<span></span>{/if}
							{/each}
						</div>
						<p class="k-small k-muted calnote">A dot marks a day with saved data.</p>
					</div>
				{/if}
			</div>
			<button class="k-btn" type="button" aria-label="Later" disabled={!canNext} onclick={() => open(r.period, shifted(1))}>›</button>
			{#if r.date !== r.today}<button class="k-btn" type="button" onclick={() => open(r.period, r.today)}>Today</button>{/if}
		</div>
		<div class="k-row">
			<span class="k-label">Show</span>
			<div class="k-seg" role="group" aria-label="Show">
				{#each [['graph', 'Graph'], ['table', 'Table'], ['both', 'Both']] as v (v[0])}
					<button type="button" aria-pressed={view === v[0]} onclick={() => (view = v[0] as View)}>{v[1]}</button>
				{/each}
			</div>
			{#if data.canEditSlots}<a class="k-btn" href="/settings">Edit time slots</a>{/if}
		</div>
	</div>

	{#if layout === 'web'}
		{#if !r.hasData}
			<div class="k-card" data-testid="no-data">
				<p class="empty">
					{#if r.firstDate}No usage data was saved for {label}. Pick a day marked with a dot in the calendar.
					{:else}No history yet. The server saves a reading of every account on its schedule; the report fills in from the first reading on.{/if}
				</p>
			</div>
			<!-- no reading in the period, yet a limit reached earlier still held during it -->
			{#if r.hits.length}{@render limits()}{/if}
		{:else}
			<div class="kpis" data-testid="kpis">
				<div class="kpi"><div class="k-label">Total used</div><div class="v">{pct(r.total)}</div><div class="s">{r.accounts.length} {r.accounts.length === 1 ? 'account' : 'accounts'}{many ? ` · ${r.daysWithData} ${r.daysWithData === 1 ? 'day' : 'days'}` : ''}</div></div>
				<div class="kpi"><div class="k-label">Busiest slot</div><div class="v">{r.busiestSlot === null ? '-' : slotName(r.slots[r.busiestSlot])}</div><div class="s">{r.busiestSlot === null ? 'nothing used' : `${slotRange(r.slots[r.busiestSlot])} · ${pct(r.slotTotals[r.busiestSlot])}`}</div></div>
				<div class="kpi"><div class="k-label">Top account</div><div class="v">{r.topAccount ?? '-'}</div><div class="s">{r.topAccount ? pct(r.topTotal) : 'nothing used'}</div></div>
				<div class="kpi"><div class="k-label">Limits reached</div><div class="v">{r.hits.length}</div><div class="s">{r.hits.length ? 'listed below' : 'none in this period'}</div></div>
				<div class="kpi"><div class="k-label">Not used</div><div class="v">{r.idle.length}</div><div class="s">{r.idle.length ? r.idle.join(', ') : r.idleBelow === 0 ? 'not counted (Settings)' : r.noReadings.length || r.hits.length ? 'none' : 'all accounts active'}</div></div>
			</div>
			{#if r.noReadings.length || r.outsideSlots >= 0.5}
				<p class="k-note" data-testid="report-gaps">
					{#if r.noReadings.length}No readings were saved for {r.noReadings.join(', ')} in this period, so {r.noReadings.length === 1 ? 'its' : 'their'} use is not known.{/if}
					{#if r.outsideSlots >= 0.5}{pct(r.outsideSlots)} was used at times no time slot covers and is in none of these figures.{/if}
				</p>
			{/if}

			{#if showG}
				<section class="k-card" data-testid="slot-chart">
					<div class="k-cardhead"><h2>Usage by time slot</h2><span class="k-small k-muted">% of an hourly session</span></div>
					<div class="k-only-wide">
						<div class="chartbox">{@html slotSvg}</div>
						<div class="legend">{#each r.accounts as a, i (a.id)}<span><i style:background="var(--series-{(i % 6) + 1})"></i>{a.name}</span>{/each}</div>
					</div>
					<div class="k-only-narrow">
						{#each r.slots as s, si (si)}
							<div class="grp">
								<div class="grphead"><b>{slotName(s)}</b><span class="k-small k-muted">{s.name.trim() ? `${slotRange(s)} · ` : ''}{pct(r.slotTotals[si])}</span></div>
								{#each r.accounts as a, i (a.id)}
									<div class="hb"><span>{a.name}</span><div class="track"><div style:width="{Math.min(100, (a.slots[si] / maxSlot) * 100)}%" style:background="var(--series-{(i % 6) + 1})"></div></div><span class="k-num">{pct(a.slots[si])}</span></div>
								{/each}
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if showT}
				<section class="k-card" data-testid="slot-table">
					<div class="k-cardhead"><h2>By account</h2></div>
					<div class="k-only-wide k-tablebox">
						<table class="k-table">
							<thead>
								<tr><th>Account</th>{#each r.slots as s, si (si)}<th class="r">{slotName(s)}{#if s.name.trim()}<br /><span class="sub">{slotRange(s)}</span>{/if}</th>{/each}<th class="r">Total</th>{#if many}<th class="r">Days used</th>{/if}</tr>
							</thead>
							<tbody>
								{#each r.accounts as a (a.id)}
									<tr><td><b>{a.name}</b>{#if a.provider === 'codex'}&nbsp;<span class="k-tag">Codex</span>{/if}{#if !a.current}&nbsp;<span class="k-small k-muted">(removed)</span>{/if}</td>{#each a.slots as v, si (si)}<td class="r">{pct(v)}</td>{/each}<td class="r"><b>{pct(a.total)}</b></td>{#if many}<td class="r">{a.daysUsed} of {r.daysWithData}</td>{/if}</tr>
								{/each}
								<tr><td><b>All accounts</b></td>{#each r.slotTotals as v, si (si)}<td class="r"><b>{pct(v)}</b></td>{/each}<td class="r"><b>{pct(r.total)}</b></td>{#if many}<td></td>{/if}</tr>
							</tbody>
						</table>
					</div>
					<div class="k-only-narrow">
						{#each r.accounts as a (a.id)}
							<div class="grp">
								<div class="grphead"><b>{a.name}{#if a.provider === 'codex'} <span class="k-tag">Codex</span>{/if}{#if !a.current} <span class="k-small k-muted">(removed)</span>{/if}</b><b class="k-num">{pct(a.total)}</b></div>
								{#each r.slots as s, si (si)}<div class="kv slim"><span class="k-muted">{slotName(s)}</span><span class="k-num">{pct(a.slots[si])}</span></div>{/each}
								{#if many}<div class="kv slim"><span class="k-muted">Days used</span><span class="k-num">{a.daysUsed} of {r.daysWithData}</span></div>{/if}
							</div>
						{/each}
					</div>
				</section>
			{/if}

			{#if many}
				<section class="k-card" data-testid="day-card">
					<div class="k-cardhead"><h2>Usage by day</h2><span class="k-small k-muted">all accounts · tap a day to open it</span></div>
					{#if showG}<div class="chartbox">{@html daySvg}</div>{/if}
					{#if showT}
						<div class="days">
							{#each r.days as d (d.date)}
								<button class="kv daybtn" type="button" disabled={!d.hasData} onclick={() => open('day', d.date)}><span>{dayLabel(d.date)}</span><span class="k-num">{#if d.hasData}<b>{pct(d.total)}</b>{:else}<span class="k-muted">no data</span>{/if}</span></button>
							{/each}
						</div>
					{/if}
				</section>
			{/if}

			{@render limits()}
		{/if}
		<p class="k-note">
			Figures are a percentage of one hourly session per account. Over 100% means the session reset and was used again.
			A report day runs for 24 hours from {clock(r.slots[0].from)}. Times are in {r.timezone}.
			Download gives the same figures as a Word or PDF document, or as a spreadsheet.
		</p>
	{:else}
		<!-- What the Word and PDF files contain, laid out like their pages. Always dark ink on white. -->
		<div class="desk" data-testid="doc-preview">
			{#if model.cover}
				<article class="paper cover">
					<p class="c1">{model.coverLabel}</p>
					<p class="ctitle">{model.title}</p>
					<p class="c2">{model.period}</p>
					<p class="c1">{model.subtitle}</p>
					{#if model.contact.length || showLogo}<p class="c1">By</p>{/if}
					{#if showLogo}<img src={BRAND.logo} alt="" class="biglogo" />{/if}
					{#if model.contact.length}<p class="c3">{#each model.contact as t, i (i)}{#if i}<br />{/if}{#if i === 0 && t === model.company}<b>{t}</b>{:else}{t}{/if}{/each}</p>{/if}
					<div class="cver">Prepared by: {model.preparedBy}<br />Generated: {model.generated}<br />{model.monthYear}</div>
					<div class="pfoot"><span>{model.monthYear}</span><span>{model.footer}</span><span>Page</span></div>
				</article>
			{/if}
			{#if model.contents}
				<article class="paper">
					<div class="phead">{#if showLogo}<img src={BRAND.logo} alt="" />{:else}<span></span>{/if}<span>{model.title}</span><span>Internal</span></div>
					<p class="chead">{model.footer ? model.footer.toUpperCase() : 'NOTICE'}</p>
					{#if model.notice}<div class="notice">{model.notice}</div>{/if}
					{#if model.contact.length}<p class="c3">{#each model.contact as t, i (i)}{#if i}<br />{/if}{#if i === 0 && t === model.company}<b>{t}</b>{:else}{t}{/if}{/each}</p>{/if}
					<p class="chead left">TABLE OF CONTENTS</p>
					<ol class="toc">{#each model.sections as s, i (i)}<li><span>{i + 1}</span><span>{s.title}</span><i></i></li>{/each}</ol>
					<div class="pfoot"><span>{model.monthYear}</span><span>{model.footer}</span><span>Page</span></div>
				</article>
			{/if}
			<article class="paper">
				<div class="phead">{#if showLogo}<img src={BRAND.logo} alt="" />{:else}<span></span>{/if}<span>{model.title}</span><span>Internal</span></div>
				{#each model.sections as s, i (i)}
					<section class="sec">
						<h3><span class="hn">{i + 1}</span>{s.title}</h3>
						{#each s.blocks as b, bi (bi)}
							{#if b.type === 'p'}<p>{b.text}</p>
							{:else if b.type === 'bullets'}<ul>{#each b.items as item (item)}<li>{item}</li>{/each}</ul>
							{:else if b.type === 'figure'}<div class="chartbox">{@html b.chart.svg}</div><p class="cap">{b.caption}</p>
							{:else}
								<div class="scroll">
									<table class="doc">
										<thead><tr>{#each b.head as h, hi (hi)}<th>{h}</th>{/each}</tr></thead>
										<tbody>{#each b.rows as row, ri (ri)}<tr class:total={b.totalRow && ri === b.rows.length - 1}>{#each row as v, ci (ci)}<td class:r={ci > 0}>{v}</td>{/each}</tr>{/each}</tbody>
									</table>
								</div>
								<p class="cap">{b.caption}</p>
							{/if}
						{/each}
					</section>
				{/each}
				<div class="pfoot"><span>{model.monthYear}</span><span>{model.footer}</span><span>Page</span></div>
			</article>
		</div>
		<p class="k-note">
			This is what the Word and PDF downloads contain. Page numbers and the contents page numbers are filled in by the file itself. The spreadsheet download carries the tables only.
			<span class="k-only-narrow">On a narrow screen, swipe a table or chart sideways to see all of it.</span>
		</p>
	{/if}
</div>

<style>
	.head {
		margin-bottom: -0.25rem;
	}
	.datebtn {
		font-weight: 600;
	}
	.dlmenu {
		left: auto;
		right: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 13rem;
	}
	.item {
		height: 2rem;
		padding: 0 0.5rem;
		border: 0;
		border-radius: calc(var(--radius) * 0.8);
		background: transparent;
		color: var(--text);
		font-size: 0.8125rem;
		text-align: left;
		cursor: pointer;
	}
	.item:hover {
		background: var(--soft);
	}
	.cal {
		width: 17rem;
		max-width: calc(100vw - 2rem);
	}
	.calhead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.4rem;
		font-weight: 600;
	}
	.calgrid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 2px;
		text-align: center;
	}
	.dow {
		padding: 0.15rem 0;
		font-size: 0.7rem;
		color: var(--muted);
	}
	.calgrid button {
		position: relative;
		padding: 0.3rem 0 0.5rem;
		border: 0;
		border-radius: calc(var(--radius) * 0.8);
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}
	.calgrid button:hover:not(:disabled) {
		background: var(--soft);
	}
	.calgrid button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.calgrid button.has::after {
		content: '';
		position: absolute;
		bottom: 3px;
		left: 50%;
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--card-link);
		transform: translateX(-50%);
	}
	.calgrid button.sel {
		background: var(--accent);
		color: var(--accent-text);
	}
	.calgrid button.sel::after {
		background: var(--accent-text);
	}
	.calnote {
		margin: 0.5rem 0 0;
	}
	.kpis {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
		gap: 0.6rem;
	}
	.kpi {
		min-width: 0;
		padding: 0.65rem 0.85rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.kpi .v {
		margin: 0.1rem 0;
		font-family: 'Noto Sans Variable', 'Noto Sans', system-ui, sans-serif;
		font-size: 1.25rem;
		font-weight: 600;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}
	.kpi .s {
		font-size: 0.75rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.chartbox {
		overflow-x: auto;
	}
	/* on a very wide screen the chart stops growing taller and stays centred */
	.chartbox :global(svg) {
		max-height: 23rem;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1rem;
		margin-top: 0.4rem;
		font-size: 0.8rem;
	}
	.legend i {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		margin-right: 0.3rem;
		border-radius: 2px;
		vertical-align: -1px;
	}
	.sub {
		font-weight: 400;
	}
	.k-table th {
		height: auto;
		padding-block: 0.3rem;
		line-height: 1.3;
	}
	.grp {
		padding: 0.55rem 0;
		border-top: 1px solid var(--border);
	}
	.grp:first-child {
		padding-top: 0;
		border-top: 0;
	}
	.grphead {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		margin-bottom: 0.3rem;
	}
	.hb {
		display: grid;
		grid-template-columns: 6.2rem minmax(0, 1fr) 2.8rem;
		align-items: center;
		gap: 0.5rem;
		padding: 0.12rem 0;
		font-size: 0.8125rem;
	}
	.hb span:first-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hb span:last-child {
		text-align: right;
	}
	.track {
		height: 10px;
		overflow: hidden;
		border-radius: 3px;
		background: var(--track);
	}
	.track div {
		height: 100%;
		border-radius: 3px;
	}
	.kv {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.2rem 0.75rem;
		padding: 0.35rem 0;
		border-top: 1px solid var(--border);
		font-size: 0.8125rem;
	}
	.kv.slim {
		padding: 0.1rem 0;
		border-top: 0;
	}
	.days {
		margin-top: 0.5rem;
	}
	.daybtn {
		width: 100%;
		border-width: 1px 0 0;
		border-style: solid;
		border-color: var(--border);
		background: transparent;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	.daybtn:hover:not(:disabled) {
		background: var(--soft);
	}
	.daybtn:disabled {
		cursor: default;
	}
	.blocked {
		color: var(--red);
	}
	.empty {
		margin: 0.2rem 0;
	}

	/* ---- download preview: the document's pages, always printed-page colours ---- */
	.desk {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		padding: clamp(0.5rem, 3vw, 1.5rem);
		background: var(--track);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.paper {
		--ink: #1c1917;
		--ink-muted: #57534e;
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		width: 100%;
		max-width: 794px;
		min-width: 0;
		min-height: min(1000px, 130vw);
		margin: 0 auto;
		padding: clamp(1rem, 5vw, 2.75rem);
		background: #ffffff;
		color: var(--ink);
		color-scheme: light;
		box-shadow: 0 2px 12px rgb(0 0 0 / 0.25);
		font-family: Arial, Helvetica, sans-serif;
		font-size: 0.875rem;
	}
	.paper p {
		margin: 0;
	}
	.phead {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-bottom: 0.35rem;
		border-bottom: 1px solid #000000;
		font-size: 0.75rem;
	}
	.phead img {
		width: auto;
		height: 16px;
	}
	.pfoot {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.3rem 1rem;
		margin-top: auto;
		padding-top: 0.5rem;
		border-top: 1px solid #000000;
		font-size: 0.7rem;
	}
	.cover {
		align-items: center;
		text-align: center;
	}
	.cover .pfoot {
		align-self: stretch;
	}
	.c1 {
		margin-top: 1.2rem !important;
		font-size: 1.1rem;
		font-weight: 700;
	}
	.ctitle {
		margin-top: 2.5rem !important;
		font-size: 2.1rem;
		font-weight: 700;
		line-height: 1.15;
		text-wrap: balance;
	}
	.c2 {
		font-size: 1.4rem;
		font-weight: 700;
	}
	.c3 {
		text-align: center;
	}
	.biglogo {
		width: auto;
		height: 46px;
		max-width: 80%;
	}
	.cver {
		align-self: flex-start;
		margin-top: 2rem;
		text-align: left;
	}
	.chead {
		font-size: 1.15rem;
		font-weight: 700;
		text-align: center;
	}
	.chead.left {
		text-align: left;
	}
	.notice {
		padding: 0.8rem;
		border: 1px solid #000000;
		font-size: 0.78rem;
		text-align: justify;
		white-space: pre-line;
	}
	.toc {
		margin: 0;
		padding: 0;
		font-weight: 700;
		list-style: none;
	}
	.toc li {
		display: flex;
		gap: 0.6rem;
		padding: 0.2rem 0;
	}
	.toc li i {
		flex: 1;
		margin-bottom: 0.3rem;
		border-bottom: 1px dotted #000000;
	}
	.sec {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		min-width: 0;
	}
	.sec h3 {
		margin: 0;
		font-family: Arial, Helvetica, sans-serif;
		font-size: 1.15rem;
	}
	.hn {
		display: inline-block;
		min-width: 2rem;
	}
	.sec ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.cap {
		font-weight: 700;
		text-align: center;
	}
	.scroll {
		overflow-x: auto;
	}
	.doc {
		width: 100%;
		border-collapse: collapse;
		color: var(--ink);
		font-size: 0.75rem;
	}
	.doc th,
	.doc td {
		padding: 0.4rem 0.6rem;
		border: 1px solid #000000;
		text-align: left;
		white-space: nowrap;
	}
	.doc th {
		text-align: center;
		/* a heading may wrap so the table fits the page, as it does in the Word and PDF files */
		white-space: normal;
	}
	.doc td.r {
		text-align: right;
	}
	.doc tr.total td {
		font-weight: 700;
	}
	@media (max-width: 640px) {
		/* menus span the content width on phones so they can never leave the screen */
		.head {
			position: relative;
		}
		.dl {
			position: static;
		}
		.dlmenu {
			left: 0;
			right: 0;
			width: auto;
		}
		.item {
			height: 2.5rem;
		}
		/* a phone has no room for every column: there a table keeps its width and scrolls sideways */
		.doc th {
			white-space: nowrap;
		}
	}
</style>
