<script lang="ts">
	import { onMount } from 'svelte';
	import UsageBar from '$lib/UsageBar.svelte';
	import LoginPanel, { type LoginInfo } from '$lib/LoginPanel.svelte';
	import { post } from '$lib/format';
	import type { Snapshot } from '$lib/server/api';

	let { data } = $props();

	// svelte-ignore state_referenced_locally
	let snap = $state<Snapshot>(data.snap);
	let now = $state(Date.now());
	let newName = $state('');
	let starting = $state(false);
	let addError = $state('');
	let login = $state<LoginInfo | null>(null);
	let notice = $state('');
	let widgetBusy = $state(false);
	let widgetMsg = $state('');
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let rowError = $state<Record<string, string>>({});
	let removeTarget = $state<Snapshot['accounts'][number] | null>(null);
	let removeDialog: HTMLDialogElement | undefined = $state();

	async function refresh() {
		try {
			const res = await fetch('/api/accounts');
			if (res.ok) snap = await res.json();
		} catch {
			/* server briefly unreachable: keep the last snapshot */
		}
		now = Date.now();
	}

	onMount(() => {
		const t = setInterval(refresh, 15_000);
		return () => clearInterval(t);
	});

	async function addAccount(e: SubmitEvent) {
		e.preventDefault();
		addError = '';
		notice = '';
		starting = true;
		try {
			const r = await post<{ account: { id: string; name: string }; login: Omit<LoginInfo, 'accountId' | 'accountName'> }>(
				'/api/accounts',
				{ name: newName }
			);
			login = { accountId: r.account.id, accountName: r.account.name, ...r.login };
			newName = '';
		} catch (err) {
			addError = (err as Error).message;
		} finally {
			starting = false;
			await refresh();
		}
	}

	async function relogin(id: string) {
		const acc = snap.accounts.find((a) => a.id === id);
		rowError = { ...rowError, [id]: '' };
		login = null;
		starting = true;
		try {
			const r = await post<{ account: { id: string; name: string }; login: Omit<LoginInfo, 'accountId' | 'accountName'> }>(
				`/api/accounts/${encodeURIComponent(id)}`,
				{ action: 'relogin' }
			);
			login = { accountId: r.account.id, accountName: r.account.name, ...r.login };
		} catch (err) {
			rowError = { ...rowError, [id]: (err as Error).message };
			if (!acc) addError = (err as Error).message;
		} finally {
			starting = false;
			await refresh();
		}
	}

	async function act(id: string, payload: Record<string, unknown>) {
		rowError = { ...rowError, [id]: '' };
		try {
			await post(`/api/accounts/${encodeURIComponent(id)}`, payload);
		} catch (err) {
			rowError = { ...rowError, [id]: (err as Error).message };
		}
		await refresh();
	}

	function startRename(a: Snapshot['accounts'][number]) {
		renamingId = a.id;
		renameValue = a.name;
	}

	async function saveRename(e: SubmitEvent, id: string) {
		e.preventDefault();
		await act(id, { action: 'rename', name: renameValue });
		if (!rowError[id]) renamingId = null;
	}

	function askRemove(a: Snapshot['accounts'][number]) {
		removeTarget = a;
		removeDialog?.showModal();
	}

	async function confirmRemove() {
		const a = removeTarget;
		removeDialog?.close();
		if (!a) return;
		try {
			const r = await post<{ folderDeleted: boolean; folderNote: string; folder: string }>(
				`/api/accounts/${encodeURIComponent(a.id)}`,
				{ action: 'remove' }
			);
			notice = r.folderDeleted
				? `Removed "${a.name}" and deleted ${r.folder}.`
				: `Removed "${a.name}". ${r.folderNote}`;
			if (login?.accountId === a.id) login = null;
		} catch (err) {
			rowError = { ...rowError, [a.id]: (err as Error).message };
		}
		removeTarget = null;
		await refresh();
	}

	let themeMsg = $state('');
	async function setCardTheme(value: string) {
		themeMsg = '';
		try {
			await post('/api/settings', { cardTheme: value });
			themeMsg = 'Saved. The widget picks it up within 5 seconds (or after Restart widget).';
		} catch (err) {
			themeMsg = (err as Error).message;
		}
		await refresh();
	}

	async function restartWidget() {
		widgetBusy = true;
		widgetMsg = '';
		try {
			const r = await post<{ wasRunning: boolean }>('/api/widget/restart');
			widgetMsg = r.wasRunning ? 'Widget restarted.' : 'Widget started.';
		} catch (err) {
			widgetMsg = (err as Error).message;
		}
		widgetBusy = false;
		setTimeout(refresh, 1500);
	}
</script>

<svelte:head><title>Claude Account Manager</title></svelte:head>

<section class="add">
	<h1>Accounts</h1>
	<form onsubmit={addAccount} class="addform">
		<label for="new-name">Add an account</label>
		<div class="line">
			<input
				id="new-name"
				bind:value={newName}
				placeholder="Name shown on the widget, e.g. work"
				maxlength="24"
				autocomplete="off"
				disabled={starting}
			/>
			<button class="primary" type="submit" disabled={starting || !newName.trim()}>
				{starting ? 'Starting...' : 'Start'}
			</button>
		</div>
		<p class="hint">Start opens a private Edge window for the login. Then you only paste the code.</p>
		{#if addError}<p class="err" role="alert">{addError}</p>{/if}
	</form>
</section>

{#if login}
	{#key login.sessionId}
		<LoginPanel {login} onrelogin={relogin} onclose={() => (login = null)} onchanged={refresh} />
	{/key}
{/if}

{#if notice}<p class="ok" role="status">{notice}</p>{/if}

{#if snap.accounts.length === 0}
	<p class="empty">No accounts yet. Add one above.</p>
{:else}
	<ul class="list">
		{#each snap.accounts as a, i (a.id)}
			<li class="acc" class:off={!a.enabled}>
				<div class="head">
					{#if renamingId === a.id}
						<form class="rename" onsubmit={(e) => saveRename(e, a.id)}>
							<input aria-label="New name" bind:value={renameValue} maxlength="24" />
							<button class="primary" type="submit">Save</button>
							<button type="button" onclick={() => (renamingId = null)}>Cancel</button>
						</form>
					{:else}
						<div class="who">
							<span class="name">{a.name}</span>
							{#if a.plan}<span class="plan">{a.plan}</span>{/if}
							<span class="email">{a.email ?? 'Not logged in'}</span>
						</div>
					{/if}
					<label class="toggle" title="Show on the widget">
						<input
							type="checkbox"
							checked={a.enabled}
							onchange={(e) => act(a.id, { action: 'enable', enabled: e.currentTarget.checked })}
						/>
						<span>{a.enabled ? 'On widget' : 'Hidden'}</span>
					</label>
				</div>

				{#if a.sameEmailAs.length}
					<p class="warn">
						Same email as {a.sameEmailAs.join(', ')}. One of them was logged in with an already signed-in browser.
						<button type="button" onclick={() => relogin(a.id)}>Re-login</button>
					</p>
				{/if}

				{#if a.email}
					<div class="bars">
						<UsageBar label="5h" title="5-hour session" pct={a.usage?.session?.percentage} resetsAt={a.usage?.session?.resetsAt} {now} />
						<UsageBar label="7d" title="Weekly" pct={a.usage?.weekly?.percentage} resetsAt={a.usage?.weekly?.resetsAt} {now} />
					</div>
				{/if}

				<div class="tools">
					<button type="button" aria-label="Move {a.name} up" disabled={i === 0} onclick={() => act(a.id, { action: 'move', direction: 'up' })}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
					<button
						type="button"
						aria-label="Move {a.name} down"
						disabled={i === snap.accounts.length - 1}
						onclick={() => act(a.id, { action: 'move', direction: 'down' })}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 6l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button
					>
					<button type="button" onclick={() => startRename(a)}>Rename</button>
					<button type="button" class:primary={!a.email} onclick={() => relogin(a.id)} disabled={starting}>
						{a.email ? 'Re-login' : 'Log in'}
					</button>
					<button type="button" class="danger" onclick={() => askRemove(a)}>Remove</button>
				</div>
				{#if rowError[a.id]}<p class="err" role="alert">{rowError[a.id]}</p>{/if}
			</li>
		{/each}
	</ul>
{/if}

<section class="widget">
	<div>
		<strong>Desktop widget</strong>
		<span class="hint">
			{#if !snap.widget.installed}not installed{:else if snap.widget.running}running{:else}not running{/if}
			&middot; usage updated {snap.usageUpdatedUnix ? new Date(snap.usageUpdatedUnix * 1000).toLocaleTimeString() : 'never'}
		</span>
	</div>
	<button type="button" onclick={restartWidget} disabled={widgetBusy || !snap.widget.installed}>
		{widgetBusy ? 'Restarting...' : 'Restart widget'}
	</button>
	{#if widgetMsg}<span class="hint" role="status">{widgetMsg}</span>{/if}
	<label class="cardtheme">
		<span>Card theme</span>
		<select value={snap.cardTheme} onchange={(e) => setCardTheme(e.currentTarget.value)}>
			<option value="auto">Auto (follow Windows)</option>
			<option value="light">Light</option>
			<option value="dark">Dark</option>
		</select>
	</label>
	{#if themeMsg}<span class="hint" role="status">{themeMsg}</span>{/if}
</section>

<dialog bind:this={removeDialog} aria-labelledby="rm-title">
	{#if removeTarget}
		<h2 id="rm-title">Remove "{removeTarget.name}"?</h2>
		<p>It disappears from the widget, and its folder is deleted:</p>
		<p><code>{removeTarget.configDir}</code></p>
		<p class="hint">That folder holds this account's Claude Code login and history. Your main <code>.claude</code> folder is never touched.</p>
		<div class="line end">
			<button type="button" onclick={() => removeDialog?.close()}>Cancel</button>
			<button type="button" class="danger solid" onclick={confirmRemove}>Remove and delete folder</button>
		</div>
	{/if}
</dialog>

<style>
	h1 {
		font-size: 1.35rem;
		margin: 0.25rem 0 0.75rem;
	}
	.addform label {
		display: block;
		font-weight: 600;
		margin-bottom: 0.25rem;
	}
	.line {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.line.end {
		justify-content: flex-end;
	}
	.line input {
		flex: 1 1 14rem;
		min-width: 0;
	}
	input:not([type='checkbox']) {
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
	}
	button {
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	button svg {
		display: block;
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
	button.danger.solid {
		background: var(--danger-solid);
		border-color: var(--danger-solid);
		color: #fff;
	}
	.hint {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 0.35rem 0 0;
	}
	.empty {
		color: var(--muted);
		padding: 1.5rem;
		text-align: center;
		border: 1px dashed var(--border);
		border-radius: 10px;
	}
	.list {
		list-style: none;
		padding: 0;
		margin: 1rem 0;
		display: grid;
		gap: 0.75rem;
	}
	.acc {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 0.8rem 1rem;
		display: grid;
		gap: 0.6rem;
	}
	.acc.off {
		opacity: 0.7;
	}
	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.6rem;
		min-width: 0;
	}
	.name {
		font-weight: 600;
		font-size: 1.05rem;
	}
	.plan {
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0 0.45rem;
		color: var(--muted);
	}
	.email {
		color: var(--muted);
		font-size: 0.875rem;
		overflow-wrap: anywhere;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
		color: var(--muted);
		cursor: pointer;
	}
	.bars {
		display: grid;
		gap: 0.35rem;
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.rename {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.err,
	.warn,
	.ok {
		border-radius: 6px;
		padding: 0.55rem 0.75rem;
		margin: 0.5rem 0 0;
		overflow-wrap: anywhere;
	}
	.err {
		background: var(--err-bg);
		border: 1px solid var(--err-border);
	}
	.warn {
		background: var(--warn-bg);
		border: 1px solid var(--warn-border);
		margin: 0;
	}
	.ok {
		background: var(--ok-bg);
		border: 1px solid var(--ok-border);
	}
	.widget {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		justify-content: space-between;
		border-top: 1px solid var(--border);
		padding-top: 1rem;
		margin-top: 1.5rem;
	}
	.cardtheme {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-basis: 100%;
	}
	.cardtheme span {
		font-weight: 600;
	}
	select {
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
	}
	.widget .hint {
		margin-left: 0.4rem;
	}
	dialog {
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--surface);
		color: var(--text);
		max-width: min(30rem, calc(100vw - 32px));
		padding: 1.1rem;
	}
	dialog::backdrop {
		background: rgb(0 0 0 / 0.45);
	}
	dialog h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}
	code {
		overflow-wrap: anywhere;
	}
</style>
