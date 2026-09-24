<script lang="ts">
	import { post } from '$lib/format';

	let { data } = $props();

	interface Token {
		id: string;
		name: string;
		created_at: string;
		last_used_at: string | null;
	}
	// svelte-ignore state_referenced_locally
	let tokens = $state<Token[]>(data.tokens);
	let name = $state('');
	let busy = $state(false);
	let error = $state('');
	let created = $state<{ name: string; token: string } | null>(null);
	let copied = $state(false);

	async function refresh() {
		try {
			const r = await fetch('/api/tokens');
			if (r.ok) tokens = (await r.json()).tokens;
		} catch {
			/* keep the list */
		}
	}

	async function create(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			const r = await post<{ id: string; name: string; token: string }>('/api/tokens', { name });
			created = { name: r.name, token: r.token };
			copied = false;
			name = '';
		} catch (err) {
			error = (err as Error).message;
		}
		busy = false;
		await refresh();
	}

	async function revoke(t: Token) {
		error = '';
		try {
			const r = await fetch(`/api/tokens/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
			if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `Request failed (${r.status})`);
		} catch (err) {
			error = (err as Error).message;
		}
		await refresh();
	}

	async function copy() {
		if (!created) return;
		try {
			await navigator.clipboard.writeText(created.token);
			copied = true;
		} catch {
			copied = false;
		}
	}

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
</script>

<svelte:head><title>Widget tokens - Claude Account Manager</title></svelte:head>

<h1>Widget tokens</h1>
<p class="hint">
	A desktop widget reads accounts and usage from this server with a token. In the widget's <code>settings.json</code>, set
	<code>remote_server_url</code> to <code>{data.origin}</code> and <code>remote_server_token</code> to the token.
</p>

<form class="line" onsubmit={create}>
	<label class="sr" for="token-name">Token name</label>
	<input id="token-name" bind:value={name} placeholder="Name, e.g. office-pc" maxlength="40" autocomplete="off" />
	<button class="primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating...' : 'Create token'}</button>
</form>
{#if error}<p class="err" role="alert">{error}</p>{/if}

{#if created}
	<div class="ok" role="status" data-testid="new-token">
		<p><strong>Token for "{created.name}"</strong>. Copy it now: it is not shown again.</p>
		<div class="line">
			<input class="mono" readonly value={created.token} aria-label="New token" onfocus={(e) => e.currentTarget.select()} />
			<button type="button" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
			<button type="button" onclick={() => (created = null)}>Done</button>
		</div>
	</div>
{/if}

{#if tokens.length === 0}
	<p class="empty">No tokens yet.</p>
{:else}
	<ul class="list">
		{#each tokens as t (t.id)}
			<li data-token={t.name}>
				<div>
					<span class="name">{t.name}</span>
					<span class="meta">created {when(t.created_at)} &middot; last used {when(t.last_used_at)}</span>
				</div>
				<button type="button" class="danger" onclick={() => revoke(t)}>Revoke</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	h1 {
		font-size: 1.35rem;
		margin: 0.25rem 0 0.5rem;
	}
	.hint {
		color: var(--muted);
		font-size: 0.9rem;
	}
	code {
		overflow-wrap: anywhere;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
	}
	.line {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.line input {
		flex: 1 1 14rem;
		min-width: 0;
	}
	input {
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
	}
	.mono {
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 0.85rem;
	}
	button {
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-text);
	}
	button.danger {
		color: var(--red);
	}
	.err,
	.ok {
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
		margin: 0.75rem 0 0;
		overflow-wrap: anywhere;
	}
	.ok p {
		margin: 0 0 0.5rem;
	}
	.err {
		background: var(--err-bg);
		border: 1px solid var(--err-border);
	}
	.ok {
		background: var(--ok-bg);
		border: 1px solid var(--ok-border);
	}
	.empty {
		color: var(--muted);
		padding: 1.25rem;
		text-align: center;
		border: 1px dashed var(--border);
		border-radius: 10px;
		margin-top: 1rem;
	}
	.list {
		list-style: none;
		padding: 0;
		margin: 1rem 0;
		display: grid;
		gap: 0.5rem;
	}
	.list li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.6rem 0.9rem;
	}
	.name {
		font-weight: 600;
		margin-right: 0.5rem;
	}
	.meta {
		color: var(--muted);
		font-size: 0.8rem;
	}
</style>
