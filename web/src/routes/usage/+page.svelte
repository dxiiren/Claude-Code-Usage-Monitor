<script lang="ts">
	import { onMount } from 'svelte';
	import UsageBar from '$lib/UsageBar.svelte';
	import { ago, needsLogin, pctText, post, readingOver, refreshSummary, resetsIn, windowFull } from '$lib/format';
	import { headlines, limitsOut as fullLimits, atLimit as accountAtLimit, onExtra as accountOnExtra } from '$lib/headline';
	import type { Snapshot } from '$lib/server/api';

	let { data } = $props();
	/** Names of the two windows, colour levels and refresh timing (Settings, server mode). */
	const ui = $derived(data.ui);

	// svelte-ignore state_referenced_locally
	let snap = $state<Snapshot>(data.snap);
	let now = $state(Date.now());
	let stale = $state(false);
	/** The server answered, but refused: this user may no longer open the screen. */
	let denied = $state(false);

	async function refresh() {
		try {
			const res = await fetch('/api/accounts');
			// signed out meanwhile (session ended, password reset): the sign-in page, not "unreachable"
			if (res.status === 401) return void location.assign('/login');
			denied = res.status === 403;
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
	// a hidden account is not read at all, so it does not belong in the "needs login" alert
	const needing = $derived(snap.accounts.filter((a) => a.enabled && needsLogin(a.status.state)));
	/** Signing an account in again happens on the Accounts screen: only users who have it get the links. */
	const canManage = $derived(data.menu.some((m) => m.id === 'accounts'));
	const badgeText = (st: { state: string; refused?: boolean }) =>
		st.state !== 'expired' ? 'Not logged in' : st.refused ? 'Login refused — log in again' : 'Expired — log in again';

	type Acc = Snapshot['accounts'][number];
	/** At a limit right now in either window (a window that has reset since no longer counts). */
	const atLimit = (a: Acc) => accountAtLimit(a, now);
	/** Past its limit but still working, on paid extra usage that has not run out. */
	const onExtra = (a: Acc) => accountOnExtra(a, now);
	/** At a limit with nothing to carry it further: it cannot be used until the limit resets. */
	const isBlocked = (a: Acc) => atLimit(a) && !onExtra(a);
	const money = (n: number) => n.toFixed(2);
	/** The last good reading is too old to describe the account (see staleAfterSeconds), or the widget marked it as carried over. */
	const isOld = (a: Acc) => a.usageStale || (snap.staleAfterSeconds !== null && a.usageReadUnix !== null && now / 1000 - a.usageReadUnix > snap.staleAfterSeconds);

	/** This window was read above zero and has reset since: its number is of a window that is over. */
	const over = (w: { percentage: number; resetsAt: number | null } | null | undefined) => readingOver(w?.percentage, w?.resetsAt, now);

	/** The limits next to the two windows that are used up right now: one model's own (the other models still work), or another allowance. */
	const limitsOut = (a: Acc) => fullLimits(a, now);
	const limitsOutText = (a: Acc) => {
		const models = limitsOut(a).filter((m) => !m.other).map((m) => m.label);
		const others = limitsOut(a).filter((m) => m.other).map((m) => m.label);
		return [models.length ? `${models.join(', ')} used up, other models still work` : '', others.length ? `${others.join(', ')} limit reached` : ''].filter(Boolean).join('; ');
	};
	/** One headline per provider: which account to use now, or why none can be named ($lib/headline). */
	const heads = $derived(headlines(snap.accounts, now, isOld));
	const bestIds = $derived(heads.flatMap((h) => (h.head.kind === 'best' ? [h.head.account.id] : [])));
	const names = (list: Acc[]) => list.map((a) => a.name).join(', ');

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
				{#if i > 0}{', '}{/if}{#if canManage}<a href="/?relogin={encodeURIComponent(a.id)}">{a.name}</a>{:else}{a.name}{/if}
			{/each}
			{#if !canManage}. Ask an administrator to sign {needing.length === 1 ? 'it' : 'them'} in again.{/if}
		</div>
	{/if}

	<div class="summary" data-testid="best">
		{#each heads as { provider, head } (provider)}
			<p class="headline" data-provider={provider}>
				{#if heads.length > 1}<span class="ptag">{provider === 'codex' ? 'Codex' : 'Claude'}</span>{/if}
				{#if head.kind === 'best'}
					{@const best = head.account}
					<span class="tag">Best to use now</span>
					<strong>{best.name}</strong>
					<span class="muted">
						&middot; {ui.hourlyLabel} {over(best.usage?.session) ? 'has reset' : `${pctText(best.usage?.session?.percentage)} used`}, {ui.weeklyLabel.toLowerCase()} {over(best.usage?.weekly) ? 'has reset' : pctText(best.usage?.weekly?.percentage)}{#if limitsOut(best).length}
							&middot; <b data-testid="best-models">{limitsOutText(best)}</b>{/if}
					</span>
				{:else if head.kind === 'extra'}
					<span class="tag paid">On paid extra usage only</span>
					<span class="muted">{names(head.accounts)} still {head.accounts.length === 1 ? 'works' : 'work'} on paid extra usage; no account is under its limit</span>
				{:else if head.kind === 'blocked'}
					<span class="tag full">{head.unknown ? 'None free right now' : 'All at their limit'}</span>
					<span class="muted">
						{#if head.unknown}{head.blocked} at {head.blocked === 1 ? 'its' : 'their'} limit, {head.unknown} without a current reading{/if}{#if head.unknown && head.nextFree}{' · '}{/if}{#if head.nextFree}next account frees up in {resetsIn(head.nextFree, now, true)}{/if}
					</span>
				{:else if head.kind === 'old'}
					<span class="tag none">No current reading</span>
					<span class="muted">the last readings failed or are out of date</span>
				{:else if head.why === 'hidden'}
					<span class="tag none">No account is read</span>
					<span class="muted">every account is hidden from the widget, and hidden accounts are not read</span>
				{:else if head.why === 'login'}
					<span class="tag none">No account to read</span>
					<span class="muted">every account needs a login first</span>
				{:else if head.why === 'failed'}
					<span class="tag none">No reading yet</span>
					<span class="muted">the readings so far have failed; the reason is with each account below</span>
				{:else}
					<span class="tag none">No usage data yet</span>
					<span class="muted">{snap.mode === 'server' ? 'the server has not polled these accounts yet' : 'the widget has not polled these accounts'}</span>
				{/if}
			</p>
		{/each}
	</div>

	<div class="card">
		<div class="cardhead">
			<p class="title">{cardTitle}</p>
			<div class="headright">
				<p class="updated" class:stale>
					{#if updated}updated {updated.toLocaleTimeString()}{#if now - updated.getTime() > 600_000}&nbsp;({ago(snap.usageUpdatedUnix!, now)} ago){/if}{:else}{snap.mode === 'server' ? 'not polled yet' : 'no widget data yet'}{/if}
					{#if denied}&middot; you can no longer open this screen{:else if stale}&middot; server unreachable{/if}
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
				<li class:off={!a.enabled} class:blocked class:login class:best={bestIds.includes(a.id)} data-account={a.id}>
					<div class="who">
						<span class="name">{a.name}</span>
						{#if a.provider === 'codex'}<span class="ptag" data-testid="codex-tag">Codex</span>{/if}
						{#if login}<span class="pill" data-testid="status-badge">{badgeText(a.status)}</span>{/if}
						{#if blocked}<span class="pill">blocked</span>{/if}
						{#if !login && onExtra(a)}<span class="pill extra" data-testid="extra-usage">extra usage</span>{/if}
						{#if !a.enabled}<span class="pill dim">hidden on widget</span>{/if}
						<span class="email">{a.email ?? 'not logged in'}</span>
					</div>
					{#if login}
						<div class="relogin">
							{#if canManage}<a class="btn" href="/?relogin={encodeURIComponent(a.id)}">Re-login</a>{/if}
							<span class="small">{a.email ? 'Last known usage hidden: it may be out of date.' : a.status.message}{canManage ? '' : ' Needs a new sign-in: ask an administrator.'}</span>
						</div>
					{:else if a.email}
						<!-- a hidden row is dimmed as a whole already -->
						<div class="bars" class:old={old && a.enabled}>
							<UsageBar label={ui.hourlyLabel} title="{ui.hourlyLabel} (5-hour window)" pct={a.usage?.session?.percentage} resetsAt={a.usage?.session?.resetsAt} {now} seconds warnAt={ui.warnAt} highAt={ui.highAt} />
							<UsageBar label={ui.weeklyLabel} title="{ui.weeklyLabel} (7-day window)" pct={a.usage?.weekly?.percentage} resetsAt={a.usage?.weekly?.resetsAt} {now} seconds warnAt={ui.warnAt} highAt={ui.highAt} />
						</div>

						{#each (a.usage?.models ?? []).filter((m) => windowFull(m, now)) as m (m.label)}
							<p class="error full" data-testid="model-limit">{m.label} limit reached{m.resetsAt ? `, resets in ${resetsIn(m.resetsAt, now)}` : ''}.{m.other || blocked ? '' : ' Other models still work.'}</p>
						{/each}
						{#if a.usage?.extra && atLimit(a)}
							<p class="error" data-testid="extra-line">
								{#if a.usage.extra.remaining > 0}Past its limit and still working on paid extra usage: {money(a.usage.extra.total - a.usage.extra.remaining)} of {money(a.usage.extra.total)} used.
								{:else}Its paid extra usage is used up as well ({money(a.usage.extra.total)}).{/if}
							</p>
						{/if}
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
		margin: 0.5rem 0 1rem;
	}
	.headline {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.3rem 0.5rem;
		margin: 0 0 0.35rem;
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
	.tag.paid {
		background: var(--amber);
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
	.pill.extra {
		background: var(--card-amber);
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
