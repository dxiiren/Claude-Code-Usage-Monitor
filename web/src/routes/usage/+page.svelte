<script lang="ts">
	import { onMount } from 'svelte';
	import UsageBar from '$lib/UsageBar.svelte';
	import { ago, needsLogin, pctText, post, readingOver, refreshSummary, resetsIn, windowFull } from '$lib/format';
	import type { Snapshot } from '$lib/server/api';

	let { data } = $props();
	/** Names of the two windows, colour levels and refresh timing (Settings, server mode). */
	const ui = $derived(data.ui);

	// svelte-ignore state_referenced_locally
	let snap = $state<Snapshot>(data.snap);
	let now = $state(Date.now());
	let stale = $state(false);

	async function refresh() {
		try {
			const res = await fetch('/api/accounts');
			if (!res.ok) throw new Error();
			snap = await res.json();
			stale = false;
		} catch {
			stale = true;
		}
	}

	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 1000);
		// 0 = the page does not refresh itself (Settings)
		const poll = ui.autoRefreshSeconds > 0 ? setInterval(refresh, ui.autoRefreshSeconds * 1000) : null;
		return () => {
			clearInterval(tick);
			if (poll) clearInterval(poll);
		};
	});

	// "Refresh now" (server mode): read usage straight away instead of waiting for the next reading.
	let refreshing = $state(false);
	let waitUntil = $state(0);
	let notice = $state<{ ok: boolean; text: string } | null>(null);
	const waitLeft = $derived(Math.max(0, Math.ceil((waitUntil - now) / 1000)));

	async function refreshNow() {
		if (refreshing || waitLeft > 0) return;
		refreshing = true;
		notice = null;
		try {
			const out = await post<{ refreshed: number; failed: number; pending: number; skipped: number; fresh: number; freshSeconds: number; snap: Snapshot }>('/api/usage/refresh');
			snap = out.snap;
			stale = false;
			notice = refreshSummary(out);
			// the wait starts only when the provider was actually asked (the server does the same)
			if (out.refreshed || out.failed || out.pending) waitUntil = Date.now() + ui.refreshWaitSeconds * 1000;
		} catch (e) {
			const err = e as Error & { data?: { retryAfter?: number } };
			if (err.data?.retryAfter) waitUntil = Date.now() + err.data.retryAfter * 1000;
			notice = { ok: false, text: err.message };
		} finally {
			refreshing = false;
		}
	}

	/** Accounts whose numbers can be trusted right now (logged in, login not expired). */
	const loggedIn = $derived(snap.accounts.filter((a) => a.email && !needsLogin(a.status.state)));
	const needing = $derived(snap.accounts.filter((a) => needsLogin(a.status.state)));
	const badgeText = (state: string) => (state === 'expired' ? 'Expired — log in again' : 'Not logged in');

	type Acc = Snapshot['accounts'][number];
	/** At a limit right now in either window (a window that has reset since no longer counts). */
	const isBlocked = (a: Acc) => windowFull(a.usage?.session, now) || windowFull(a.usage?.weekly, now);
	/** The last good reading is too old to describe the account (server mode; see staleAfterSeconds). */
	const isOld = (a: Acc) => snap.staleAfterSeconds !== null && a.usageReadUnix !== null && now / 1000 - a.usageReadUnix > snap.staleAfterSeconds;
	/**
	 * Accounts whose numbers describe right now: a recent reading with at least one window (a plan
	 * can come with one only). Age alone decides: one failed poll does not make a two-minute-old
	 * reading wrong, while a hidden account, which is not read, drops out once its numbers are old.
	 */
	const current = $derived(loggedIn.filter((a) => !isOld(a) && (a.usage?.session || a.usage?.weekly)));

	/** This window was read above zero and has reset since: its number is of a window that is over. */
	const over = (w: { percentage: number; resetsAt: number | null } | null | undefined) => readingOver(w?.percentage, w?.resetsAt, now);

	/** Most room right now: lowest 5h % among the current accounts that are not at a limit. */
	const best = $derived.by(() => {
		// a session that has reset since it was read is empty again, whatever the old number says
		const used = (a: Acc) => (over(a.usage?.session) ? 0 : (a.usage?.session?.percentage ?? 0));
		return current.filter((a) => !isBlocked(a)).sort((x, y) => used(x) - used(y))[0] ?? null;
	});
	const allBlocked = $derived(current.length > 0 && !best);

	/** When nothing is usable: the soonest moment any blocked account frees up. */
	const nextFree = $derived.by(() => {
		let soonest: number | null = null;
		for (const a of current) {
			const blockers = [a.usage?.session, a.usage?.weekly].filter((w) => windowFull(w, now) && w!.resetsAt);
			if (!blockers.length) continue;
			const freeAt = Math.max(...blockers.map((w) => w!.resetsAt!));
			if (soonest === null || freeAt < soonest) soonest = freeAt;
		}
		return soonest;
	});
	/** Some account has numbers, but none of them can be trusted for "now". */
	const onlyOld = $derived(!current.length && loggedIn.some((a) => a.usage?.session || a.usage?.weekly));

	const hasCodex = $derived(snap.accounts.some((a) => a.provider === 'codex'));
	const hasClaude = $derived(snap.accounts.some((a) => a.provider !== 'codex'));
	const cardTitle = $derived(!hasCodex ? 'Claude usage' : hasClaude ? 'Claude & Codex usage' : 'Codex usage');

	const updated = $derived(snap.usageUpdatedUnix ? new Date(snap.usageUpdatedUnix * 1000) : null);
</script>

<svelte:head><title>Claude Usage</title></svelte:head>

<h1 class="sr">Usage</h1>

{#if snap.accounts.length === 0}
	<div class="card empty">
		<p class="title">Claude usage</p>
		<p>No accounts yet.</p>
		<a href="/">Add an account</a>
	</div>
{:else}
	{#if needing.length}
		<div class="attention" role="alert" data-testid="needs-login">
			<strong>{needing.length} {needing.length === 1 ? 'account needs' : 'accounts need'} login:</strong>
			{#each needing as a, i (a.id)}
				{#if i > 0}{', '}{/if}<a href="/?relogin={encodeURIComponent(a.id)}">{a.name}</a>
			{/each}
		</div>
	{/if}

	<p class="summary" data-testid="best">
		{#if best}
			<span class="tag">Best to use now</span>
			<strong>{best.name}</strong>
			<span class="muted">
				&middot; {ui.hourlyLabel} {over(best.usage?.session) ? 'has reset' : `${pctText(best.usage?.session?.percentage)} used`}, {ui.weeklyLabel.toLowerCase()} {over(best.usage?.weekly) ? 'has reset' : pctText(best.usage?.weekly?.percentage)}
			</span>
		{:else if allBlocked}
			<span class="tag full">All at their limit</span>
			{#if nextFree}<span class="muted">next account frees up in {resetsIn(nextFree, now, true)}</span>{/if}
		{:else if onlyOld}
			<span class="tag none">No current reading</span>
			<span class="muted">the last readings failed or are out of date</span>
		{:else}
			<span class="tag none">No usage data yet</span>
			<span class="muted">{snap.mode === 'server' ? 'the server has not polled these accounts yet' : 'the widget has not polled these accounts'}</span>
		{/if}
	</p>

	<div class="card">
		<div class="cardhead">
			<p class="title">{cardTitle}</p>
			<div class="headright">
				<p class="updated" class:stale>
					{#if updated}updated {updated.toLocaleTimeString()}{#if now - updated.getTime() > 600_000}&nbsp;({ago(snap.usageUpdatedUnix!, now)} ago){/if}{:else}{snap.mode === 'server' ? 'not polled yet' : 'no widget data yet'}{/if}
					{#if stale}&middot; server unreachable{/if}
				</p>
				{#if snap.mode === 'server'}
					<button class="k-btn primary" type="button" disabled={refreshing || waitLeft > 0} onclick={refreshNow} data-testid="refresh-all">
						{refreshing ? 'Refreshing...' : waitLeft > 0 ? `Refresh in ${waitLeft}s` : 'Refresh now'}
					</button>
				{/if}
			</div>
		</div>
		{#if notice}<p class="notice" class:bad={!notice.ok} role="status" data-testid="refresh-notice">{notice.text}</p>{/if}
		<ul>
			{#each snap.accounts as a (a.id)}
				{@const login = needsLogin(a.status.state)}
				{@const blocked = !login && isBlocked(a)}
				{@const old = !login && isOld(a)}
				<li class:off={!a.enabled} class:blocked class:login class:best={best?.id === a.id} data-account={a.id}>
					<div class="who">
						<span class="name">{a.name}</span>
						{#if a.provider === 'codex'}<span class="ptag" data-testid="codex-tag">Codex</span>{/if}
						{#if login}<span class="pill" data-testid="status-badge">{badgeText(a.status.state)}</span>{/if}
						{#if blocked}<span class="pill">blocked</span>{/if}
						{#if !a.enabled}<span class="pill dim">hidden on widget</span>{/if}
						<span class="email">{a.email ?? 'not logged in'}</span>
					</div>
					{#if login}
						<div class="relogin">
							<a class="btn" href="/?relogin={encodeURIComponent(a.id)}">Re-login</a>
							<span class="small">{a.email ? 'Last known usage hidden: it may be out of date.' : a.status.message}</span>
						</div>
					{:else if a.email}
						<!-- a hidden row is dimmed as a whole already -->
						<div class="bars" class:old={old && a.enabled}>
							<UsageBar label={ui.hourlyLabel} title="{ui.hourlyLabel} (5-hour window)" pct={a.usage?.session?.percentage} resetsAt={a.usage?.session?.resetsAt} {now} seconds warnAt={ui.warnAt} highAt={ui.highAt} />
							<UsageBar label={ui.weeklyLabel} title="{ui.weeklyLabel} (7-day window)" pct={a.usage?.weekly?.percentage} resetsAt={a.usage?.weekly?.resetsAt} {now} seconds warnAt={ui.warnAt} highAt={ui.highAt} />
						</div>

						{#each (a.usage?.models ?? []).filter((m) => windowFull(m, now)) as m (m.label)}
							<p class="error full" data-testid="model-limit">{m.label} limit reached{m.resetsAt ? `, resets in ${resetsIn(m.resetsAt, now)}` : ''}. Other models still work.</p>
						{/each}
						{#if a.status.state === 'error'}<p class="error" data-testid="status-error">{a.status.message}</p>{/if}
						{#if old}<p class="error" data-testid="old-reading">Last read {ago(a.usageReadUnix!, now)} ago{a.enabled ? '' : ' (hidden accounts are not read)'}. These numbers may be out of date.</p>{/if}
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
	.summary {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.3rem 0.5rem;
		margin: 0.5rem 0 1rem;
		font-size: 1rem;
	}
	.tag {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		background: var(--green);
		color: var(--tag-text);
	}
	.tag.full {
		background: var(--red);
	}
	.tag.none {
		background: var(--muted);
	}
	.muted {
		color: var(--muted);
	}
	.small {
		font-size: 0.85rem;
		margin: 0;
	}
	/* The widget-style card: follows the page theme (dark like the widget, or light). */
	.card {
		--muted: var(--card-muted);
		--track: var(--card-track);
		--green: var(--card-green);
		--amber: var(--card-amber);
		--red: var(--card-red);
		background: var(--card-bg);
		color: var(--card-text);
		border: 1px solid var(--card-border);
		border-radius: var(--radius);
		padding: 0.75rem 1rem;
		box-shadow: var(--card-shadow);
	}
	.headright {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.4rem 0.75rem;
	}
	.notice {
		margin: 0.5rem 0 0;
		padding: 0.4rem 0.6rem;
		border: 1px solid var(--ok-border);
		border-radius: calc(var(--radius) * 0.8);
		background: var(--ok-bg);
		color: var(--text);
		font-size: 0.8125rem;
	}
	.notice.bad {
		border-color: var(--warn-border);
		background: var(--warn-bg);
	}

	.card a {
		color: var(--card-link);
	}
	.cardhead {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.title {
		margin: 0;
		font-family: 'Noto Sans Variable', 'Noto Sans', system-ui, sans-serif;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--card-text);
	}
	.updated {
		margin: 0;
		font-size: 0.75rem;
		color: var(--card-muted);
	}
	.updated.stale {
		color: var(--card-amber);
	}
	ul {
		list-style: none;
		margin: 0.4rem 0 0;
		padding: 0;
	}
	li {
		display: grid;
		grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr);
		gap: 0.4rem 1rem;
		align-items: center;
		padding: 0.6rem 0;
		border-top: 1px solid var(--card-divider);
	}
	li:first-child {
		border-top: 0;
	}
	li.off {
		opacity: 0.55;
	}
	li.best .name::after {
		content: ' \2605';
		color: var(--card-green);
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.1rem 0.4rem;
		min-width: 0;
	}
	.name {
		font-weight: 600;
		font-size: 0.95rem;
	}
	.email {
		width: 100%;
		font-size: 0.75rem;
		color: var(--card-muted);
		overflow-wrap: anywhere;
	}
	.pill {
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 0 0.4rem;
		border-radius: 999px;
		background: var(--card-red);
		color: var(--card-pill-text);
	}
	.ptag {
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.03em;
		padding: 0 0.4rem;
		border-radius: 4px;
		background: var(--codex-bg);
		color: var(--codex-text);
		border: 1px solid var(--codex-border);
	}
	.pill.dim {
		background: var(--card-track);
		color: var(--card-text);
	}
	li.blocked {
		box-shadow: inset 3px 0 0 var(--card-red);
		padding-left: 0.6rem;
	}
	.bars {
		display: grid;
		gap: 0.3rem;
		min-width: 0;
	}
	.bars.old {
		opacity: 0.55;
	}
	.error.full {
		color: var(--card-red);
		font-weight: 600;
	}
	.error {
		grid-column: 1 / -1;
		margin: 0;
		font-size: 0.75rem;
		color: var(--card-amber);
	}
	.attention {
		background: var(--err-bg);
		border: 1px solid var(--err-border);
		border-radius: var(--radius);
		padding: 0.6rem 0.8rem;
		margin: 0.5rem 0 0.75rem;
	}
	.attention a {
		color: var(--text);
		font-weight: 600;
	}
	li.login {
		box-shadow: inset 3px 0 0 var(--card-red);
		padding-left: 0.6rem;
	}
	.relogin {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem 0.75rem;
		color: var(--card-muted);
	}
	.relogin .small {
		font-size: 0.8rem;
	}
	.card a.btn {
		display: inline-block;
		padding: 0.3rem 0.9rem;
		border-radius: calc(var(--radius) * 0.8);
		background: var(--card-red);
		color: var(--card-pill-text);
		font-weight: 600;
		text-decoration: none;
	}
	.empty {
		text-align: center;
		padding: 1.5rem;
	}
	.empty p {
		margin: 0.25rem 0 0.75rem;
	}
	@media (max-width: 600px) {
		li {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
