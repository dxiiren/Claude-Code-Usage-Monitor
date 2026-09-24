<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import ThemeSwitch from '$lib/ThemeSwitch.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<header class="top">
	<span class="brand">Claude Account Manager</span>
	<div class="right">
		<nav aria-label="Main">
			<a href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}>Accounts</a>
			<a href="/usage" aria-current={page.url.pathname === '/usage' ? 'page' : undefined}>Usage</a>
		</nav>
		<ThemeSwitch />
	</div>
</header>

<main>
	{@render children()}
</main>

<style>
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		padding: 0.75rem 16px;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
	}
	.brand {
		font-weight: 600;
	}
	.right {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
	}
	nav {
		display: flex;
		gap: 0.25rem;
	}
	nav a {
		color: var(--text);
		text-decoration: none;
		padding: 0.3rem 0.75rem;
		border-radius: 6px;
	}
	nav a:hover {
		background: var(--bg);
	}
	nav a[aria-current='page'] {
		background: var(--accent);
		color: var(--accent-text);
	}
	main {
		max-width: 860px;
		margin: 0 auto;
		padding: 1rem 16px 3rem;
	}
</style>
