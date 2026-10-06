<script lang="ts">
	import { post } from '$lib/format';
	import type { User } from '$lib/server/users';

	let { data } = $props();

	// svelte-ignore state_referenced_locally
	let users = $state<User[]>(data.users);
	let flash = $state<{ ok: boolean; text: string; secret?: string } | null>(null);
	let busy = $state('');
	let confirming = $state<string | null>(null); // user id awaiting "Remove" confirmation

	let newName = $state('');
	// svelte-ignore state_referenced_locally
	let newPassword = $state(data.suggested);
	let newScreens = $state<string[]>(['usage', 'report']);

	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');

	function generate() {
		const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
		const pick = crypto.getRandomValues(new Uint32Array(12));
		newPassword = [0, 4, 8].map((o) => Array.from(pick.slice(o, o + 4), (n) => chars[n % chars.length]).join('')).join('-');
	}

	async function run(key: string, fn: () => Promise<void>) {
		if (busy) return;
		busy = key;
		try {
			await fn();
		} catch (e) {
			flash = { ok: false, text: (e as Error).message };
		}
		busy = '';
	}

	const toggle = (u: User, screen: string, on: boolean) =>
		run(`${u.id}:${screen}`, async () => {
			const screens = on ? [...u.screens, screen] : u.screens.filter((x) => x !== screen);
			const before = users;
			// show the tick straight away; a refused change goes back to what the server has
			users = users.map((x) => (x.id === u.id ? { ...x, screens: screens as User['screens'] } : x));
			try {
				const out = await post<{ users: User[] }>(`/api/users/${u.id}`, { action: 'screens', screens });
				users = out.users;
				const label = data.screens.find((x) => x.id === screen)?.label ?? screen;
				flash = { ok: true, text: `${u.username} ${on ? 'can now open' : 'can no longer open'} ${label}.` };
			} catch (e) {
				users = before;
				throw e;
			}
		});

	const reset = (u: User) =>
		run(`${u.id}:reset`, async () => {
			const out = await post<{ users: User[]; password: string }>(`/api/users/${u.id}`, { action: 'reset' });
			users = out.users;
			flash = { ok: true, text: `Password reset for ${u.username}. They are signed out everywhere and must choose a new one at next sign-in. Temporary password, shown once:`, secret: out.password };
		});

	const remove = (u: User) =>
		run(`${u.id}:remove`, async () => {
			const out = await post<{ users: User[] }>(`/api/users/${u.id}`, { action: 'remove' });
			users = out.users;
			confirming = null;
			flash = { ok: true, text: `${u.username} was removed and signed out.` };
		});

	function add(e: SubmitEvent) {
		e.preventDefault();
		run('add', async () => {
			const out = await post<{ users: User[]; user: User }>('/api/users', { username: newName, password: newPassword, screens: newScreens });
			users = out.users;
			flash = { ok: true, text: `User ${out.user.username} created. Give them this temporary password; they choose their own at first sign-in:`, secret: newPassword };
			newName = '';
			generate();
		});
	}
</script>

<svelte:head><title>Users - Claude Usage</title></svelte:head>

<div class="k-stack">
	<h1>Users</h1>
	<p class="k-small k-muted lead">Tick the screens each user can open.</p>
	{#if flash}
		<p class="k-flash" class:err={!flash.ok} role={flash.ok ? 'status' : 'alert'} data-testid="flash">
			{flash.text}{#if flash.secret} <code data-testid="secret">{flash.secret}</code>{/if}
		</p>
	{/if}

	<section class="k-card">
		<div class="k-tablebox">
			<table class="k-table ugrid">
				<thead>
					<tr><th>Username</th>{#each data.screens as sc (sc.id)}<th class="c">{sc.label}</th>{/each}<th>Last sign-in</th><th></th></tr>
				</thead>
				<tbody>
					{#each users as u (u.id)}
						{@const mine = u.id === data.me}
						<tr data-user={u.username}>
							<td><b>{u.username}</b>{#if mine} <span class="k-small k-muted">(you)</span>{/if}{#if u.mustChange} <span class="k-small k-muted">· must set a password</span>{/if}</td>
							{#each data.screens as sc (sc.id)}
								<td class="c" data-l={sc.label}>
									<!-- your own Users access is fixed: another admin has to change it -->
									<input type="checkbox" aria-label="{u.username} can open {sc.label}" checked={u.screens.includes(sc.id)} disabled={!!busy || (mine && sc.id === 'users')} onchange={(e) => toggle(u, sc.id, e.currentTarget.checked)} />
								</td>
							{/each}
							<td data-p="Last sign-in: ">{when(u.lastLoginAt)}</td>
							<td>
								{#if !mine}
									<div class="k-row acts">
										{#if confirming === u.id}
											<span class="k-small">Remove {u.username}?</span>
											<button class="k-btn danger" type="button" disabled={!!busy} onclick={() => remove(u)}>Yes, remove</button>
											<button class="k-btn" type="button" onclick={() => (confirming = null)}>Cancel</button>
										{:else}
											<button class="k-btn" type="button" disabled={!!busy} onclick={() => reset(u)}>Reset password</button>
											<button class="k-btn" type="button" disabled={!!busy} onclick={() => (confirming = u.id)}>Remove</button>
										{/if}
									</div>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="k-card">
		<div class="k-cardhead"><h2>Add user</h2></div>
		<form class="addform" onsubmit={add}>
			<div class="k-row top">
				<label class="k-field">Username<input class="k-input" bind:value={newName} required minlength="2" maxlength="24" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="e.g. sarah" /></label>
				<label class="k-field">Temporary password<input class="k-input pw" bind:value={newPassword} required minlength={data.minPassword} maxlength="200" autocomplete="off" spellcheck="false" /></label>
				<button class="k-btn gen" type="button" onclick={generate}>Generate</button>
			</div>
			<fieldset>
				<legend class="k-label">Screens</legend>
				<div class="k-row">
					{#each data.screens as sc (sc.id)}
						<label class="k-check"><input type="checkbox" value={sc.id} bind:group={newScreens} />{sc.label}</label>
					{/each}
				</div>
			</fieldset>
			<div class="k-row">
				<button class="k-btn primary" type="submit" disabled={!!busy}>{busy === 'add' ? 'Creating...' : 'Create user'}</button>
				<span class="k-small k-muted">They must set their own password at first sign-in. Minimum {data.minPassword} characters.</span>
			</div>
		</form>
	</section>

	<p class="k-note">
		A user sees only the ticked screens in the menu, and the server refuses the rest. Whoever has the <b>Users</b> screen is an admin: they can add users, reset passwords and change these ticks.
		At least one user must keep it. Everyone can change their own password.
	</p>
</div>

<style>
	.lead {
		margin: 0;
	}
	.acts {
		flex-wrap: nowrap;
		gap: 0.3rem;
	}
	.ugrid td:has(.acts) {
		padding-block: 0.25rem;
	}
	.addform {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.top {
		align-items: flex-end;
	}
	.pw {
		font-family: ui-monospace, Consolas, monospace;
	}
	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 0.3rem;
		padding: 0;
	}
	fieldset .k-row {
		gap: 0.4rem 1rem;
	}
	@media (max-width: 640px) {
		/* the grid stacks into one block per user instead of scrolling sideways */
		.ugrid thead {
			display: none;
		}
		.ugrid,
		.ugrid tbody {
			display: block;
		}
		.ugrid tr {
			display: block;
			padding: 0.7rem 0.6rem;
		}
		.ugrid td {
			display: block;
			height: auto;
			padding: 0.15rem 0;
			text-align: left;
			white-space: normal;
		}
		.ugrid td:first-child {
			margin-bottom: 0.2rem;
			font-size: 0.95rem;
		}
		.ugrid td[data-l] {
			display: inline-flex;
			align-items: center;
			gap: 0.35rem;
			min-height: 2rem;
			padding: 0.3rem 0.9rem 0.3rem 0;
		}
		.ugrid td[data-l]::after {
			content: attr(data-l);
		}
		.ugrid td[data-p]::before {
			content: attr(data-p);
			color: var(--muted);
		}
		.ugrid input[type='checkbox'] {
			width: 1.2rem;
			height: 1.2rem;
		}
		.acts {
			flex-wrap: wrap;
			margin-top: 0.3rem;
		}
		.top .k-field {
			flex: 1 1 100%;
		}
	}
</style>
