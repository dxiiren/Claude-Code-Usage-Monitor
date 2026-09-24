import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Page } from '@playwright/test';

// One server, one isolated home: the steps build on each other, so run them in order.
test.describe.configure({ mode: 'serial' });

const root = process.env.ACCTMGR_E2E_ROOT!;
const PORT = Number(process.env.ACCTMGR_E2E_PORT);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const home = path.join(root, 'home');
const appDir = path.join(root, 'appdata', 'ClaudeCodeUsageMonitor');
const shots = process.env.SCREENSHOT_DIR || path.resolve('test-results', 'screens');

function meta(): Record<string, string> {
	const d = new DatabaseSync(path.join(appDir, 'accounts.db'), { readOnly: true });
	try {
		return Object.fromEntries((d.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
	} finally {
		d.close();
	}
}

/** The account row whose name is exactly `name` (other rows may mention it in a warning). */
function row(page: Page, name: string) {
	return page.locator('li.acc').filter({ has: page.locator('.name', { hasText: new RegExp(`^${name}$`) }) });
}

async function addAccount(page: Page, name: string, code: string) {
	await page.goto('/');
	await page.getByLabel('Add an account').fill(name);
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const panel = page.getByTestId('login-panel');
	await expect(panel.getByLabel('Authentication code')).toBeVisible();
	await panel.getByLabel('Authentication code').fill(code);
	await panel.getByRole('button', { name: 'Connect' }).click();
	return panel;
}

test('usage page: empty state links to adding an account', async ({ page }) => {
	await page.goto('/usage');
	await expect(page.getByText('No accounts yet.')).toBeVisible();
	await page.getByRole('link', { name: 'Add an account' }).click();
	await expect(page).toHaveURL(`${ORIGIN}/`);
	await expect(page.getByText('No accounts yet. Add one above.')).toBeVisible();
	expect(meta()).toMatchObject({ schema: '2', revision: '0', manager_url: 'http://127.0.0.1:47291' });
});

test('add account -> login started -> good code -> email shown', async ({ page }) => {
	await page.goto('/');
	await page.getByLabel('Add an account').fill('alpha');
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const panel = page.getByTestId('login-panel');
	await expect(panel).toContainText('Log in "alpha"');
	await expect(panel).toContainText('Edge was not found'); // EDGE_EXE=none -> fallback path
	await panel.getByText("Edge window didn't open?").click();
	const href = await panel.getByRole('link', { name: 'Open link' }).getAttribute('href');
	expect(href).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/);
	await panel.getByLabel('Authentication code').fill('good');
	await panel.getByRole('button', { name: 'Connect' }).click();
	await expect(panel.getByTestId('login-ok')).toContainText('Logged in as alpha@example.com (max)', { timeout: 20_000 });
	await panel.getByRole('button', { name: 'Done' }).click();
	const alphaRow = row(page, 'alpha');
	await expect(alphaRow).toContainText('alpha@example.com');
	await expect(alphaRow).toContainText('max');
	expect(fs.existsSync(path.join(home, '.claude-alpha', '.credentials.json'))).toBe(true);
});

test('local mode offers the paste-a-code link, and a CLI that finished by itself counts as success', async ({ page }) => {
	await page.goto('/');
	await page.getByLabel('Add an account').fill('autologin');
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const panel = page.getByTestId('login-panel');
	await expect(panel).toContainText('Log in "autologin"');
	await panel.getByText("Edge window didn't open?").click();
	const href = (await panel.getByRole('link', { name: 'Open link' }).getAttribute('href')) ?? '';
	// Not the localhost callback the CLI hands to BROWSER: that completes the login behind the
	// page's back (the real bug: "already stopped: Login successful").
	expect(new URL(href).searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
	// The fake CLI logs this account in on its own after ~0.8 s, as the real one does when the
	// browser completes the localhost callback. Pasting afterwards must report success.
	await page.waitForTimeout(1500);
	await panel.getByLabel('Authentication code').fill('whatever-was-copied');
	await panel.getByRole('button', { name: 'Connect' }).click();
	await expect(panel.getByTestId('login-ok')).toContainText('Logged in as autologin@example.com', { timeout: 20_000 });
	await expect(panel).not.toContainText('already stopped');
	await panel.getByRole('button', { name: 'Done' }).click();
	await expect(row(page, 'autologin')).toContainText('autologin@example.com');
	// Leave the shared account list as the later tests expect it.
	await row(page, 'autologin').getByRole('button', { name: 'Remove' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Remove and delete folder' }).click();
	await expect(page.getByRole('status').first()).toContainText('Removed "autologin"');
});

test('same email on a second account -> clear warning + Re-login offered', async ({ page }) => {
	const panel = await addAccount(page, 'beta', 'good:alpha@example.com');
	await expect(panel.getByTestId('login-ok')).toContainText('alpha@example.com', { timeout: 20_000 });
	const warn = panel.getByRole('alert');
	await expect(warn).toContainText('same email as alpha');
	await expect(warn.getByRole('button', { name: 'Re-login' })).toBeVisible();
	await panel.getByRole('button', { name: 'Done' }).click();
	await expect(row(page, 'beta').locator('.warn')).toContainText('Same email as alpha');
});

test('re-login with the right account clears the warning', async ({ page }) => {
	await page.goto('/');
	await row(page, 'beta').getByRole('button', { name: 'Re-login' }).first().click();
	const panel = page.getByTestId('login-panel');
	await panel.getByLabel('Authentication code').fill('good');
	await panel.getByRole('button', { name: 'Connect' }).click();
	await expect(panel.getByTestId('login-ok')).toContainText('beta@example.com', { timeout: 20_000 });
	await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('bad code -> the CLI failure is shown cleanly, nothing saved', async ({ page }) => {
	const rev = Number(meta().revision);
	const panel = await addAccount(page, 'gamma', 'bad#x');
	await expect(panel.getByTestId('login-error')).toHaveText('Login failed: Request failed with status code 400', { timeout: 20_000 });
	await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
	await expect(row(page, 'gamma')).toContainText('Not logged in');
	expect(Number(meta().revision)).toBe(rev + 1); // only the row creation was written
});

test('cancel and stale sessions give clear errors', async ({ page, request }) => {
	await page.goto('/');
	await row(page, 'gamma').getByRole('button', { name: 'Log in' }).click();
	const panel = page.getByTestId('login-panel');
	await expect(panel.getByLabel('Authentication code')).toBeVisible();
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(panel).toHaveCount(0);
	const r = await request.post('/api/login/code', { headers: { origin: ORIGIN }, data: { sessionId: 'gone', code: 'good' } });
	expect(r.status()).toBe(410);
	expect((await r.json()).error).toMatch(/no longer exists/);
});

test('rename, reorder, enable toggle', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('li.acc .name')).toHaveText(['alpha', 'beta', 'gamma']);
	// by position: in rename mode the row's name label is replaced by the input
	const gamma = page.locator('li.acc').nth(2);
	await gamma.getByRole('button', { name: 'Rename' }).click();
	await gamma.getByLabel('New name').fill('gamma2');
	await gamma.getByRole('button', { name: 'Save' }).click();
	await expect(page.locator('li.acc .name')).toHaveText(['alpha', 'beta', 'gamma2']);
	await page.getByRole('button', { name: 'Move gamma2 up' }).click();
	await expect(page.locator('li.acc .name')).toHaveText(['alpha', 'gamma2', 'beta']);
	const box = row(page, 'gamma2').getByRole('checkbox');
	await box.uncheck();
	await expect(row(page, 'gamma2')).toContainText('Hidden');
	const theme = JSON.parse(fs.readFileSync(path.join(appDir, 'themes', 'multi-claude-accounts.json'), 'utf8'));
	const ids: string[] = theme.surfaces[0].children.map((c: { id: string }) => c.id);
	expect(ids.some((i) => i.startsWith('name-gamma'))).toBe(false);
	expect(ids.some((i) => i.startsWith('name-alpha'))).toBe(true);
});

test('remove deletes only that account folder', async ({ page }) => {
	fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
	fs.writeFileSync(path.join(home, '.claude', 'keep.txt'), 'x');
	await page.goto('/');
	await row(page, 'gamma2').getByRole('button', { name: 'Remove' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText(path.join(home, '.claude-gamma'));
	await dialog.getByRole('button', { name: 'Remove and delete folder' }).click();
	await expect(page.getByRole('status').first()).toContainText('Removed "gamma2" and deleted');
	await expect(page.locator('li.acc .name')).toHaveText(['alpha', 'beta']);
	expect(fs.existsSync(path.join(home, '.claude-gamma'))).toBe(false);
	expect(fs.existsSync(path.join(home, '.claude-alpha'))).toBe(true);
	expect(fs.existsSync(path.join(home, '.claude', 'keep.txt'))).toBe(true);
});

test('foreign or missing Origin is rejected with 403', async ({ request }) => {
	for (const headers of [{ origin: 'https://evil.example' }, {}] as Record<string, string>[]) {
		const r = await request.post('/api/accounts', { headers, data: { name: 'evil' } });
		expect(r.status()).toBe(403);
	}
	const r = await request.post('/api/accounts/alpha', { headers: { origin: 'https://evil.example' }, data: { action: 'remove' } });
	expect(r.status()).toBe(403);
	expect(fs.existsSync(path.join(home, '.claude-alpha'))).toBe(true);
});

test('usage page renders bars from usage-cache.json, picks "Best to use now"', async ({ page }) => {
	const now = Math.floor(Date.now() / 1000);
	const win = (pct: number, inSec: number) => ({ available: true, percentage: pct, resets_at: { secs_since_epoch: now + inSec, nanos_since_epoch: 0 } });
	const entry = (id: string, s: number, w: number) => ({
		provider: 'claude',
		source_path: path.join(home, `.claude-${id}`, '.credentials.json'),
		usage: { session: win(s, 2 * 3600 + 125), weekly: win(w, 3 * 86400) },
		error: null
	});
	// beta has the lowest 5h but its weekly is full -> alpha must win
	fs.writeFileSync(
		path.join(appDir, 'usage-cache.json'),
		JSON.stringify({ updated_unix: now, poll_ok: true, data: { accounts: [entry('alpha', 40, 72), entry('beta', 10, 100)] } })
	);
	await page.goto('/usage');
	await expect(page.getByTestId('best')).toContainText('Best to use now');
	await expect(page.getByTestId('best')).toContainText('alpha');
	const alpha = page.locator('li', { hasText: 'alpha@example.com' });
	const beta = page.locator('li', { hasText: 'beta@example.com' });
	await expect(alpha.locator('[data-level="ok"]')).toContainText('40%');
	await expect(alpha.locator('[data-level="warn"]')).toContainText('72%');
	await expect(beta.locator('[data-level="full"]')).toContainText('limit reached');
	await expect(beta.getByText('blocked', { exact: true })).toBeVisible();
	// countdown ticks client-side
	const cd = alpha.locator('.reset').first();
	await expect(cd).toContainText(/resets in 2h \d+m/);
	await expect(page.locator('.updated')).toContainText('updated');
	for (const [w, h, name] of [[1280, 800, 'usage-desktop'], [375, 740, 'usage-375']] as const) {
		await page.setViewportSize({ width: w, height: h });
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow, `horizontal overflow at ${w}px`).toBe(0);
		await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
	}
});

test('countdown updates every second', async ({ page }) => {
	await page.goto('/usage');
	const label = page.getByTestId('best');
	// force a sub-hour countdown so seconds are shown
	const now = Math.floor(Date.now() / 1000);
	const cache = JSON.parse(fs.readFileSync(path.join(appDir, 'usage-cache.json'), 'utf8'));
	cache.data.accounts[0].usage.session.resets_at.secs_since_epoch = now + 600;
	fs.writeFileSync(path.join(appDir, 'usage-cache.json'), JSON.stringify(cache));
	await page.reload();
	await expect(label).toContainText('alpha');
	const cd = page.locator('li', { hasText: 'alpha@example.com' }).locator('.reset').first();
	const a = await cd.textContent();
	await page.waitForTimeout(2100);
	const b = await cd.textContent();
	expect(a).toMatch(/resets in \d+m \d\ds/);
	expect(b).not.toBe(a);
});

test('expired login: badge + Re-login on both pages, skipped by "Best to use now", cleared by re-login', async ({ page }) => {
	const cacheFile = path.join(appDir, 'usage-cache.json');
	const now = Math.floor(Date.now() / 1000);
	const win = (pct: number, inSec: number) => ({ available: true, percentage: pct, resets_at: { secs_since_epoch: now + inSec, nanos_since_epoch: 0 } });
	const entry = (id: string, s: number, w: number, error: unknown) => ({
		provider: 'claude',
		source_path: path.join(home, `.claude-${id}`, '.credentials.json'),
		usage: { session: win(s, 2 * 3600), weekly: win(w, 3 * 86400) },
		error
	});
	// beta has the most room on paper, but its token expired -> must not be "Best to use now"
	const writeCache = (betaError: unknown, at: number) =>
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({ updated_unix: at, poll_ok: true, data: { accounts: [entry('alpha', 40, 72, null), entry('beta', 5, 20, betaError)] } })
		);
	writeCache('token_expired', now - 5);

	await page.goto('/usage');
	const notice = page.getByTestId('needs-login');
	await expect(notice).toContainText('1 account needs login');
	await expect(notice.getByRole('link', { name: 'beta' })).toHaveAttribute('href', '/?relogin=beta');
	await expect(page.getByTestId('best')).toContainText('alpha');
	const betaCard = page.locator('li[data-account="beta"]');
	await expect(betaCard.getByTestId('status-badge')).toHaveText('Expired — log in again');
	await expect(betaCard.getByRole('link', { name: 'Re-login' })).toBeVisible();
	await expect(betaCard.locator('[role="meter"]')).toHaveCount(0); // stale bars hidden
	await expect(page.locator('li[data-account="alpha"] [role="meter"]')).toHaveCount(2);

	for (const mode of ['Light', 'Dark'] as const) {
		await page.getByRole('button', { name: mode }).click();
		await page.screenshot({ path: path.join(shots, `usage-expired-${mode.toLowerCase()}.png`), fullPage: true });
	}
	await page.getByRole('button', { name: 'Auto' }).click();

	// Accounts page shows it too, with a prominent Re-login
	await page.goto('/');
	const betaRow = row(page, 'beta');
	await expect(betaRow.getByTestId('status-badge')).toHaveText('Expired — log in again');
	await expect(betaRow.getByRole('alert')).toContainText('The login token expired.');
	await expect(betaRow.locator('.bars.stale')).toBeVisible();
	await expect(row(page, 'alpha').getByTestId('status-badge')).toHaveCount(0);

	// Re-login from the Usage page opens the login for that account on the Accounts page
	await page.goto('/usage');
	await page.locator('li[data-account="beta"]').getByRole('link', { name: 'Re-login' }).click();
	await expect(page).toHaveURL(`${ORIGIN}/`);
	const panel = page.getByTestId('login-panel');
	await expect(panel).toContainText('Log in "beta"');
	await panel.getByLabel('Authentication code').fill('good');
	await panel.getByRole('button', { name: 'Connect' }).click();
	await expect(panel.getByTestId('login-ok')).toContainText('beta@example.com', { timeout: 20_000 });
	await panel.getByRole('button', { name: 'Done' }).click();
	// the poll error predates this login, so it no longer counts
	await expect(row(page, 'beta').getByTestId('status-badge')).toHaveCount(0);

	// and once the widget re-polls (fixture updated) the account is healthy and eligible again
	writeCache(null, Math.floor(Date.now() / 1000) + 1);
	await page.goto('/usage');
	await expect(page.getByTestId('needs-login')).toHaveCount(0);
	await expect(page.locator('li[data-account="beta"] [role="meter"]')).toHaveCount(2);
	await expect(page.getByTestId('best')).toContainText('beta');

	// a transient error is shown but asks for no re-login
	writeCache('network_error', Math.floor(Date.now() / 1000) + 2);
	await page.goto('/usage');
	await expect(page.locator('li[data-account="beta"]').getByTestId('status-error')).toContainText('network error');
	await expect(page.getByTestId('needs-login')).toHaveCount(0);
});

test('page theme switch: Auto follows OS, Light/Dark apply and persist across reload', async ({ page }) => {
	const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	const cardBg = () => page.locator('.card').first().evaluate((e) => getComputedStyle(e).backgroundColor);
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.goto('/usage');
	await expect(page.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true');
	expect(await bg()).toBe('rgb(1, 4, 9)');
	await page.emulateMedia({ colorScheme: 'light' });
	expect(await bg()).toBe('rgb(246, 248, 250)');

	await page.getByRole('button', { name: 'Dark' }).click();
	expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
	expect(await cardBg()).toBe('rgb(13, 17, 23)');
	await page.reload();
	await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
	expect(await bg()).toBe('rgb(1, 4, 9)');
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.screenshot({ path: path.join(shots, 'usage-dark.png'), fullPage: true });
	await page.goto('/');
	await page.screenshot({ path: path.join(shots, 'manager-dark.png'), fullPage: true });

	await page.emulateMedia({ colorScheme: 'dark' });
	await page.getByRole('button', { name: 'Light' }).click();
	expect(await bg()).toBe('rgb(246, 248, 250)');
	await page.goto('/usage');
	await expect(page.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
	expect(await cardBg()).toBe('rgb(255, 255, 255)');
	await page.screenshot({ path: path.join(shots, 'usage-light.png'), fullPage: true });
	await page.goto('/');
	await page.screenshot({ path: path.join(shots, 'manager-light.png'), fullPage: true });

	await page.getByRole('button', { name: 'Auto' }).click();
	await page.reload();
	expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
	expect(await bg()).toBe('rgb(1, 4, 9)');
});

test('card theme setting: stored in meta.card_theme, bumps revision, regenerates the widget theme', async ({ page }) => {
	await page.goto('/');
	const sel = page.getByLabel('Card theme');
	await expect(sel).toHaveValue('auto');
	const themeFile = path.join(appDir, 'themes', 'multi-claude-accounts.json');
	// Auto = fully transparent colour, never 'none' (fa96c0f: 'none' made the widget draw its own grey box).
	const AUTO_BG = { type: 'colour', colour: { color: '#00000000', opacity: '0' } };
	const surfaceBg = () => JSON.parse(fs.readFileSync(themeFile, 'utf8')).surfaces[0].background;
	expect(surfaceBg()).toEqual(AUTO_BG);
	for (const [mode, expected] of [
		['light', { type: 'colour', colour: { color: '#FFFFFFFF', opacity: '0.85' } }],
		['dark', { type: 'colour', colour: { color: '#0D1117FF', opacity: '0.85' } }],
		['auto', AUTO_BG]
	] as const) {
		const rev = Number(meta().revision);
		await sel.selectOption(mode);
		await expect(page.getByText('Saved. The widget picks it up')).toBeVisible();
		await expect.poll(() => meta().card_theme).toBe(mode);
		expect(Number(meta().revision)).toBe(rev + 1);
		expect(surfaceBg()).toEqual(expected);
	}
	await page.reload();
	await expect(page.getByLabel('Card theme')).toHaveValue('auto');
});

// ---------- Codex accounts (contract: "Codex accounts (provider column)") ----------

const portOpen = (port: number) =>
	new Promise<boolean>((r) => {
		const s = net.connect(port, '127.0.0.1', () => (s.destroy(), r(true)));
		s.on('error', () => r(false));
	});

async function startCodex(page: Page, name: string) {
	await page.goto('/');
	await page.getByLabel('Codex').check();
	await expect(page.getByText('It finishes by itself.')).toBeVisible();
	await page.getByLabel('Add an account').fill(name);
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const panel = page.getByTestId('login-panel');
	await expect(panel).toContainText(`Log in "${name}"`);
	return panel;
}

test('codex: provider choice on Add account; the local login completes by itself (no paste)', async ({ page }) => {
	fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
	fs.writeFileSync(path.join(home, '.codex', 'keep.txt'), 'the user own Codex install');
	// the fake CLI completes by itself for a CODEX_HOME named *autologin*, as the isolated Edge window does
	const panel = await startCodex(page, 'autologin cx');
	await expect(panel).toContainText('This page updates by itself when the sign-in finishes');
	await expect(panel).not.toContainText('Authentication code');
	await expect(panel.getByTestId('login-ok')).toContainText('Logged in as autologin_cx@example.com (plus)', { timeout: 20_000 });
	await panel.getByRole('button', { name: 'Done' }).click();
	const r = row(page, 'autologin cx');
	await expect(r.getByTestId('codex-tag')).toHaveText('Codex');
	await expect(r).toContainText('autologin_cx@example.com');
	await expect(row(page, 'alpha').getByTestId('codex-tag')).toHaveCount(0);
	expect(fs.existsSync(path.join(home, '.codex-autologin_cx', 'auth.json'))).toBe(true);
	// DB: provider column, schema 2; card theme: accounts.codex.<id> bindings + the Codex tag
	const d = new DatabaseSync(path.join(appDir, 'accounts.db'), { readOnly: true });
	const dbRow = d.prepare("SELECT provider, config_dir FROM accounts WHERE id = 'autologin_cx'").get() as { provider: string; config_dir: string };
	d.close();
	expect(dbRow).toEqual({ provider: 'codex', config_dir: path.join(home, '.codex-autologin_cx') });
	expect(meta().schema).toBe('2');
	// the widget polls accounts.db Codex rows only while show_codex is on
	expect(JSON.parse(fs.readFileSync(path.join(appDir, 'settings.json'), 'utf8')).show_codex).toBe(true);
	const kids: { id: string; content: { template?: string } }[] = JSON.parse(
		fs.readFileSync(path.join(appDir, 'themes', 'multi-claude-accounts.json'), 'utf8')
	).surfaces[0].children;
	expect(kids.find((k) => k.id === 'tag-autologin_cx-dark')?.content.template).toBe('Codex');
	expect(kids.find((k) => k.id === 'val-autologin_cx-session-dark')?.content.template).toContain('accounts.codex.autologin_cx.session');
	await expect.poll(() => portOpen(1455)).toBe(false); // the CLI's callback server is gone
});

test('codex: fallback paste of the localhost:1455 callback address (strict validation)', async ({ page }) => {
	const panel = await startCodex(page, 'cxpaste');
	await expect(panel.getByTestId('codex-waiting')).toBeVisible();
	await panel.getByText("Edge window didn't open, or the sign-in is stuck?").click();
	const href = (await panel.getByRole('link', { name: 'Open link' }).getAttribute('href')) ?? '';
	expect(new URL(href).origin).toBe('https://auth.openai.com');
	expect(new URL(href).searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
	const state = new URL(href).searchParams.get('state');
	const field = panel.getByLabel('Address from the browser');
	await field.fill(`http://evil.example:1455/auth/callback?code=good&state=${state}`);
	await panel.getByRole('button', { name: 'Connect' }).click();
	await expect(panel.getByRole('alert')).toContainText('starting with http://localhost:1455/auth/callback?');
	await field.fill(`http://localhost:1455/auth/callback?code=good&scope=openid&state=${state}`);
	await panel.getByRole('button', { name: 'Connect' }).click();
	await expect(panel.getByTestId('login-ok')).toContainText('Logged in as cxpaste@example.com (plus)', { timeout: 20_000 });
	await panel.getByRole('button', { name: 'Done' }).click();
	await expect(row(page, 'cxpaste')).toContainText('cxpaste@example.com');
});

test('codex: cancel stops the waiting CLI and frees port 1455', async ({ page }) => {
	await page.goto('/');
	await row(page, 'cxpaste').getByRole('button', { name: 'Re-login' }).click();
	const panel = page.getByTestId('login-panel');
	await expect(panel.getByTestId('codex-waiting')).toBeVisible();
	expect(await portOpen(1455)).toBe(true);
	await panel.getByRole('button', { name: 'Cancel' }).click();
	await expect(panel).toHaveCount(0);
	await expect.poll(() => portOpen(1455)).toBe(false);
});

test('codex: Usage page covers both providers, light + dark', async ({ page }) => {
	const now = Math.floor(Date.now() / 1000);
	const win = (pct: number, inSec: number) => ({ available: true, percentage: pct, resets_at: { secs_since_epoch: now + inSec, nanos_since_epoch: 0 } });
	const cache = JSON.parse(fs.readFileSync(path.join(appDir, 'usage-cache.json'), 'utf8'));
	cache.updated_unix = now;
	cache.data.accounts = cache.data.accounts.filter((e: { provider: string }) => e.provider === 'claude');
	cache.data.accounts.push({
		provider: 'codex',
		source_path: path.join(home, '.codex-cxpaste', 'auth.json'),
		usage: { session: win(7, 7200), weekly: win(33, 3 * 86400) },
		error: null
	});
	fs.writeFileSync(path.join(appDir, 'usage-cache.json'), JSON.stringify(cache));
	await page.goto('/usage');
	await expect(page.locator('.card .title')).toHaveText('Claude & Codex usage');
	const cx = page.locator('li[data-account="cxpaste"]');
	await expect(cx.getByTestId('codex-tag')).toHaveText('Codex');
	await expect(cx).toContainText('7%');
	await expect(cx).toContainText('33%');
	await expect(page.locator('li[data-account="alpha"]').getByTestId('codex-tag')).toHaveCount(0);
	await page.setViewportSize({ width: 1280, height: 800 });
	for (const mode of ['Light', 'Dark'] as const) {
		await page.getByRole('button', { name: mode }).click();
		await page.screenshot({ path: path.join(shots, `usage-codex-${mode.toLowerCase()}.png`), fullPage: true });
		await page.goto('/');
		await page.screenshot({ path: path.join(shots, `manager-codex-${mode.toLowerCase()}.png`), fullPage: true });
		await page.goto('/usage');
	}
	await page.getByRole('button', { name: 'Auto' }).click();
});

test('codex: remove deletes only the .codex-<id> folder, never %USERPROFILE%\\.codex', async ({ page }) => {
	await page.goto('/');
	for (const name of ['autologin cx', 'cxpaste']) {
		await row(page, name).getByRole('button', { name: 'Remove' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toContainText('Your main .codex folder is never touched.');
		await dialog.getByRole('button', { name: 'Remove and delete folder' }).click();
		await expect(row(page, name)).toHaveCount(0);
	}
	expect(fs.readdirSync(home).filter((n) => n.startsWith('.codex-'))).toEqual([]);
	expect(fs.existsSync(path.join(home, '.codex', 'keep.txt'))).toBe(true);
});

test('cleanup: remove every account -> zero-account card', async ({ page }) => {
	await page.goto('/');
	for (const name of ['alpha', 'beta']) {
		await row(page, name).getByRole('button', { name: 'Remove' }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Remove and delete folder' }).click();
		await expect(page.locator('li.acc', { hasText: `${name}@` })).toHaveCount(0);
	}
	await expect(page.getByText('No accounts yet. Add one above.')).toBeVisible();
	const theme = JSON.parse(fs.readFileSync(path.join(appDir, 'themes', 'multi-claude-accounts.json'), 'utf8'));
	expect(theme.surfaces[0].children.map((c: { id: string }) => c.id)).toContain('no-accounts-dark');
	const settingsRaw = fs.readFileSync(path.join(appDir, 'settings.json'));
	expect(settingsRaw[0]).not.toBe(0xef);
	expect(JSON.parse(settingsRaw.toString('utf8')).accounts.claude.profiles).toEqual([]);
	expect(fs.readdirSync(home).filter((n) => n.startsWith('.claude-'))).toEqual([]);
	expect(fs.existsSync(path.join(home, '.claude', 'keep.txt'))).toBe(true);
});
