import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, type Browser, type Page } from '@playwright/test';

// Reports, settings, users and screen access, against the same built server as server.spec.ts
// (this file runs first: an empty data dir, no accounts yet). Steps build on each other.
test.describe.configure({ mode: 'serial' });

const root = process.env.ACCTMGR_E2E_SERVER_ROOT!;
const PORT = Number(process.env.ACCTMGR_E2E_PORT);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.ACCTMGR_E2E_PASSWORD!;
const dbFile = path.join(root, 'data', 'accounts.db');
const shots = process.env.SCREENSHOT_DIR || path.resolve('test-results', 'screens-server');

async function signIn(page: Page, username = 'admin', password = PASSWORD) {
	await page.goto('/login');
	await page.getByLabel('Username').fill(username);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}
const menu = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link');
const sideways = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth - window.innerWidth);
async function newUserPage(browser: Browser) {
	const context = await browser.newContext({ baseURL: ORIGIN });
	return { context, page: await context.newPage() };
}

let tempPassword = '';
const VIEWER_PASSWORD = 'viewer-own-password-1';

test('the admin from the environment sees every screen', async ({ page }) => {
	await signIn(page);
	await expect(page).toHaveURL(`${ORIGIN}/`);
	await expect(menu(page)).toHaveText(['Accounts', 'Usage', 'Report', 'Widget tokens', 'Settings', 'Users']);
	await expect(page.getByTestId('signed-in-as')).toHaveText('admin');
});

test('users: add a user with two screens; they must choose a password, then see only those screens', async ({ page, browser }) => {
	await signIn(page);
	await page.goto('/users');
	await page.getByLabel('Username').fill('Viewer1');
	await page.getByRole('button', { name: 'Create user' }).click();
	await expect(page.getByTestId('flash')).toContainText('User viewer1 created');
	tempPassword = (await page.getByTestId('secret').textContent())!.trim();
	expect(tempPassword.length).toBeGreaterThanOrEqual(12);
	const row = page.locator('tr[data-user="viewer1"]');
	await expect(row.getByLabel('viewer1 can open Usage')).toBeChecked();
	await expect(row.getByLabel('viewer1 can open Report')).toBeChecked();
	await expect(row.getByLabel('viewer1 can open Users')).not.toBeChecked();
	fs.mkdirSync(shots, { recursive: true });
	await page.screenshot({ path: path.join(shots, 'users.png'), fullPage: true });

	const v = await newUserPage(browser);
	await signIn(v.page, 'viewer1', tempPassword);
	// a temporary password opens nothing but the change-password page
	await expect(v.page).toHaveURL(`${ORIGIN}/account`);
	await expect(v.page.getByTestId('must-change')).toBeVisible();
	await expect(menu(v.page)).toHaveCount(0);
	await v.page.goto('/usage');
	await expect(v.page).toHaveURL(`${ORIGIN}/account`);
	expect((await v.page.request.get('/api/accounts')).status()).toBe(403);

	await v.page.getByLabel('Current password').fill(tempPassword);
	await v.page.getByLabel('New password', { exact: true }).fill(VIEWER_PASSWORD);
	await v.page.getByLabel('Repeat new password').fill(VIEWER_PASSWORD);
	await v.page.getByRole('button', { name: 'Save password' }).click();
	await expect(v.page).toHaveURL(`${ORIGIN}/usage`);
	await expect(menu(v.page)).toHaveText(['Usage', 'Report']);

	// pages they were not given send them home; the APIs behind those pages refuse them
	for (const p of ['/', '/users', '/tokens', '/settings']) {
		await v.page.goto(p);
		await expect(v.page, p).toHaveURL(`${ORIGIN}/usage`);
	}
	const api = v.page.request;
	const post = (url: string, data: unknown) => api.post(url, { headers: { origin: ORIGIN }, data });
	expect((await api.get('/api/accounts')).status()).toBe(200); // the Usage page reads this
	expect((await post('/api/accounts', { name: 'sneaky' })).status()).toBe(403);
	expect((await post('/api/app-settings', { docTitle: 'x' })).status()).toBe(403);
	expect((await post('/api/app-settings', { minPassword: 8 })).status()).toBe(403);
	expect((await api.get('/api/users')).status()).toBe(403);
	expect((await post('/api/users', { username: 'x2', password: 'long-enough-password', screens: ['users'] })).status()).toBe(403);
	expect((await api.get('/api/tokens')).status()).toBe(403);
	expect((await api.get('/api/report')).status()).toBe(200);
	await v.context.close();
});

test('users: unticking a screen removes it at once; an admin cannot lock themselves out', async ({ page, browser }) => {
	const v = await newUserPage(browser);
	await signIn(v.page, 'viewer1', VIEWER_PASSWORD);
	await expect(menu(v.page)).toHaveText(['Usage', 'Report']);

	await signIn(page);
	await page.goto('/users');
	await page.locator('tr[data-user="viewer1"]').getByLabel('viewer1 can open Usage').uncheck();
	await expect(page.getByTestId('flash')).toContainText('viewer1 can no longer open Usage');
	// your own Users access cannot be unticked from your own row
	await expect(page.locator('tr[data-user="admin"]').getByLabel('admin can open Users')).toBeDisabled();
	const me = (await (await page.request.get('/api/users')).json()).users.find((u: { username: string }) => u.username === 'admin');
	const refused = await page.request.post(`/api/users/${me.id}`, { headers: { origin: ORIGIN }, data: { action: 'screens', screens: ['usage'] } });
	expect(refused.status()).toBe(400);
	expect((await refused.json()).error).toContain('your own access to Users');

	await v.page.goto('/usage');
	await expect(v.page).toHaveURL(`${ORIGIN}/report`);
	await expect(menu(v.page)).toHaveText(['Report']);
	await v.context.close();
});

test('users: a password reset signs the user out, shows a one-time password and forces a new one', async ({ page, browser }) => {
	const v = await newUserPage(browser);
	await signIn(v.page, 'viewer1', VIEWER_PASSWORD);
	await expect(v.page).toHaveURL(`${ORIGIN}/report`);

	await signIn(page);
	await page.goto('/users');
	await page.locator('tr[data-user="viewer1"]').getByRole('button', { name: 'Reset password' }).click();
	await expect(page.getByTestId('flash')).toContainText('Password reset for viewer1');
	const oneTime = (await page.getByTestId('secret').textContent())!.trim();

	await v.page.goto('/report');
	await expect(v.page).toHaveURL(/\/login/); // the old session is gone
	await signIn(v.page, 'viewer1', VIEWER_PASSWORD);
	await expect(v.page.getByRole('alert')).toHaveText('Wrong username or password.');
	await signIn(v.page, 'viewer1', oneTime);
	await expect(v.page).toHaveURL(`${ORIGIN}/account`);
	await v.context.close();

	// remove asks first, then removes
	const row = page.locator('tr[data-user="viewer1"]');
	await row.getByRole('button', { name: 'Remove' }).click();
	await row.getByRole('button', { name: 'Cancel' }).click();
	await expect(row).toBeVisible();
	await row.getByRole('button', { name: 'Remove' }).click();
	await row.getByRole('button', { name: 'Yes, remove' }).click();
	await expect(page.getByTestId('flash')).toContainText('viewer1 was removed');
	await expect(row).toHaveCount(0);
});

test('settings: time slots are edited freely, overlaps are refused, gaps are allowed with a warning', async ({ page }) => {
	await signIn(page);
	await page.goto('/settings');
	const card = page.getByTestId('slots-card');
	await expect(card.getByLabel('Slot 1 name')).toHaveValue('Morning');
	await expect(card.getByTestId('save-slots')).toBeDisabled(); // nothing changed yet

	await card.getByRole('button', { name: '+ Add slot' }).click();
	await expect(card.getByTestId('slot-problem')).toContainText('Two time slots overlap');
	await expect(card.getByTestId('save-slots')).toBeDisabled();
	await card.getByRole('button', { name: 'Remove slot 5' }).click();

	await card.getByLabel('Slot 1 to').fill('12:30');
	await card.getByLabel('Slot 1 to').blur();
	await expect(card.getByTestId('slot-gap')).toContainText('30 min of the day is not in any slot');
	await card.getByLabel('Slot 2 name').fill('Break');
	await card.getByTestId('save-slots').click();
	await expect(page.getByTestId('saved')).toContainText('Saved: time slots');
	await page.screenshot({ path: path.join(shots, 'settings.png'), fullPage: true });

	// the server refuses an overlap even when it is posted directly
	const bad = await page.request.post('/api/app-settings', {
		headers: { origin: ORIGIN },
		data: { slots: [{ name: 'a', from: 0, to: 600 }, { name: 'b', from: 300, to: 900 }] }
	});
	expect(bad.status()).toBe(400);
	expect((await bad.json()).error).toContain('overlap');

	await page.reload();
	await expect(card.getByLabel('Slot 1 to')).toHaveValue('12:30');
	await expect(card.getByLabel('Slot 2 name')).toHaveValue('Break');
});

test('settings: the names of the two usage windows and other values save as they are changed', async ({ page }) => {
	await signIn(page);
	await page.goto('/settings');
	await page.getByLabel('Name of the 5-hour window').fill('Focus block');
	await page.getByLabel('Name of the 5-hour window').blur();
	await expect(page.getByTestId('saved')).toContainText('Saved: window name');
	await page.getByLabel('Turn amber at (%)').fill('95');
	await page.getByLabel('Turn amber at (%)').blur();
	await expect(page.getByRole('alert')).toContainText('amber level must be lower than the red level');
	await expect(page.getByLabel('Turn amber at (%)')).toHaveValue('70'); // snapped back
	await page.getByLabel('Report title').fill('Team AI Usage Report');
	await page.getByLabel('Report title').blur();
	await expect(page.getByTestId('saved')).toContainText('Saved: report title');
	const s = (await (await page.request.get('/api/app-settings')).json()).settings;
	expect(s).toMatchObject({ hourlyLabel: 'Focus block', warnAt: 70, docTitle: 'Team AI Usage Report' });
});

/**
 * The three moments of the seeded readings, fixed once when this file loads. Taking them from the
 * clock at every call spread them out on a slow machine: a later call's rows then landed between
 * an earlier call's, the level seemed to drop and rise again, and the day no longer added up to 45 %.
 */
const SEED_TIMES = (() => {
	const now = Math.floor(Date.now() / 1000);
	// the report day starts at 09:00 (server zone UTC here): keep all three readings in one day
	const boundary = Math.floor((now - 9 * 3600) / 86400) * 86400 + 9 * 3600;
	return now - 180 < boundary ? [boundary - 180, boundary - 120, boundary - 60] : [now - 180, now - 120, now - 60];
})();

/** Readings for an account that is no longer in the list: 10 %, 30 %, 55 % a minute apart. Every call writes the same three rows. */
function seedHistory(): string {
	const times = SEED_TIMES;
	const d = new DatabaseSync(dbFile);
	d.exec('PRAGMA busy_timeout = 5000');
	d.prepare("INSERT OR REPLACE INTO report_accounts (account_id, name, provider) VALUES ('legacy', 'Legacy team', 'claude')").run();
	const ins = d.prepare('INSERT OR REPLACE INTO usage_samples (account_id, ts_unix, s_pct, s_reset_unix, w_pct, w_reset_unix) VALUES (?, ?, ?, NULL, 5, NULL)');
	[10, 30, 55].forEach((p, i) => ins.run('legacy', times[i], p));
	d.close();
	return new Date((times[0] - 9 * 3600) * 1000).toISOString().slice(0, 10);
}

test('report: an empty history says so; kept readings are cut into the saved slots; week and views switch', async ({ page }) => {
	await signIn(page);
	await page.goto('/report');
	await expect(page.getByTestId('no-data')).toContainText('No history yet');

	const date = seedHistory();
	await page.goto(`/report?period=day&date=${date}`);
	await expect(page.getByTestId('kpis')).toContainText('45%'); // 10 -> 30 -> 55
	// the page states the exact span of the period: a report day does not start at midnight
	await expect(page.getByTestId('report-span')).toContainText(/Covers .+ to .+/);
	await expect(page.getByTestId('kpis')).toContainText('Legacy team');
	const table = page.getByTestId('slot-table');
	await expect(table).toContainText('Break'); // the slot renamed in Settings
	await expect(table).toContainText('Legacy team');
	await expect(table).toContainText('(removed)');
	await expect(page.getByTestId('slot-chart')).toBeVisible();
	await page.screenshot({ path: path.join(shots, 'report.png'), fullPage: true });

	await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Table' }).click();
	await expect(page.getByTestId('slot-chart')).toHaveCount(0);
	await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Graph' }).click();
	await expect(page.getByTestId('slot-table')).toHaveCount(0);
	await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Both' }).click();

	await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'Week' }).click();
	await expect(page).toHaveURL(/period=week/);
	await expect(page.getByTestId('day-card')).toBeVisible();
	await expect(page.getByTestId('kpis')).toContainText('45%');
	await page.getByRole('group', { name: 'Period' }).getByRole('button', { name: 'Month' }).click();
	await expect(page.getByTestId('kpis')).toContainText('45%');

	// the calendar marks the day that has data, and closes on Escape and on a click elsewhere
	await page.goto(`/report?period=day&date=${date}`);
	await page.getByTestId('date-button').click();
	const cal = page.getByRole('dialog', { name: 'Pick a date' });
	await expect(cal.locator('button.has')).toHaveText(String(Number(date.slice(8))));
	await page.keyboard.press('Escape');
	await expect(cal).toHaveCount(0);
	await page.getByTestId('date-button').click();
	await expect(cal).toBeVisible();
	await page.locator('.ptitle').click();
	await expect(cal).toHaveCount(0);

	// a bad date in the address shows today instead of an error page
	await page.goto('/report?period=day&date=2026-99-99');
	await expect(page.getByRole('group', { name: 'Period' })).toBeVisible();
});

test('report: a weekly limit already in force is listed, in the page and in the document', async ({ page }) => {
	const date = seedHistory();
	// an account that never touched its hourly session but sat at its weekly limit the whole time
	const d = new DatabaseSync(dbFile);
	d.exec('PRAGMA busy_timeout = 5000');
	const first = (d.prepare("SELECT MAX(ts_unix) AS t FROM usage_samples WHERE account_id = 'legacy'").get() as { t: number }).t - 120;
	d.prepare("INSERT OR REPLACE INTO report_accounts (account_id, name, provider) VALUES ('capped', 'Capped team', 'claude')").run();
	const ins = d.prepare("INSERT OR REPLACE INTO usage_samples (account_id, ts_unix, s_pct, s_reset_unix, w_pct, w_reset_unix) VALUES ('capped', ?, 0, NULL, 100, ?)");
	for (const t of [first, first + 60, first + 120]) ins.run(t, first + 2 * 86400);
	d.close();
	try {
		await signIn(page);
		await page.goto(`/report?period=day&date=${date}`);
		await expect(page.getByTestId('kpis').locator('.kpi').filter({ hasText: 'Limits reached' }).locator('.v')).toHaveText('1');
		const limits = page.getByTestId('limits');
		await expect(limits).toContainText('1 in this period');
		await expect(limits).toContainText('Capped team');
		await expect(limits).toContainText('Weekly session');
		// nobody saw it get there, so the report does not pretend to know when
		await expect(limits).toContainText('Before ');
		await expect(limits).toContainText('blocked at least 2 d 0 h');
		await expect(limits).not.toContainText('No account');
		for (const width of [1280, 390]) {
			await page.setViewportSize({ width, height: 800 });
			expect(await sideways(page), `limits at ${width}px`).toBeLessThanOrEqual(0);
		}
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({ path: path.join(shots, 'report-weekly-limit.png'), fullPage: true });

		await page.getByRole('button', { name: 'Download preview' }).click();
		const preview = page.getByTestId('doc-preview');
		await expect(preview).toContainText('An account was blocked by a limit 1 time: Capped team (removed).');
		await expect(preview).toContainText('Blocked until');
		await expect(preview).toContainText('at least 2 d 0 h');
	} finally {
		// the later steps count on the history they seeded themselves
		const c = new DatabaseSync(dbFile);
		c.exec('PRAGMA busy_timeout = 5000');
		c.exec("DELETE FROM usage_samples WHERE account_id = 'capped'; DELETE FROM report_accounts WHERE account_id = 'capped';");
		c.close();
	}
});

test('report: an account past its limit on paid extra usage is not listed as blocked', async ({ page }) => {
	const date = seedHistory();
	const d = new DatabaseSync(dbFile);
	d.exec('PRAGMA busy_timeout = 5000');
	const first = (d.prepare("SELECT MAX(ts_unix) AS t FROM usage_samples WHERE account_id = 'legacy'").get() as { t: number }).t - 120;
	d.prepare("INSERT OR REPLACE INTO report_accounts (account_id, name, provider) VALUES ('paid', 'Paid team', 'claude')").run();
	// the 5-hour session is spent the whole time; the paid amount covers it, shrinking from reading to reading
	const ins = d.prepare("INSERT OR REPLACE INTO usage_samples (account_id, ts_unix, s_pct, s_reset_unix, w_pct, w_reset_unix, extra_left) VALUES ('paid', ?, 100, ?, 20, NULL, ?)");
	[40, 35, 30].forEach((left, i) => ins.run(first + i * 60, first + 3 * 3600, left));
	d.close();
	try {
		await signIn(page);
		await page.goto(`/report?period=day&date=${date}`);
		const limits = page.getByTestId('limits');
		await expect(limits).toContainText('Paid team');
		await expect(limits).toContainText('not blocked: on paid extra usage');
		await expect(limits).not.toContainText('blocked at least');
		await page.screenshot({ path: path.join(shots, 'report-extra-usage.png'), fullPage: true });

		await page.getByRole('button', { name: 'Download preview' }).click();
		const preview = page.getByTestId('doc-preview');
		await expect(preview).toContainText('No account was blocked by a limit.');
		await expect(preview).toContainText('An account went past a limit and kept working on paid extra usage 1 time: Paid team (removed).');
		await expect(preview).toContainText('not blocked (paid extra usage)');
		await page.keyboard.press('Escape');

		// the paid amount runs out: from that reading on the account is blocked until the session resets
		const c = new DatabaseSync(dbFile);
		c.exec('PRAGMA busy_timeout = 5000');
		c.prepare("UPDATE usage_samples SET extra_left = 0 WHERE account_id = 'paid' AND ts_unix = ?").run(first + 120);
		c.close();
		await page.goto(`/report?period=day&date=${date}`);
		// the reset is read to the minute, so the blocked time is 2 h 58 min or 2 h 59 min depending on the second the test runs at
		await expect(limits).toContainText(/blocked at least 2 h 5[89] min \(the rest on paid extra usage\)/);
	} finally {
		const c = new DatabaseSync(dbFile);
		c.exec('PRAGMA busy_timeout = 5000');
		c.exec("DELETE FROM usage_samples WHERE account_id = 'paid'; DELETE FROM report_accounts WHERE account_id = 'paid';");
		c.close();
	}
});

test('report: a limit on one model is listed by the model, and the account is not called blocked', async ({ page }) => {
	const date = seedHistory();
	const d = new DatabaseSync(dbFile);
	d.exec('PRAGMA busy_timeout = 5000');
	const first = (d.prepare("SELECT MAX(ts_unix) AS t FROM usage_samples WHERE account_id = 'legacy'").get() as { t: number }).t - 120;
	d.prepare("INSERT OR REPLACE INTO report_accounts (account_id, name, provider) VALUES ('opus', 'Opus team', 'claude')").run();
	// both windows have room; the Opus allowance fills up and stays full
	const ins = d.prepare("INSERT OR REPLACE INTO usage_samples (account_id, ts_unix, s_pct, s_reset_unix, w_pct, w_reset_unix, models_json) VALUES ('opus', ?, 20, NULL, 40, NULL, ?)");
	[80, 100, 100].forEach((pct, i) => ins.run(first + i * 60, JSON.stringify([{ label: 'Opus', pct, reset: first + 2 * 86400 }, { label: 'Sonnet', pct: 10, reset: first + 2 * 86400 }])));
	d.close();
	try {
		await signIn(page);
		await page.goto(`/report?period=day&date=${date}`);
		const limits = page.getByTestId('limits');
		await expect(limits).toContainText('1 in this period');
		await expect(limits).toContainText('Opus team');
		await expect(limits).toContainText('Opus limit');
		await expect(limits).toContainText('Opus used up, other models still work · resets');
		await expect(limits).not.toContainText('blocked');
		for (const width of [1280, 390]) {
			await page.setViewportSize({ width, height: 800 });
			expect(await sideways(page), `model limit at ${width}px`).toBeLessThanOrEqual(0);
		}
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.screenshot({ path: path.join(shots, 'report-model-limit.png'), fullPage: true });

		await page.getByRole('button', { name: 'Download preview' }).click();
		const preview = page.getByTestId('doc-preview');
		await expect(preview).toContainText('No account was blocked by a limit.');
		await expect(preview).toContainText('A limit on one model was reached 1 time, with the other models still working: Opus team (removed) (Opus).');
		await expect(preview).toContainText('not blocked (other models still work)');
	} finally {
		const c = new DatabaseSync(dbFile);
		c.exec('PRAGMA busy_timeout = 5000');
		c.exec("DELETE FROM usage_samples WHERE account_id = 'opus'; DELETE FROM report_accounts WHERE account_id = 'opus';");
		c.close();
	}
});

test('report: the download menu closes on an outside click; Word, PDF and CSV files are real', async ({ page }) => {
	const date = seedHistory();
	await signIn(page);
	await page.goto(`/report?period=week&date=${date}`);
	const dl = page.getByRole('button', { name: 'Download', exact: true });
	await dl.click();
	await expect(page.getByRole('menuitem')).toHaveCount(3);
	await page.locator('.ptitle').click();
	await expect(page.getByRole('menuitem')).toHaveCount(0);
	await dl.click();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menuitem')).toHaveCount(0);

	// the preview shows the pages the files contain, with the title saved in Settings
	await page.getByRole('button', { name: 'Download preview' }).click();
	const preview = page.getByTestId('doc-preview');
	// cover + report pages; the notice and contents page is off unless Settings switches it on
	await expect(preview.locator('article')).toHaveCount(2);
	await expect(preview).toContainText('Team AI Usage Report');
	await expect(preview).not.toContainText('TABLE OF CONTENTS');
	expect((await page.request.post('/api/app-settings', { headers: { origin: ORIGIN }, data: { docContents: true } })).status()).toBe(200);
	await page.reload();
	await page.getByRole('button', { name: 'Download preview' }).click();
	await expect(preview.locator('article')).toHaveCount(3);
	await expect(preview).toContainText('INTERNAL USE ONLY');
	await expect(preview).toContainText('TABLE OF CONTENTS');
	expect((await page.request.post('/api/app-settings', { headers: { origin: ORIGIN }, data: { docContents: false } })).status()).toBe(200);
	await page.reload();
	await page.getByRole('button', { name: 'Download preview' }).click();
	await expect(preview.locator('article')).toHaveCount(2);
	await expect(preview).toContainText('Figure 1.');
	await expect(preview).toContainText('Table 1.');
	// every table fits its page: no column (the totals are last) hides behind a sideways scroll
	for (const width of [1280, 1024, 768]) {
		await page.setViewportSize({ width, height: 800 });
		const hidden = await preview.locator('.scroll').evaluateAll((boxes) => boxes.map((b) => b.scrollWidth - b.clientWidth));
		expect(hidden.length, `tables at ${width}px`).toBeGreaterThan(1);
		expect(Math.max(...hidden), `widest hidden part of a table at ${width}px`).toBeLessThanOrEqual(1);
	}
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.screenshot({ path: path.join(shots, 'report-preview.png'), fullPage: true });

	const grab = async (item: string) => {
		await dl.click();
		const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: item }).click()]);
		const bytes = fs.readFileSync((await file.path())!);
		return { name: file.suggestedFilename(), bytes, text: bytes.toString('latin1') };
	};
	const docx = await grab('Word document (.docx)');
	expect(docx.name).toMatch(/^Team-AI-Usage-Report-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.docx$/);
	expect(docx.text.startsWith('PK')).toBe(true); // a zip container
	for (const part of ['word/document.xml', 'word/header1.xml', 'word/footer1.xml', 'word/media/']) expect(docx.text, part).toContain(part);
	fs.writeFileSync(path.join(shots, docx.name), docx.bytes);

	const pdf = await grab('PDF (.pdf)');
	expect(pdf.name).toMatch(/\.pdf$/);
	expect(pdf.text.startsWith('%PDF-')).toBe(true);
	expect(pdf.bytes.length).toBeGreaterThan(20_000);
	fs.writeFileSync(path.join(shots, pdf.name), pdf.bytes);

	const csv = await grab('Spreadsheet (.csv)');
	const lines = csv.bytes.toString('utf8').replace(/^﻿/, '').split('\r\n');
	expect(lines[0]).toBe('Team AI Usage Report');
	expect(lines.some((l) => l.startsWith('Account,'))).toBe(true);
	expect(lines.some((l) => l.startsWith('Legacy team (removed),'))).toBe(true);
	expect(lines.some((l) => l.startsWith('All accounts,') && l.includes('45%'))).toBe(true);
	await expect(page.getByRole('alert')).toHaveCount(0);
});

test('phone: the menu is a drawer, nothing scrolls sideways, menus stay inside the screen', async ({ page }) => {
	const date = seedHistory();
	await page.setViewportSize({ width: 390, height: 800 });
	await signIn(page);
	const drawerLink = (name: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name });
	await expect(drawerLink('Report')).toBeHidden();
	for (const [name, url] of [['Report', '/report'], ['Settings', '/settings'], ['Users', '/users'], ['Usage', '/usage'], ['Widget tokens', '/tokens'], ['Accounts', '/']] as const) {
		await page.getByRole('button', { name: 'Menu' }).click();
		await drawerLink(name).click();
		await expect(page).toHaveURL(`${ORIGIN}${url}`);
		await expect(drawerLink(name), `${name}: the drawer closes after choosing`).toBeHidden();
		expect(await sideways(page), `${name}: no sideways scroll`).toBeLessThanOrEqual(0);
	}
	await page.getByRole('button', { name: 'Menu' }).click();
	await page.keyboard.press('Escape');
	await expect(drawerLink('Report')).toBeHidden();

	for (const mode of ['web', 'doc'] as const) {
		for (const period of ['day', 'week', 'month']) {
			await page.goto(`/report?period=${period}&date=${date}`);
			if (mode === 'doc') await page.getByRole('button', { name: 'Download preview' }).click();
			expect(await sideways(page), `report ${period} ${mode}`).toBeLessThanOrEqual(0);
		}
	}
	await page.goto(`/report?period=day&date=${date}`);
	await page.getByRole('button', { name: 'Download', exact: true }).click();
	const box = (await page.locator('.k-pop').boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	await page.keyboard.press('Escape');
	await page.getByTestId('date-button').click();
	const cal = (await page.getByRole('dialog', { name: 'Pick a date' }).boundingBox())!;
	expect(cal.x).toBeGreaterThanOrEqual(0);
	expect(cal.x + cal.width).toBeLessThanOrEqual(390);
	await page.screenshot({ path: path.join(shots, 'report-phone.png'), fullPage: true });

	await page.emulateMedia({ colorScheme: 'dark' });
	for (const p of ['/report', '/settings', '/users']) {
		await page.goto(p);
		expect(await sideways(page), `${p} dark`).toBeLessThanOrEqual(0);
		await page.screenshot({ path: path.join(shots, `phone-dark-${p.slice(1)}.png`), fullPage: true });
	}
});

test('settings are restored for the tests that follow', async ({ page }) => {
	await signIn(page);
	const r = await page.request.post('/api/app-settings', {
		headers: { origin: ORIGIN },
		data: {
			slots: [
				{ name: 'Morning', from: 540, to: 780 },
				{ name: 'Lunch', from: 780, to: 840 },
				{ name: 'Afternoon', from: 840, to: 1080 },
				{ name: 'After hours', from: 1080, to: 540 }
			],
			hourlyLabel: 'Hourly session',
			docTitle: 'Claude Usage Report',
			refreshWaitSeconds: 0
		}
	});
	expect(r.status()).toBe(200);
});
