<script lang="ts">
	import { onMount } from 'svelte';

	type Mode = 'auto' | 'light' | 'dark';
	const KEY = 'acctmgr-theme';
	const modes: { id: Mode; label: string }[] = [
		{ id: 'auto', label: 'Auto' },
		{ id: 'light', label: 'Light' },
		{ id: 'dark', label: 'Dark' }
	];

	let mode = $state<Mode>('auto');

	onMount(() => {
		const t = document.documentElement.getAttribute('data-theme');
		mode = t === 'light' || t === 'dark' ? t : 'auto';
	});

	function choose(m: Mode) {
		mode = m;
		if (m === 'auto') document.documentElement.removeAttribute('data-theme');
		else document.documentElement.setAttribute('data-theme', m);
		try {
			if (m === 'auto') localStorage.removeItem(KEY);
			else localStorage.setItem(KEY, m);
		} catch {
			/* storage blocked: the choice still applies to this page view */
		}
	}
</script>

<div class="seg" role="group" aria-label="Page theme">
	{#each modes as m (m.id)}
		<button type="button" aria-pressed={mode === m.id} onclick={() => choose(m.id)}>{m.label}</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	button {
		border: 0;
		background: transparent;
		color: var(--muted);
		padding: 0.25rem 0.6rem;
		font-size: 0.8rem;
		cursor: pointer;
	}
	button + button {
		border-left: 1px solid var(--border);
	}
	button[aria-pressed='true'] {
		background: var(--text);
		color: var(--bg);
	}
</style>
