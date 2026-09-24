<script module lang="ts">
	export interface LoginInfo {
		accountId: string;
		accountName: string;
		sessionId: string;
		url: string;
		edgeOpened: boolean;
	}
</script>

<script lang="ts">
	import { post } from './format';

	interface Props {
		login: LoginInfo;
		onrelogin: (accountId: string) => void;
		onclose: () => void;
		onchanged: () => void;
		/** Server mode: nothing opens a browser; the user opens the link on their own device. */
		server?: boolean;
	}
	let { login, onrelogin, onclose, onchanged, server = false }: Props = $props();

	type Phase = 'waiting' | 'connecting' | 'done' | 'failed';
	let phase = $state<Phase>('waiting');
	let code = $state('');
	let error = $state('');
	let email = $state('');
	let plan = $state('');
	let sameEmailAs = $state<string[]>([]);
	let copied = $state(false);

	async function connect(e: SubmitEvent) {
		e.preventDefault();
		if (!code.trim()) {
			error = 'Paste the code first.';
			return;
		}
		phase = 'connecting';
		error = '';
		try {
			const r = await post<{ ok: boolean; error?: string; email: string; plan: string | null; sameEmailAs: string[] }>(
				'/api/login/code',
				{ sessionId: login.sessionId, code }
			);
			if (!r.ok) throw new Error(r.error || 'Login failed.');
			email = r.email;
			plan = r.plan ?? '';
			sameEmailAs = r.sameEmailAs ?? [];
			phase = 'done';
		} catch (err) {
			error = (err as Error).message;
			phase = 'failed';
		}
		onchanged();
	}

	async function cancel() {
		try {
			await post('/api/login/cancel', { sessionId: login.sessionId });
		} catch {
			/* nothing to cancel */
		}
		onchanged();
		onclose();
	}

	async function copyLink() {
		try {
			await navigator.clipboard.writeText(login.url);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			copied = false;
		}
	}
</script>

<section class="panel" aria-live="polite" data-testid="login-panel">
	<h2>Log in "{login.accountName}"</h2>

	{#if phase === 'waiting' || phase === 'connecting'}
		{#if server}
			<ol class="steps">
				<li>
					Open the sign-in page in your browser. Use a <strong>private window</strong> (or one signed in to nothing),
					otherwise it may sign this account in as whoever is already signed in.
					<div class="line link">
						<a class="btn primary" href={login.url} target="_blank" rel="noopener noreferrer" data-testid="signin-link">Open sign-in page</a>
						<button type="button" onclick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
					</div>
				</li>
				<li>Sign in as <strong>{login.accountName}</strong>, click <em>Authorize</em>, copy the code.</li>
				<li>Paste it here.</li>
			</ol>
		{:else}
		<ol class="steps">
			<li>
				{#if login.edgeOpened}
					A private Edge window opened. It shares no sign-in with anything else.
				{:else}
					Edge was not found. Open the link below in a <strong>private window signed in to nothing</strong>.
				{/if}
			</li>
			<li>Sign in as <strong>{login.accountName}</strong>, click <em>Authorize</em>, copy the code.</li>
			<li>Paste it here.</li>
		</ol>
		{/if}

		<form class="code" onsubmit={connect}>
			<label for="code">Authentication code</label>
			<div class="line">
				<input
					id="code"
					bind:value={code}
					autocomplete="off"
					spellcheck="false"
					placeholder="Paste the code"
					disabled={phase === 'connecting'}
				/>
				<button class="primary" type="submit" disabled={phase === 'connecting'}>
					{phase === 'connecting' ? 'Connecting...' : 'Connect'}
				</button>
			</div>
			{#if phase === 'connecting'}<p class="hint">Claude Code is checking the code (up to 60 seconds).</p>{/if}
			{#if error}<p class="err" role="alert">{error}</p>{/if}
		</form>

		{#if !server}
		<details class="fallback">
			<summary>Edge window didn't open?</summary>
			<p class="hint">
				Open this link in a private window that is signed in to nothing. A normal window that is already
				signed in will log this folder in as that account.
			</p>
			<div class="line">
				<a class="btn" href={login.url} target="_blank" rel="noopener noreferrer">Open link</a>
				<button type="button" onclick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
			</div>
		</details>
		{/if}

		<div class="actions">
			<button type="button" onclick={cancel} disabled={phase === 'connecting'}>Cancel</button>
		</div>
	{:else if phase === 'done'}
		<p class="ok" data-testid="login-ok">
			Logged in as <strong>{email}</strong>{#if plan}&nbsp;({plan}){/if}.
		</p>
		{#if sameEmailAs.length}
			<div class="warn" role="alert">
				<strong>This is the same email as {sameEmailAs.join(', ')}.</strong>
				The login window was probably already signed in, so this folder got that account too. Re-login and sign in
				as the right person.
				<div class="actions">
					<button class="primary" type="button" onclick={() => onrelogin(login.accountId)}>Re-login</button>
				</div>
			</div>
		{/if}
		<div class="actions"><button type="button" onclick={onclose}>Done</button></div>
	{:else}
		<p class="err" role="alert" data-testid="login-error">{error}</p>
		<div class="actions">
			<button class="primary" type="button" onclick={() => onrelogin(login.accountId)}>Try again</button>
			<button type="button" onclick={onclose}>Close</button>
		</div>
	{/if}
</section>

<style>
	.panel {
		border: 1px solid var(--accent);
		border-radius: 10px;
		background: var(--surface);
		padding: 1rem;
		margin: 1rem 0;
	}
	h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}
	.steps {
		margin: 0 0 0.75rem;
		padding-left: 1.25rem;
	}
	.code label {
		display: block;
		font-weight: 600;
		margin-bottom: 0.25rem;
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
		background: var(--bg);
		color: var(--text);
	}
	button,
	.btn {
		padding: 0.45rem 0.9rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
		text-decoration: none;
		display: inline-block;
	}
	.btn.primary,
	button.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--accent-text);
	}
	button:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.hint {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 0.4rem 0;
	}
	.link {
		margin: 0.4rem 0 0.2rem;
	}
	.fallback {
		margin-top: 0.75rem;
	}
	.fallback summary {
		cursor: pointer;
		color: var(--muted);
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
		flex-wrap: wrap;
	}
	.err,
	.warn,
	.ok {
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
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
	}
	.ok {
		background: var(--ok-bg);
		border: 1px solid var(--ok-border);
	}
</style>
