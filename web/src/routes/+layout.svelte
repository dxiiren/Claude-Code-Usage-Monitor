<script lang="ts">
	import '@fontsource-variable/raleway';
	import '@fontsource-variable/noto-sans';
	import '../app.css';
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { BRAND } from '$lib/brand';
	import ThemeSwitch from '$lib/ThemeSwitch.svelte';
	import type { Snippet } from 'svelte';

	let { children, data }: { children: Snippet; data: import('./$types').LayoutData } = $props();

	/** Server mode's sign-in page shows no menu (nothing behind it is reachable yet). */
	const bare = $derived(data.server && page.url.pathname === '/login');
	const current = $derived(data.menu.find((m) => m.href === page.url.pathname));
	const title = $derived(current?.label ?? (page.url.pathname === '/account' ? 'Change password' : page.url.pathname === '/login' ? 'Sign in' : 'Claude Usage'));
	/** "Acme*Usage": the part after the star is set lighter, in italics. */
	const [brandMain, brandRest] = BRAND.menuName.split('*');
	const initials = $derived((data.user?.username ?? '').slice(0, 2).toUpperCase());

	/** Phones and tablets: the side menu is a drawer. */
	let drawer = $state(false);
	/** Desktop: the side menu folded down to icons. Remembered per browser. */
	let collapsed = $state(false);
	const RAIL_KEY = 'acctmgr-menu-collapsed';
	function toggleMenu() {
		// phones and tablets get the drawer; wider screens fold the menu to icons
		if (window.matchMedia('(max-width: 900px)').matches) return void (drawer = !drawer);
		collapsed = !collapsed;
		userMenu = false;
		try {
			localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
		} catch {
			/* storage blocked: the choice lasts for this page view */
		}
	}
	/** Change password / Sign out, behind the user row at the bottom of the menu. */
	let userMenu = $state(false);
	afterNavigate(() => {
		drawer = false;
		userMenu = false;
	});
	const role = $derived(data.menu.some((m) => m.id === 'users') ? 'Administrator' : 'Member');

	/** Menu icons: 24px stroke drawings, one per screen. */
	const ICONS: Record<string, string> = {
		accounts: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
		usage: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
		report: '<path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V8"/><path d="M18 17v-9"/>',
		tokens: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
		settings:
			'<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
		users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.74"/>'
	};

	onMount(() => {
		// Settings > Theme for new users: applies until this browser picks its own.
		try {
			collapsed = localStorage.getItem(RAIL_KEY) === '1';
			const own = localStorage.getItem('acctmgr-theme');
			if (!own && data.ui.defaultTheme !== 'auto') document.documentElement.setAttribute('data-theme', data.ui.defaultTheme);
		} catch {
			/* storage blocked: stays on auto */
		}
		const esc = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			drawer = false;
			userMenu = false;
		};
		const away = (e: MouseEvent) => {
			if (userMenu && !(e.target as Element).closest('.userbox')) userMenu = false;
		};
		window.addEventListener('keydown', esc);
		document.addEventListener('click', away);
		return () => {
			window.removeEventListener('keydown', esc);
			document.removeEventListener('click', away);
		};
	});
</script>

{#snippet brand()}
	{#if BRAND.icon}<img class="mark" src={BRAND.icon} alt="" />{:else}<svg class="mark neutral" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="7" fill="currentColor" /><path d="M9 22v-5M16 22V10M23 22v-8" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" /></svg>{/if}
	<span class="brand">{brandMain}{#if brandRest !== undefined}*<i>{brandRest}</i>{/if}</span>
{/snippet}

{#if bare}
	<div class="barepage">
		<div class="barebar">{@render brand()}<span class="grow"></span><ThemeSwitch /></div>
		<main class="baremain">{@render children()}</main>
	</div>
{:else}
	<div class="shell" class:open={drawer} class:rail={collapsed}>
		<aside class="side" id="side-menu">
			<div class="logo">{@render brand()}</div>
			<nav aria-label="Main">
				{#each data.menu as m (m.id)}
					<a href={m.href} title={collapsed ? m.label : undefined} aria-current={page.url.pathname === m.href ? 'page' : undefined}>
						<svg viewBox="0 0 24 24" aria-hidden="true">{@html ICONS[m.id] ?? ''}</svg><span class="lbl">{m.label}</span>
					</a>
				{/each}
			</nav>
			{#if data.server && data.user}
				<div class="userbox">
					{#if userMenu}
						<div class="usermenu" role="menu">
							<a role="menuitem" href="/account">Change password</a>
							<form method="POST" action="/logout" data-sveltekit-reload>
								<button type="submit" role="menuitem">Sign out</button>
							</form>
						</div>
					{/if}
					<button class="userchip" type="button" aria-haspopup="menu" aria-expanded={userMenu} aria-label="Account menu for {data.user.username}" onclick={() => (userMenu = !userMenu)}>
						<span class="avatar" aria-hidden="true">{initials}</span>
						<span class="who"><span class="uname" data-testid="signed-in-as">{data.user.username}</span><span class="role">{role}</span></span>
						<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" /></svg>
					</button>
				</div>
			{/if}
		</aside>
		<button class="scrim" type="button" aria-label="Close menu" tabindex={drawer ? 0 : -1} onclick={() => (drawer = false)}></button>
		<div class="mainwrap">
			<div class="pagebar">
				<div class="left">
					<button class="menubtn" type="button" aria-label="Menu" title={collapsed ? 'Show the menu' : 'Hide the menu'} aria-controls="side-menu" aria-expanded={drawer || !collapsed} onclick={toggleMenu}>
						<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
					</button>
					<p class="ptitle">{title}</p>
				</div>
				<ThemeSwitch />
			</div>
			<main>{@render children()}</main>
		</div>
	</div>
{/if}

<style>
	.shell {
		display: grid;
		grid-template-columns: 17rem minmax(0, 1fr);
		min-height: 100vh;
	}
	.side {
		position: sticky;
		top: 0.6rem;
		align-self: start;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		height: calc(100vh - 1.2rem);
		margin: 0.6rem;
		padding: 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}
	.logo {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.7rem 0.75rem;
		background: var(--soft);
		border-radius: var(--radius);
	}
	.mark {
		flex: none;
		width: 1.75rem;
		height: 1.75rem;
	}
	.mark.neutral {
		color: var(--accent);
	}
	.brand {
		font-family: 'Noto Sans Variable', 'Noto Sans', system-ui, sans-serif;
		font-size: 0.95rem;
		font-weight: 700;
		white-space: nowrap;
	}
	.brand i {
		font-weight: 500;
	}
	nav {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 0.15rem;
		padding-top: 0.25rem;
		overflow: auto;
	}
	nav a {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		height: 2.4rem;
		padding: 0 0.75rem;
		border-radius: calc(var(--radius) * 0.8);
		color: var(--text);
		font-size: 0.9rem;
		font-weight: 600;
		text-decoration: none;
	}
	nav a svg,
	.chev {
		flex: none;
		width: 1.15rem;
		height: 1.15rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	nav a:hover {
		background: var(--soft);
	}
	nav a[aria-current='page'] {
		background: var(--soft);
	}
	.userbox {
		position: relative;
	}
	.userchip {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		padding: 0.55rem 0.6rem;
		border: 0;
		border-radius: var(--radius);
		background: var(--soft);
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}
	.userchip:hover {
		background: color-mix(in srgb, var(--accent) 12%, var(--soft));
	}
	.avatar {
		flex: none;
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		background: var(--accent);
		color: var(--accent-text);
		font-size: 0.8rem;
		font-weight: 700;
	}
	.who {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
		line-height: 1.25;
	}
	.uname {
		overflow: hidden;
		font-size: 0.9rem;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.role {
		font-size: 0.75rem;
		color: var(--muted);
	}
	.chev {
		color: var(--muted);
	}
	.usermenu {
		position: absolute;
		right: 0;
		bottom: calc(100% + 6px);
		left: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 0.35rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
	}
	.usermenu a,
	.usermenu button {
		display: flex;
		align-items: center;
		width: 100%;
		height: 2.1rem;
		padding: 0 0.6rem;
		border: 0;
		border-radius: calc(var(--radius) * 0.8);
		background: transparent;
		color: var(--text);
		font-size: 0.85rem;
		font-weight: 500;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}
	.usermenu a:hover,
	.usermenu button:hover {
		background: var(--soft);
	}
	form {
		margin: 0;
	}
	.mainwrap {
		min-width: 0;
		padding: 0.6rem 0.6rem 0 0;
	}
	.pagebar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 0.75rem;
		padding: 0.6rem 1rem;
		background: var(--accent);
		color: var(--accent-text);
		border-radius: var(--radius);
	}
	.left {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.ptitle {
		margin: 0;
		font-family: 'Noto Sans Variable', 'Noto Sans', system-ui, sans-serif;
		font-size: 1.125rem;
		font-weight: 700;
	}
	.menubtn {
		display: inline-grid;
		place-items: center;
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		border: 0;
		border-radius: calc(var(--radius) * 0.8);
		background: transparent;
		color: inherit;
		cursor: pointer;
	}
	.menubtn:hover {
		background: rgb(255 255 255 / 0.18);
	}
	.menubtn svg {
		width: 1.2rem;
		height: 1.2rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	/* folded to an icon rail (desktop only) */
	@media (min-width: 901px) {
		.shell {
			transition: grid-template-columns 0.18s ease;
		}
		.shell.rail {
			grid-template-columns: 4.6rem minmax(0, 1fr);
		}
		.rail .brand,
		.rail .lbl,
		.rail .who,
		.rail .chev {
			display: none;
		}
		.rail .logo,
		.rail nav a,
		.rail .userchip {
			justify-content: center;
			padding-inline: 0;
		}
		.rail .userchip {
			background: transparent;
		}
		.rail .usermenu {
			right: auto;
			width: 11rem;
		}
	}
	/* the theme switch sits on the purple bar here */
	.pagebar :global(.seg) {
		border-color: rgb(255 255 255 / 0.45);
	}
	.pagebar :global(.seg button) {
		color: var(--accent-text);
	}
	.pagebar :global(.seg button + button) {
		border-left-color: rgb(255 255 255 / 0.45);
	}
	.pagebar :global(.seg button[aria-pressed='true']) {
		background: rgb(255 255 255 / 0.28);
		color: var(--accent-text);
	}
	main {
		width: 100%;
		max-width: 1500px;
		margin: 0 auto;
		padding: 1rem 0.4rem 3rem;
	}
	/* The purple bar carries the page title; each page keeps its <h1> for screen readers. */
	.mainwrap main :global(h1) {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.scrim {
		display: none;
	}
	.barepage {
		min-height: 100vh;
	}
	.barebar {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.75rem 16px;
		border-bottom: 1px solid var(--border);
	}
	.grow {
		flex: 1;
	}
	.baremain {
		max-width: none;
		padding: 1rem 16px 3rem;
	}
	@media (max-width: 900px) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
		}
		.side {
			position: fixed;
			z-index: 20;
			top: 0;
			left: 0;
			width: 16rem;
			max-width: 85vw;
			height: 100%;
			margin: 0;
			border-radius: 0;
			transform: translateX(-105%);
			transition: transform 0.2s ease;
			visibility: hidden;
		}
		.open .side {
			transform: none;
			visibility: visible;
		}
		.open .scrim {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 15;
			border: 0;
			background: rgb(0 0 0 / 0.45);
		}
		.mainwrap {
			padding: 0.6rem 0.6rem 0;
		}
		main {
			padding-inline: 0;
		}
		nav a {
			height: 2.75rem;
			font-size: 0.95rem;
		}
		.usermenu a,
		.usermenu button {
			height: 2.6rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.shell {
			transition: none;
		}
		.side {
			transition: none;
		}
	}
</style>
