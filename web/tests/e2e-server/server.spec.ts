import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Server mode against the built server (start.js), a temp data dir, the fake CLI and a fake usage
// endpoint. The steps build on each other, so they run in order.
test.describe.configure({ mode: 'serial' });

const root = process.env.ACCTMGR_E2E_SERVER_ROOT!;
const PORT = Number(process.env.ACCTMGR_E2E_PORT);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const USAGE = `http://127.0.0.1:${process.env.ACCTMGR_E2E_USAGE_PORT}`;
const PASSWORD = process.env.ACCTMGR_E2E_PASSWORD!;
const data = path.join(root, 'data');
const shots = process.env.SCREENSHOT_DIR || path.resolve('test-results', 'screens-server');

async function signIn(page: Page, password = PASSWORD, username = 'admin') {
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

let widgetToken = '';

test('healthz is public and says nothing else', async ({ request }) => {
	const r = await request.get('/healthz');
	expect(r.status()).toBe(200);
	expect(await r.text()).toBe('ok');
});

test('unauthenticated: pages redirect to the login page, APIs return 401', async ({ page, request }) => {
	for (const p of ['/', '/usage', '/tokens']) {
		const r = await request.get(p, { maxRedirects: 0 });
		expect(r.status(), p).toBe(303);
		expect(r.headers().location, p).toMatch(/^\/login/);
	}
	for (const p of ['/api/accounts', '/api/tokens']) expect((await request.get(p)).status(), p).toBe(401);
	expect((await request.post('/api/accounts', { headers: { origin: ORIGIN }, data: { name: 'x' } })).status()).toBe(401);
	await page.goto('/usage');
	await expect(page).toHaveURL(/\/login\?next=%2Fusage$/);
	await expect(page.getByLabel('Username')).toBeVisible();
	await expect(page.getByLabel('Password')).toBeVisible();
	await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('wrong password or username is rejected; the right pair signs in (HttpOnly, SameSite=Strict cookie)', async ({ page, context }) => {
	await signIn(page, 'not-the-password');
	await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');
	await expect(page).toHaveURL(/\/login/);
	await signIn(page, PASSWORD, 'root');
	await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');
	await signIn(page, PASSWORD, 'ADMIN'); // username is case-insensitive
	await expect(page).toHaveURL(`${ORIGIN}/`);
	await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
	const c = (await context.cookies()).find((x) => x.name === 'acctmgr_session')!;
	expect(c).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: false });
	// no desktop-widget controls on a server
	await expect(page.getByRole('button', { name: 'Restart widget' })).toHaveCount(0);
	await expect(page.getByText('Desktop widget')).toHaveCount(0);
	// the card theme is written for the widget on the PC that runs the manager; a server has none
	await expect(page.getByText('Card theme')).toHaveCount(0);
	await expect(page.getByText('Usage polling')).toBeVisible();
});

test('a mutation with a foreign Origin is refused even when signed in', async ({ page }) => {
	await signIn(page);
	const r = await page.request.post('/api/accounts', { headers: { origin: 'https://evil.example' }, data: { name: 'evil' } });
	expect(r.status()).toBe(403);
});

test('add account: sign-in link for the user\'s own browser, paste the code, usage shown', async ({ page }) => {
	await signIn(page);
	await page.getByLabel('Add an account').fill('alpha');
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const panel = page.getByTestId('login-panel');
	const link = panel.getByTestId('signin-link');
	await expect(link).toHaveText('Open sign-in page');
	const href = (await link.getAttribute('href'))!;
	expect(href).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true/);
	// the hosted callback (shows a code), never the CLI's localhost callback
	expect(new URL(href).searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
	await expect(panel.getByRole('button', { name: 'Copy link' })).toBeVisible();
	await expect(panel).not.toContainText('Edge');
	await panel.getByLabel('Authentication code').fill('good');
	await panel.getByRole('button', { name: 'Connect' }).click();
	await expect(panel.getByTestId('login-ok')).toContainText('Logged in as alpha@example.com (max)', { timeout: 20_000 });
	await panel.getByRole('button', { name: 'Done' }).click();
	expect(fs.existsSync(path.join(data, 'accounts', 'alpha', '.credentials.json'))).toBe(true);
	// The server polled the (fake) usage endpoint right after the login.
	expect((await (await page.request.get(`${USAGE}/calls`)).json()).calls).toBeGreaterThanOrEqual(1);
	const row = page.locator('li.acc').filter({ hasText: 'alpha@example.com' });
	await expect(row.getByText('12%')).toBeVisible();
	await expect(row.getByText('44%')).toBeVisible();
	fs.mkdirSync(shots, { recursive: true });
	await page.screenshot({ path: path.join(shots, 'accounts-server.png'), fullPage: true });

	await page.goto('/usage');
	await expect(page.getByTestId('best')).toContainText('Best to use now');
	await expect(page.getByTestId('best')).toContainText('alpha');
	await expect(page.locator('li[data-account="alpha"]')).toContainText('12%');
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.screenshot({ path: path.join(shots, 'usage-server-dark.png'), fullPage: true });
	await page.emulateMedia({ colorScheme: 'light' });
});

test('an account whose token the usage endpoint rejects shows as expired', async ({ page }) => {
	await signIn(page);
	await page.getByLabel('Add an account').fill('beta');
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const panel = page.getByTestId('login-panel');
	await panel.getByLabel('Authentication code').fill('good:expired@example.com');
	await panel.getByRole('button', { name: 'Connect' }).click();
	await expect(panel.getByTestId('login-ok')).toContainText('expired@example.com', { timeout: 20_000 });
	await panel.getByRole('button', { name: 'Done' }).click();
	const row = page.locator('li.acc').filter({ hasText: 'expired@example.com' });
	await expect(row.getByTestId('status-badge')).toHaveText(/Expired/);
});

test('widget tokens: create shows it once, the API accepts it, revoke makes it 401', async ({ page, playwright }) => {
	await signIn(page);
	await page.getByRole('link', { name: 'Widget tokens' }).click();
	await expect(page.getByRole('heading', { name: 'Widget tokens' })).toBeVisible();
	await page.getByLabel('Token name').fill('office-pc');
	await page.getByRole('button', { name: 'Create token' }).click();
	const box = page.getByTestId('new-token');
	await expect(box).toContainText('it is not shown again');
	widgetToken = await box.getByLabel('New token').inputValue();
	expect(widgetToken).toMatch(/^cum_/);
	await expect(page.locator('li[data-token="office-pc"]')).toContainText('last used never');

	// A widget: no cookies, only the Bearer token.
	const widget = await playwright.request.newContext({ baseURL: ORIGIN });
	expect((await widget.get('/api/v1/widget')).status()).toBe(401);
	expect((await widget.get('/api/v1/widget', { headers: { authorization: 'Bearer cum_wrong' } })).status()).toBe(401);
	const ok = await widget.get('/api/v1/widget', { headers: { authorization: `Bearer ${widgetToken}` } });
	expect(ok.status()).toBe(200);
	const body = await ok.json();
	expect(body).toMatchObject({ schema: 1, manager_url: ORIGIN, card_theme: 'auto' });
	expect(Object.keys(body).sort()).toEqual(['accounts', 'card_theme', 'manager_url', 'revision', 'schema', 'updated_unix']);
	expect(body.updated_unix).toBeGreaterThan(0);
	expect(body.accounts.map((a: { id: string }) => a.id)).toEqual(['alpha', 'beta']);
	expect(body.accounts[0]).toMatchObject({
		id: 'alpha',
		name: 'alpha',
		email: 'alpha@example.com',
		plan: 'max',
		status: 'ok',
		status_message: '',
		usage: { session: { available: true, percentage: 12 }, weekly: { available: true, percentage: 44 } }
	});
	expect(typeof body.accounts[0].usage.session.resets_at_unix).toBe('number');
	expect(body.accounts[1]).toMatchObject({ id: 'beta', status: 'expired', usage: null });
	expect(JSON.stringify(body)).not.toMatch(/fake-|credential|token/i);

	await page.reload();
	await expect(page.locator('li[data-token="office-pc"]')).not.toContainText('last used never');
	await page.locator('li[data-token="office-pc"]').getByRole('button', { name: 'Revoke' }).click();
	await expect(page.getByText('No tokens yet.')).toBeVisible();
	expect((await widget.get('/api/v1/widget', { headers: { authorization: `Bearer ${widgetToken}` } })).status()).toBe(401);
	await widget.dispose();
});

test('sign out ends the session', async ({ page, context }) => {
	await signIn(page);
	const before = (await context.cookies()).find((x) => x.name === 'acctmgr_session')!.value;
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	// The old cookie no longer works server side.
	await context.addCookies([{ name: 'acctmgr_session', value: before, url: ORIGIN }]);
	const r = await page.request.get('/api/accounts');
	expect(r.status()).toBe(401);
});

test('login attempts are rate limited per IP (CF-Connecting-IP trusted here), 429 + Retry-After', async ({ page, playwright }) => {
	// ACCTMGR_TRUST_PROXY=1 in this run, so each "client" is its CF-Connecting-IP.
	await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': '198.51.100.7' });
	for (let i = 0; i < 5; i++) {
		await signIn(page, `wrong-${i}`);
		await expect(page.getByRole('alert')).toHaveText('Wrong username or password.');
	}
	await signIn(page, 'wrong-again');
	await expect(page.getByRole('alert')).toContainText('Too many attempts');
	// even the right credentials are refused from that address while it is locked
	await signIn(page);
	await expect(page.getByRole('alert')).toContainText('Too many attempts');
	await expect(page).toHaveURL(/\/login/);

	const raw = await playwright.request.newContext({ baseURL: ORIGIN });
	const blocked = await raw.post('/login', {
		headers: { origin: ORIGIN, 'CF-Connecting-IP': '198.51.100.7' },
		form: { username: 'admin', password: PASSWORD },
		maxRedirects: 0
	});
	expect(blocked.status()).toBe(429);
	expect(Number(blocked.headers()['retry-after'])).toBeGreaterThan(800);
	// a browser-style (HTML) submission gets the same status and header on the rendered page
	const html = await raw.post('/login', {
		headers: { origin: ORIGIN, accept: 'text/html', 'CF-Connecting-IP': '198.51.100.7' },
		form: { username: 'admin', password: PASSWORD },
		maxRedirects: 0
	});
	expect(html.status()).toBe(429);
	expect(Number(html.headers()['retry-after'])).toBeGreaterThan(800);
	expect(await html.text()).toContain('Too many attempts');
	// another address is not affected
	const other = await raw.post('/login', {
		headers: { origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9' },
		form: { username: 'admin', password: PASSWORD },
		maxRedirects: 0
	});
	expect(other.status()).toBe(200); // SvelteKit answers a JSON action request with {type:"redirect"}
	expect(await other.json()).toMatchObject({ type: 'redirect', status: 303 });
	expect(other.headers()['set-cookie'] ?? '').toContain('acctmgr_session=');
	await raw.dispose();
});
