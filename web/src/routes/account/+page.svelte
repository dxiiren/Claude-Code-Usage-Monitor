<script lang="ts">
	import { post } from '$lib/format';

	let { data } = $props();

	let current = $state('');
	let next = $state('');
	let again = $state('');
	let busy = $state(false);
	let error = $state('');
	let done = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		if (next !== again) return void (error = 'The two new passwords do not match.');
		busy = true;
		try {
			await post('/api/account/password', { current, next });
			done = true;
			current = next = again = '';
			// after a forced change the menu was hidden: a full load brings it back
			if (data.mustChange) location.assign(data.home);
		} catch (err) {
			error = (err as Error).message;
		}
		busy = false;
	}
</script>

<svelte:head><title>Change password - Claude Usage</title></svelte:head>

<div class="k-stack">
	<h1>Change password</h1>
	{#if data.mustChange}
		<p class="k-flash" role="status" data-testid="must-change">Your password was set by an admin. Choose your own to continue.</p>
	{:else if !data.hasScreens}
		<p class="k-flash" role="status">Your account has no screens yet. Ask an admin to give you access.</p>
	{/if}
	<section class="k-card box">
		<form onsubmit={submit}>
			<label class="k-field">Current password<input class="k-input" type="password" bind:value={current} required autocomplete="current-password" /></label>
			<label class="k-field">New password<input class="k-input" type="password" bind:value={next} required minlength={data.minPassword} maxlength="200" autocomplete="new-password" /></label>
			<label class="k-field">Repeat new password<input class="k-input" type="password" bind:value={again} required minlength={data.minPassword} maxlength="200" autocomplete="new-password" /></label>
			<p class="k-small k-muted">At least {data.minPassword} characters. Other browsers you are signed in on will be signed out.</p>
			{#if error}<p class="k-flash err" role="alert">{error}</p>{/if}
			{#if done}<p class="k-flash" role="status" data-testid="password-saved">Password saved.</p>{/if}
			<button class="k-btn primary" type="submit" disabled={busy}>{busy ? 'Saving...' : 'Save password'}</button>
		</form>
	</section>
</div>

<style>
	.box {
		width: 100%;
		max-width: 26rem;
		margin: 0 auto;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	p {
		margin: 0;
	}
	button {
		align-self: flex-start;
	}
</style>
