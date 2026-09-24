<script lang="ts">
	let { form } = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Sign in - Claude Account Manager</title></svelte:head>

<section class="box">
	<h1>Sign in</h1>
	<p class="hint">This Account Manager runs on a server. Sign in with the admin account to manage accounts.</p>
	<form method="POST" onsubmit={() => (busy = true)}>
		<label for="username">Username</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus />
		<label for="password">Password</label>
		<input id="password" name="password" type="password" autocomplete="current-password" required />
		<button class="primary" type="submit" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
		{#if form?.error}<p class="err" role="alert">{form.error}</p>{/if}
	</form>
</section>

<style>
	.box {
		max-width: 22rem;
		margin: 3rem auto;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1.25rem;
	}
	h1 {
		font-size: 1.25rem;
		margin: 0 0 0.25rem;
	}
	.hint {
		color: var(--muted);
		font-size: 0.875rem;
		margin: 0 0 1rem;
	}
	form {
		display: grid;
		gap: 0.5rem;
	}
	label {
		font-weight: 600;
	}
	input {
		padding: 0.5rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
	}
	button {
		padding: 0.5rem 0.9rem;
		border-radius: 6px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--accent-text);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
	}
	.err {
		margin: 0.25rem 0 0;
		padding: 0.5rem 0.75rem;
		border-radius: 6px;
		background: var(--err-bg);
		border: 1px solid var(--err-border);
	}
</style>
