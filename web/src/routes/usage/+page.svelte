<script lang="ts">
	import { onMount } from 'svelte';
	import UsageBar from '$lib/UsageBar.svelte';
	import { needsLogin, pctText, resetsIn } from '$lib/format';
	import type { Snapshot } from '$lib/server/api';

	let { data } = $props();

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
		const poll = setInterval(refresh, 15_000);
		return () => {
			clearInterval(tick);
			clearInterval(poll);
		};
	});

	/** Accounts whose numbers can be trusted right now (logged in, login not expired). */
	const loggedIn = $derived(snap.accounts.filter((a) => a.email && !needsLogin(a.status.state)));
	const needing = $derived(snap.accounts.filter((a) => needsLogin(a.status.state)));
	const badgeText = (state: string) => (state === 'expired' ? 'Expired — log in again' : 'Not logged in');

	/** Most room right now: lowest 5h % among accounts whose weekly is under 100 and 5h under 100. */
	const best = $derived.by(() => {
		const usable = loggedIn.filter(
			(a) =>
				a.usage?.session && a.usage?.weekly && a.usage.weekly.percentage < 100 && a.usage.session.percentage < 100
		);
		usable.sort((x, y) => x.usage!.session!.percentage - y.usage!.session!.percentage);
		return usable[0] ?? null;
	});

	/** When nothing is usable: the soonest moment any blocked account frees up. */
	const nextFree = $derived.by(() => {
		let soonest: number | null = null;
		for (const a of loggedIn) {
			const u = a.usage;
			if (!u) continue;
			const blockers = [u.session, u.weekly].filter((w) => w && w.percentage >= 100 && w.resetsAt);
			if (!blockers.length) continue;
			const freeAt = Math.max(...blockers.map((w) => w!.resetsAt!));
			if (soonest === null || freeAt < soonest) soonest = freeAt;
		}
		return soonest;
	});

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
				&middot; 5h {pctText(best.usage?.session?.percentage)} used, weekly {pctText(best.usage?.weekly?.percentage)}
			</span>
		{:else if nextFree}
			<span class="tag full">All at their limit</span>
			<span class="muted">next account frees up in {resetsIn(nextFree, now, true)}</span>
		{:else}
			<span class="tag none">No usage data yet</span>
			<span class="muted">{snap.mode === 'server' ? 'the server has not polled these accounts yet' : 'the widget has not polled these accounts'}</span>
		{/if}
	</p>

	<div class="card">
		<div class="cardhead">
			<p class="title">Claude usage</p>
			<p class="updated" class:stale>
				{#if updated}updated {updated.toLocaleTimeString()}{:else}{snap.mode === 'server' ? 'not polled yet' : 'no widget data yet'}{/if}
				{#if stale}&middot; server unreachable{/if}
			</p>
		</div>
		<ul>
			{#each snap.accounts as a (a.id)}
				{@const login = needsLogin(a.status.state)}
				{@const blocked = !login && ((a.usage?.session?.percentage ?? 0) >= 100 || (a.usage?.weekly?.percentage ?? 0) >= 100)}
				<li class:off={!a.enabled} class:blocked class:login class:best={best?.id === a.id} data-account={a.id}>
					<div class="who">
						<span class="name">{a.name}</span>
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
						<div class="bars">
							<UsageBar label="5h" title="5-hour session" pct={a.usage?.session?.percentage} resetsAt={a.usage?.session?.resetsAt} {now} seconds />
							<UsageBar label="7d" title="Weekly" pct={a.usage?.weekly?.percentage} resetsAt={a.usage?.weekly?.resetsAt} {now} seconds />
						</div>
						{#if a.status.state === 'error'}<p class="error" data-testid="status-error">{a.status.message}</p>{/if}
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
		border-radius: 10px;
		padding: 10px 14px 12px;
		box-shadow: var(--card-shadow);
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
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--card-muted);
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
		grid-template-columns: minmax(7rem, 11rem) 1fr;
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
	.error {
		grid-column: 1 / -1;
		margin: 0;
		font-size: 0.75rem;
		color: var(--card-amber);
	}
	.attention {
		background: var(--err-bg);
		border: 1px solid var(--err-border);
		border-radius: 8px;
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
		border-radius: 6px;
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
			grid-template-columns: 1fr;
		}
	}
</style>
