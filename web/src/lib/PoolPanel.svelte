<script lang="ts">
	import { onMount } from 'svelte';
	import type { PoolSnapshot, Totals } from '$lib/server/pool';

	let pool = $state<PoolSnapshot | null>(null);
	let failed = $state(false);
	let range = $state<'today' | 'last7d'>('today');

	async function load() {
		try {
			const res = await fetch('/api/pool');
			if (!res.ok) throw new Error(String(res.status));
			pool = await res.json();
			failed = false;
		} catch {
			failed = true;
		}
	}
	onMount(() => {
		void load();
		const t = setInterval(load, 30_000);
		return () => clearInterval(t);
	});

	const win = $derived(pool ? pool[range] : null);
	const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
	const gate = (t: Totals) => (t.gatePassPct === null ? '-' : `${t.gatePassPct}%`);
	const wall = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);
	const cost = (c: number) => `$${c.toFixed(2)}`;
	const when = (ts: string | null) => (ts && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '-');
	const sorted = (g: Record<string, Totals>) => Object.entries(g).sort((a, b) => b[1].tasks - a[1].tasks);
</script>

<section class="pool" data-testid="pool-panel" aria-labelledby="pool-title">
	<div class="head">
		<h2 id="pool-title">LLM pool</h2>
		{#if pool?.off}<span class="off" data-testid="pool-off">pool OFF</span>{/if}
		{#if pool?.hasLedger}
			<span class="seg" role="group" aria-label="Range">
				<button type="button" class:on={range === 'today'} onclick={() => (range = 'today')}>Today</button>
				<button type="button" class:on={range === 'last7d'} onclick={() => (range = 'last7d')}>7 days</button>
			</span>
		{/if}
	</div>

	{#if failed && !pool}
		<p class="hint">Pool data unavailable.</p>
	{:else if !pool}
		<p class="hint">Loading...</p>
	{:else if !pool.hasLedger}
		<p class="hint" data-testid="pool-empty">no pool activity yet</p>
	{:else if win}
		<p class="sum" data-testid="pool-total">
			<strong>{win.total.tasks}</strong> tasks &middot; {k(win.total.tokensIn)} in / {k(win.total.tokensOut)} out / {k(win.total.tokensThinking)} thinking
			&middot; gate {gate(win.total)} &middot; {wall(win.total.wallSeconds)} &middot; {cost(win.total.costUsd)}
		</p>
		{#if win.total.tasks > 0}
			<div class="grids">
				<table>
					<thead><tr><th>Provider</th><th>Tasks</th><th>In</th><th>Out</th><th>Think</th><th>Gate</th><th>Time</th><th>Cost</th></tr></thead>
					<tbody>
						{#each sorted(win.byProvider) as [name, t] (name)}
							<tr><td>{name}</td><td>{t.tasks}</td><td>{k(t.tokensIn)}</td><td>{k(t.tokensOut)}</td><td>{k(t.tokensThinking)}</td><td>{gate(t)}</td><td>{wall(t.wallSeconds)}</td><td>{cost(t.costUsd)}</td></tr>
						{/each}
					</tbody>
				</table>
				<table>
					<thead><tr><th>Category</th><th>Tasks</th><th>In</th><th>Out</th><th>Think</th><th>Gate</th><th>Time</th><th>Cost</th></tr></thead>
					<tbody>
						{#each sorted(win.byCategory) as [name, t] (name)}
							<tr><td>{name}</td><td>{t.tasks}</td><td>{k(t.tokensIn)}</td><td>{k(t.tokensOut)}</td><td>{k(t.tokensThinking)}</td><td>{gate(t)}</td><td>{wall(t.wallSeconds)}</td><td>{cost(t.costUsd)}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="hint">No tasks in this range.</p>
		{/if}
		{#if pool.recent.length}
			<h3>Recent tasks</h3>
			<div class="scroll">
				<table data-testid="pool-recent">
					<thead><tr><th>When</th><th>Mode</th><th>Provider</th><th>Model</th><th>Category</th><th>Gate</th><th>In</th><th>Out</th><th>Time</th><th>Exit</th></tr></thead>
					<tbody>
						{#each pool.recent as r, i (i)}
							<tr title={r.error ?? ''}>
								<td>{when(r.ts)}</td><td>{r.mode ?? '-'}</td><td>{r.provider ?? '-'}</td><td>{r.model ?? '-'}</td><td>{r.category ?? '-'}</td>
								<td class:bad={r.gate === 'fail'}>{r.gate ?? '-'}</td><td>{k(r.tokensIn)}</td><td>{k(r.tokensOut)}</td><td>{wall(r.wallSeconds)}</td>
								<td class:bad={r.exit !== null && r.exit !== 0}>{r.exit ?? '-'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</section>

<style>
	.pool {
		border-top: 1px solid var(--border);
		padding-top: 1rem;
		margin-top: 1.5rem;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	h2 {
		font-size: 1.1rem;
		margin: 0;
	}
	h3 {
		font-size: 0.95rem;
		margin: 1rem 0 0.35rem;
	}
	.off {
		background: var(--err-bg);
		border: 1px solid var(--err-border);
		border-radius: calc(var(--radius) * 0.8);
		padding: 0.1rem 0.5rem;
		font-weight: 600;
		font-size: 0.85rem;
	}
	.seg {
		margin-left: auto;
		display: inline-flex;
	}
	.seg button {
		padding: 0.25rem 0.7rem;
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
	}
	.seg button.on {
		background: var(--accent);
		color: var(--accent-text);
		border-color: var(--accent);
	}
	.sum {
		margin: 0.6rem 0;
	}
	.grids {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(22rem, 1fr));
		gap: 1rem;
	}
	.grids,
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	th,
	td {
		text-align: left;
		padding: 0.25rem 0.5rem;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}
	th {
		color: var(--muted);
		font-weight: 600;
	}
	tbody tr:nth-child(even) {
		background: var(--zebra);
	}
	.bad {
		color: var(--red);
		font-weight: 600;
	}
	.hint {
		color: var(--muted);
	}
</style>
