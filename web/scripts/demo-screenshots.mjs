// Re-shoots the README screenshots (docs/images/) from a throwaway demo instance:
//   cd web && npm run build && node scripts/demo-screenshots.mjs
// Runs the BUILT app on 127.0.0.1:47591 against a temp APPDATA/USERPROFILE with the fake Claude
// and Codex CLIs (tests/fixtures), adds four example.com Claude accounts and one Codex account
// (signed in by pasting the localhost:1455 callback address, as on a server), writes a usage cache
// (one account expired), and captures the pages in light and dark. Never touches real accounts.
// Needs port 1455 free (the fake Codex CLI's callback server, like the real one).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(web, '..', 'docs', 'images');
const PORT = 47591;
const base = `http://127.0.0.1:${PORT}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acctmgr-demo-'));
for (const d of ['home', 'appdata', 'localappdata', 'tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
const home = path.join(root, 'home');
const appDir = path.join(root, 'appdata', 'ClaudeCodeUsageMonitor');

const server = spawn(process.execPath, [path.join(web, 'build', 'index.js')], {
	cwd: web,
	env: {
		...process.env,
		HOST: '127.0.0.1',
		PORT: String(PORT),
		USERPROFILE: home,
		APPDATA: path.join(root, 'appdata'),
		LOCALAPPDATA: path.join(root, 'localappdata'),
		TEMP: path.join(root, 'tmp'),
		TMP: path.join(root, 'tmp'),
		CLAUDE_BIN: path.join(web, 'tests', 'fixtures', 'fake-claude.cmd'),
		CODEX_BIN: path.join(web, 'tests', 'fixtures', `fake-codex.${process.platform === 'win32' ? 'cmd' : 'sh'}`),
		EDGE_EXE: 'none',
		WIDGET_EXE: path.join(root, 'no-widget.exe')
	},
	stdio: 'ignore'
});

const post = (p, body) =>
	fetch(base + p, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

try {
	for (let i = 0; i < 60; i++) {
		try {
			if ((await fetch(base + '/api/accounts')).ok) break;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	const accounts = [
		['work', 32, 58],
		['personal', 8, 21],
		['team', 74, 88],
		['side', 0, 0]
	];
	for (const [name] of accounts) {
		const r = await post('/api/accounts', { name });
		const done = await post('/api/login/code', { sessionId: r.login.sessionId, code: `good:${name}@example.com` });
		if (!done.ok) throw new Error(`login ${name}: ${JSON.stringify(done)}`);
	}
	// Codex: the fake CLI's login server takes the callback address the browser would land on
	const codex = [['codex', 12, 41]];
	for (const [name] of codex) {
		const r = await post('/api/accounts', { name, provider: 'codex' });
		if (!r.login) throw new Error(`codex ${name}: ${JSON.stringify(r)}`);
		const state = new URL(r.login.url).searchParams.get('state');
		const done = await post('/api/login/callback', {
			sessionId: r.login.sessionId,
			url: `http://localhost:1455/auth/callback?code=good:${name}@example.com&state=${state}`
		});
		if (!done.ok) throw new Error(`codex login ${name}: ${JSON.stringify(done)}`);
	}
	const now = Math.floor(Date.now() / 1000);
	const win = (pct, inSec) => ({ available: true, percentage: pct, resets_at: { secs_since_epoch: now + inSec, nanos_since_epoch: 0 } });
	const entry = ([id, s, w], i) => ({
		provider: 'claude',
		source_path: path.join(home, `.claude-${id}`, '.credentials.json'),
		usage: id === 'side' ? null : { session: win(s, 3600 + i * 1700), weekly: win(w, 86400 * (2 + i)) },
		error: id === 'side' ? 'token_expired' : null
	});
	fs.writeFileSync(
		path.join(appDir, 'usage-cache.json'),
		JSON.stringify({
			updated_unix: now + 5,
			poll_ok: true,
			data: {
				accounts: [
					...accounts.map(entry),
					...codex.map(([id, s, w]) => ({
						provider: 'codex',
						source_path: path.join(home, `.codex-${id}`, 'auth.json'),
						usage: { session: win(s, 9000), weekly: win(w, 86400 * 4) },
						error: null
					}))
				]
			}
		}) // newer than the logins: errors older than a login are ignored
	);

	await new Promise((r) => setTimeout(r, 6000)); // let the cache timestamp pass
	fs.mkdirSync(out, { recursive: true });
	const browser = await chromium.launch();
	const shot = async (file, route, theme, width = 1100, height = 760) => {
		const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
		await page.goto(base + route);
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(800);
		await page.screenshot({ path: path.join(out, file) });
		await page.close();
		console.log('wrote', path.join(out, file));
	};
	await shot('usage-dark.png', '/usage', 'dark');
	await shot('usage-light.png', '/usage', 'light');
	await shot('accounts-light.png', '/', 'light', 1100, 1210); // tall enough for the Codex card
	await shot('usage-mobile.png', '/usage', 'dark', 390, 780);
	await browser.close();
} finally {
	server.kill();
	// the demo's throwaway APPDATA/USERPROFILE; wait for the server to release its SQLite handle
	await new Promise((r) => setTimeout(r, 1000));
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
