<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { post } from '$lib/format';
	import { MAX_SLOTS, duration, slotLength, slotName, slotRange, slotsProblem, uncoveredMinutes, type Slot } from '$lib/slots';
	import type { Settings } from '$lib/server/settings';

	let { data } = $props();

	// svelte-ignore state_referenced_locally
	let s = $state<Settings>(structuredClone(data.settings));
	// svelte-ignore state_referenced_locally
	let slots = $state<Slot[]>(structuredClone(data.settings.slots));
	let saved = $state('');
	let error = $state('');
	let slotError = $state('');
	let savingSlots = $state(false);
	let savedTimer: ReturnType<typeof setTimeout> | undefined;
	/** Redraws the fields after a refused value, so the box shows what the server still has. */
	let formRev = $state(0);

	function flash(text: string) {
		saved = text;
		clearTimeout(savedTimer);
		savedTimer = setTimeout(() => (saved = ''), 2500);
	}

	/** Saves one or more settings straight away; a refused value snaps back to what the server has. */
	async function save(patch: Partial<Settings>, what: string) {
		error = '';
		try {
			const out = await post<{ settings: Settings }>('/api/app-settings', patch);
			s = structuredClone(out.settings);
			flash(`Saved: ${what}.`);
			await invalidateAll(); // the menu, labels and colours on other pages follow
		} catch (e) {
			error = (e as Error).message;
			formRev++;
		}
	}
	const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
	const str = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;

	// ---- time slots: edited as a whole, saved with one button (half-edited times may overlap) ----
	const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
	const minutes = (v: string) => {
		const m = /^(\d\d):(\d\d)$/.exec(v);
		return m ? +m[1] * 60 + +m[2] : null;
	};
	const problem = $derived(slotsProblem(slots.map((x) => ({ ...x, name: x.name.trim() }))));
	const gap = $derived(problem ? 0 : uncoveredMinutes(slots));
	const dirty = $derived(JSON.stringify(slots) !== JSON.stringify(s.slots));
	const segments = $derived(
		slots.flatMap((x, k) => {
			const len = slotLength(x);
			const parts = x.from + len > 1440 ? [[x.from, 1440 - x.from], [0, x.from + len - 1440]] : [[x.from, len]];
			return parts.map(([from, l]) => ({ k, left: (from / 1440) * 100, width: (l / 1440) * 100, title: `${slotName(x)}: ${slotRange(x)}` }));
		})
	);
	function setTime(k: number, field: 'from' | 'to', e: Event) {
		const m = minutes(str(e));
		if (m !== null) slots[k][field] = m;
	}
	function addSlot() {
		const last = slots[slots.length - 1];
		slots.push({ name: '', from: last.to, to: (last.to + 60) % 1440 });
	}
	function move(k: number, dir: 1 | -1) {
		const [x] = slots.splice(k, 1);
		slots.splice(k + dir, 0, x);
	}
	function resetSlots() {
		slots = [
			{ name: 'Morning', from: 540, to: 780 },
			{ name: 'Lunch', from: 780, to: 840 },
			{ name: 'Afternoon', from: 840, to: 1080 },
			{ name: 'After hours', from: 1080, to: 540 }
		];
	}
	async function saveSlots() {
		slotError = '';
		savingSlots = true;
		try {
			const out = await post<{ settings: Settings }>('/api/app-settings', { slots });
			s = structuredClone(out.settings);
			slots = structuredClone(out.settings.slots);
			flash('Saved: time slots. Every report, past days included, now uses them.');
			await invalidateAll();
		} catch (e) {
			slotError = (e as Error).message;
		}
		savingSlots = false;
	}

	const zones = (() => {
		try {
			return Intl.supportedValuesOf('timeZone');
		} catch {
			return [];
		}
	})();
</script>

<svelte:head><title>Settings - Claude Usage</title></svelte:head>

<div class="k-stack">
	<h1>Settings</h1>
	<p class="k-small k-muted lead">Changes are saved as you make them and apply to everyone. Time slots are saved with their own button.</p>
	{#if error}<p class="k-flash err" role="alert">{error}</p>{/if}
	{#if saved}<p class="k-flash toast" role="status" data-testid="saved">{saved}</p>{/if}

	<section class="k-card" data-testid="slots-card">
		<div class="k-cardhead">
			<h2>Time slots</h2>
			<div class="k-row">
				<button class="k-btn" type="button" disabled={slots.length >= MAX_SLOTS} onclick={addSlot}>+ Add slot</button>
				<button class="k-btn" type="button" onclick={resetSlots}>Reset to default</button>
			</div>
		</div>
		<div class="k-tablebox">
			<table class="k-table slots">
				<thead><tr><th></th><th>Name</th><th>From</th><th>To</th><th>Length</th><th></th></tr></thead>
				<tbody>
					{#each slots as x, k (k)}
						<tr>
							<td><i class="sw" style:background="var(--series-{(k % 6) + 1})"></i></td>
							<td><input class="k-input name" bind:value={x.name} maxlength="20" placeholder="Name (optional)" aria-label="Slot {k + 1} name" /></td>
							<td><input class="k-input" type="time" value={hhmm(x.from)} onchange={(e) => setTime(k, 'from', e)} aria-label="Slot {k + 1} from" /></td>
							<td><input class="k-input" type="time" value={hhmm(x.to)} onchange={(e) => setTime(k, 'to', e)} aria-label="Slot {k + 1} to" /></td>
							<td class="k-muted len">{duration(slotLength(x))}{x.to <= x.from ? ' · ends next day' : ''}</td>
							<td>
								<div class="k-row acts">
									<button class="k-btn" type="button" disabled={k === 0} onclick={() => move(k, -1)} aria-label="Move slot {k + 1} up">↑</button>
									<button class="k-btn" type="button" disabled={k === slots.length - 1} onclick={() => move(k, 1)} aria-label="Move slot {k + 1} down">↓</button>
									<button class="k-btn" type="button" disabled={slots.length <= 1} onclick={() => slots.splice(k, 1)} aria-label="Remove slot {k + 1}">Remove</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="daybar" aria-hidden="true">{#each segments as g, i (i)}<i title={g.title} style:left="{g.left}%" style:width="{g.width}%" style:background="var(--series-{(g.k % 6) + 1})"></i>{/each}</div>
		<div class="dayaxis k-small k-muted" aria-hidden="true"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span></div>
		{#if problem}<p class="msg bad" role="alert" data-testid="slot-problem">{problem}</p>
		{:else if gap}<p class="msg warn" data-testid="slot-gap">{duration(gap)} of the day is not in any slot. Usage in that time is left out of the report.</p>
		{:else}<p class="msg k-muted">The slots cover the full 24 hours.</p>{/if}
		{#if slotError}<p class="msg bad" role="alert">{slotError}</p>{/if}
		<div class="k-row savebar">
			<button class="k-btn primary" type="button" disabled={!dirty || !!problem || savingSlots} onclick={saveSlots} data-testid="save-slots">{savingSlots ? 'Saving...' : 'Save time slots'}</button>
			{#if dirty}<button class="k-btn" type="button" onclick={() => (slots = structuredClone(s.slots))}>Undo changes</button>{/if}
			<span class="k-small k-muted">Times are to the minute. A slot whose "To" is earlier than its "From" runs past midnight. The report day starts at the first slot. Up to {MAX_SLOTS} slots.</span>
		</div>
	</section>

	{#key formRev}
	<section class="k-card">
		<div class="k-cardhead"><h2>Data collection</h2></div>
		<div class="k-grid">
			<label class="k-field">Collect usage every
				<select class="k-input" value={s.pollSeconds} onchange={(e) => save({ pollSeconds: num(e) }, 'collection interval')}>
					{#if ![30, 60, 120, 300, 600, 900, 1800].includes(s.pollSeconds)}<option value={s.pollSeconds}>{s.pollSeconds} seconds (from the server configuration)</option>{/if}
					<option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={120}>2 minutes</option><option value={300}>5 minutes</option>
					<option value={600}>10 minutes</option><option value={900}>15 minutes</option><option value={1800}>30 minutes</option>
				</select>
			</label>
			<label class="k-field">Keep history for
				<select class="k-input" value={s.historyDays} onchange={(e) => save({ historyDays: num(e) }, 'history length')}>
					{#if ![90, 180, 400, 730, 0].includes(s.historyDays)}<option value={s.historyDays}>{s.historyDays} days</option>{/if}
					<option value={90}>3 months</option><option value={180}>6 months</option><option value={400}>13 months</option><option value={730}>2 years</option><option value={0}>Forever</option>
				</select>
			</label>
			<label class="k-field">Time zone
				<input class="k-input" list="zones" value={s.timezone} onchange={(e) => save({ timezone: str(e).trim() }, 'time zone')} autocomplete="off" spellcheck="false" />
				<datalist id="zones">{#each zones as z (z)}<option value={z}></option>{/each}</datalist>
			</label>
		</div>
		<p class="k-small k-muted hint">A shorter interval gives more exact slot figures. The readings are kept, so slots can be changed later without losing anything.</p>
	</section>

	<section class="k-card">
		<div class="k-cardhead"><h2>Names and colours on the Usage page</h2></div>
		<div class="k-grid">
			<label class="k-field">Name of the 5-hour window<input class="k-input" value={s.hourlyLabel} maxlength="24" onchange={(e) => save({ hourlyLabel: str(e) }, 'window name')} /></label>
			<label class="k-field">Name of the 7-day window<input class="k-input" value={s.weeklyLabel} maxlength="24" onchange={(e) => save({ weeklyLabel: str(e) }, 'window name')} /></label>
			<label class="k-field">Turn amber at (%)<input class="k-input" type="number" min="1" max="99" value={s.warnAt} onchange={(e) => save({ warnAt: num(e) }, 'amber level')} /></label>
			<label class="k-field">Turn red at (%)<input class="k-input" type="number" min="2" max="100" value={s.highAt} onchange={(e) => save({ highAt: num(e) }, 'red level')} /></label>
			<label class="k-field">Page refreshes itself every
				<select class="k-input" value={s.autoRefreshSeconds} onchange={(e) => save({ autoRefreshSeconds: num(e) }, 'page refresh')}>
					<option value={15}>15 seconds</option><option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={0}>Off</option>
				</select>
			</label>
			<label class="k-field">Theme for new users
				<select class="k-input" value={s.defaultTheme} onchange={(e) => save({ defaultTheme: str(e) as Settings['defaultTheme'] }, 'default theme')}>
					<option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option>
				</select>
			</label>
			<label class="k-field">Wait between manual refreshes
				<select class="k-input" value={s.refreshWaitSeconds} onchange={(e) => save({ refreshWaitSeconds: num(e) }, 'refresh wait')}>
					<option value={0}>None</option><option value={30}>30 seconds</option><option value={60}>1 minute</option><option value={300}>5 minutes</option>
				</select>
			</label>
		</div>
	</section>

	<section class="k-card">
		<div class="k-cardhead"><h2>Report</h2></div>
		<div class="k-grid">
			<label class="k-field">Open the report showing
				<select class="k-input" value={s.reportView} onchange={(e) => save({ reportView: str(e) as Settings['reportView'] }, 'report view')}>
					<option value="both">Graph and table</option><option value="graph">Graph only</option><option value="table">Table only</option>
				</select>
			</label>
			<label class="k-field">Default period
				<select class="k-input" value={s.reportPeriod} onchange={(e) => save({ reportPeriod: str(e) as Settings['reportPeriod'] }, 'default period')}>
					<option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
				</select>
			</label>
			<label class="k-field">Count as "limit reached" at (%)<input class="k-input" type="number" min="50" max="100" value={s.limitAt} onchange={(e) => save({ limitAt: num(e) }, 'limit level')} /></label>
			<label class="k-field">Mark an account "not used" below (%)<input class="k-input" type="number" min="0" max="20" value={s.idleBelow} onchange={(e) => save({ idleBelow: num(e) }, 'not-used level')} /></label>
		</div>
	</section>

	<section class="k-card">
		<div class="k-cardhead"><h2>Downloaded document</h2></div>
		<div class="k-grid">
			<label class="k-field">Report title<input class="k-input" value={s.docTitle} maxlength="60" onchange={(e) => save({ docTitle: str(e) }, 'report title')} /></label>
			<label class="k-field">Company name<input class="k-input" value={s.docCompany} maxlength="60" onchange={(e) => save({ docCompany: str(e) }, 'company name')} /></label>
			<label class="k-field">Website<input class="k-input" value={s.docWebsite} maxlength="80" onchange={(e) => save({ docWebsite: str(e) }, 'website')} /></label>
			<label class="k-field">Contact e-mail<input class="k-input" value={s.docEmail} maxlength="80" onchange={(e) => save({ docEmail: str(e) }, 'contact e-mail')} /></label>
			<label class="k-field">Footer text<input class="k-input" value={s.docFooter} maxlength="40" onchange={(e) => save({ docFooter: str(e) }, 'footer text')} /></label>
			<label class="k-field">Default download format
				<select class="k-input" value={s.docFormat} onchange={(e) => save({ docFormat: str(e) as Settings['docFormat'] }, 'download format')}>
					<option value="docx">Word (.docx)</option><option value="pdf">PDF</option><option value="csv">Spreadsheet (.csv)</option>
				</select>
			</label>
			<label class="k-field wide">Notice on page 2<textarea class="k-input" maxlength="1200" value={s.docNotice} onchange={(e) => save({ docNotice: str(e) }, 'notice')}></textarea></label>
			<label class="k-check"><input type="checkbox" checked={s.docCover} onchange={(e) => save({ docCover: e.currentTarget.checked }, 'cover page')} />Include cover page</label>
			<label class="k-check"><input type="checkbox" checked={s.docContents} onchange={(e) => save({ docContents: e.currentTarget.checked }, 'contents page')} />Include notice and contents page</label>
			<label class="k-check"><input type="checkbox" checked={s.docLogo} onchange={(e) => save({ docLogo: e.currentTarget.checked }, 'logo')} />Show company logo</label>
		</div>
		<p class="k-small k-muted hint">To see the result, open Report and choose Download preview.</p>
	</section>

	{#if data.admin}
	<section class="k-card" data-testid="security-card">
		<div class="k-cardhead"><h2>Sign-in and security</h2></div>
		<div class="k-grid">
			<label class="k-field">Stay signed in for
				<select class="k-input" value={s.sessionDays} onchange={(e) => save({ sessionDays: num(e) }, 'sign-in length')}>
					<option value={1}>1 day</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
				</select>
			</label>
			<label class="k-field">Shortest password allowed<input class="k-input" type="number" min="8" max="64" value={s.minPassword} onchange={(e) => save({ minPassword: num(e) }, 'password length')} /></label>
			<label class="k-field">Wrong passwords before a pause<input class="k-input" type="number" min="3" max="20" value={s.loginTries} onchange={(e) => save({ loginTries: num(e) }, 'sign-in attempts')} /></label>
			<label class="k-field">Length of the pause
				<select class="k-input" value={s.loginPauseMinutes} onchange={(e) => save({ loginPauseMinutes: num(e) }, 'pause length')}>
					<option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={60}>1 hour</option>
				</select>
			</label>
		</div>
		<p class="k-small k-muted hint">"Stay signed in" applies to sign-ins made from now on.</p>
	</section>
	{/if}
	{/key}
</div>

<style>
	.lead {
		margin: 0;
	}
	.toast {
		position: sticky;
		top: 0.5rem;
		z-index: 4;
		margin: 0;
	}
	.sw {
		display: inline-block;
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 2px;
	}
	.slots td {
		padding-block: 0.3rem;
	}
	.name {
		width: 10rem;
	}
	.acts {
		flex-wrap: nowrap;
		gap: 0.3rem;
	}
	.daybar {
		position: relative;
		height: 20px;
		margin-top: 0.9rem;
		overflow: hidden;
		border-radius: 4px;
		background: var(--track);
	}
	.daybar i {
		position: absolute;
		top: 0;
		bottom: 0;
		border-right: 1px solid var(--surface);
		opacity: 0.85;
	}
	.dayaxis {
		display: flex;
		justify-content: space-between;
		margin-top: 0.2rem;
	}
	.msg {
		margin: 0.6rem 0 0;
		font-size: 0.8125rem;
	}
	.msg.bad {
		color: var(--red);
		font-weight: 600;
	}
	.msg.warn {
		color: var(--amber);
	}
	.savebar {
		margin-top: 0.75rem;
	}
	.hint {
		margin: 0.6rem 0 0;
	}
	@media (max-width: 640px) {
		/* the slot editor stacks into blocks instead of scrolling sideways */
		.slots thead {
			display: none;
		}
		.slots,
		.slots tbody {
			display: block;
		}
		.slots tr {
			display: grid;
			grid-template-columns: 1rem minmax(0, 1fr) minmax(0, 1fr);
			align-items: center;
			gap: 0.45rem 0.5rem;
			padding: 0.7rem 0.6rem;
		}
		.slots td {
			height: auto;
			padding: 0;
			white-space: normal;
		}
		.slots td:nth-child(2) {
			grid-column: 2 / 4;
		}
		.slots td:nth-child(3) {
			grid-column: 2;
		}
		.slots td:nth-child(4) {
			grid-column: 3;
		}
		.slots td:nth-child(5),
		.slots td:nth-child(6) {
			grid-column: 2 / 4;
		}
		.slots .k-input {
			width: 100%;
		}
	}
</style>
