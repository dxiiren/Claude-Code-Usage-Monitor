// Codex accounts, local mode (docs/account-manager-contract.md, "Codex accounts (provider column)").
// The only unit file that runs Codex logins: the fake CLI binds the real callback port 1455.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { isolateHome } from './helpers';

const env = isolateHome();
const dbFile = path.join(env.appDir, 'accounts.db');

// A schema-1 DB as the previous release left it, with one Claude row (created BEFORE db.ts loads).
fs.mkdirSync(env.appDir, { recursive: true });
{
	const d = new DatabaseSync(dbFile);
	d.exec(`
CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_dir TEXT NOT NULL, email TEXT, plan TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('revision', '7'), ('schema', '1'), ('manager_url', 'http://127.0.0.1:47291'), ('card_theme', 'auto');`);
	const t = new Date().toISOString();
	d.prepare('INSERT INTO accounts (id, name, config_dir, email, plan, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)').run(
		'old',
		'old',
		path.join(env.home, '.claude-old'),
		'old@example.com',
		'max',
		t,
		t
	);
	d.close();
}

type Db = typeof import('../../src/lib/server/db');
type Codex = typeof import('../../src/lib/server/codex');
type Api = typeof import('../../src/lib/server/api');
type Paths = typeof import('../../src/lib/server/paths');
type Usage = typeof import('../../src/lib/server/usage');
let db: Db;
let codex: Codex;
let api: Api;
let paths: Paths;
let usage: Usage;

function meta(): Record<string, string> {
	const d = new DatabaseSync(dbFile, { readOnly: true });
	try {
		return Object.fromEntries((d.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
	} finally {
		d.close();
	}
}
const theme = () => JSON.parse(fs.readFileSync(path.join(env.appDir, 'themes', 'multi-claude-accounts.json'), 'utf8'));
const layers = (): { id: string; render: string; content: { template?: string } }[] => theme().surfaces[0].children;
const settings = () => JSON.parse(fs.readFileSync(path.join(env.appDir, 'settings.json'), 'utf8'));
const portOpen = () =>
	new Promise<boolean>((r) => {
		const s = net.connect(1455, '127.0.0.1', () => (s.destroy(), r(true)));
		s.on('error', () => r(false));
	});
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
const cb = (state: string, code: string) => `http://localhost:1455/auth/callback?code=${encodeURIComponent(code)}&scope=openid&state=${state}`;
async function until(fn: () => boolean, ms = 15_000) {
	const end = Date.now() + ms;
	while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
	return fn();
}

beforeAll(async () => {
	db = await import('../../src/lib/server/db');
	codex = await import('../../src/lib/server/codex');
	api = await import('../../src/lib/server/api'); // registers the Codex completion handler
	paths = await import('../../src/lib/server/paths');
	usage = await import('../../src/lib/server/usage');
	db.initDb();
});

describe('schema 1 -> 2 migration', () => {
	it('adds accounts.provider (existing rows are Claude), meta.schema = 2, one revision bump', () => {
		const d = new DatabaseSync(dbFile, { readOnly: true });
		const cols = (d.prepare('PRAGMA table_info(accounts)').all() as { name: string; dflt_value: string; notnull: number }[]).find(
			(c) => c.name === 'provider'
		);
		d.close();
		expect(cols).toMatchObject({ dflt_value: "'claude'", notnull: 1 });
		expect(db.getAccount('old')).toMatchObject({ provider: 'claude', email: 'old@example.com' });
		expect(meta()).toMatchObject({ schema: '2', revision: '8' });
		// the migration write regenerated the widget files from the existing row
		expect(settings().accounts.claude.profiles.map((p: { id: string }) => p.id)).toEqual(['old']);
	});

	it('opening again does not migrate or bump again', async () => {
		const again = new DatabaseSync(dbFile, { readOnly: true });
		const n = (again.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('accounts') WHERE name = 'provider'").get() as { n: number }).n;
		again.close();
		expect(n).toBe(1);
		expect(meta().revision).toBe('8');
	});
});

describe('codex rows', () => {
	it('settings.json: show_codex turns on when a Codex account is added (widget polls DB Codex rows only then); other keys kept, no BOM', () => {
		const file = path.join(env.appDir, 'settings.json');
		const before = settings();
		expect(before.show_codex).toBeUndefined(); // Claude-only DB: not touched
		fs.writeFileSync(file, JSON.stringify({ ...before, poll_interval_seconds: 120, my_key: 'kept' }, null, 2));
		db.createAccount('Flag', 'codex');
		const raw = fs.readFileSync(file);
		expect(raw[0]).not.toBe(0xef);
		const s = JSON.parse(raw.toString('utf8'));
		expect(s).toMatchObject({ show_codex: true, show_claude_code: true, poll_interval_seconds: 120, my_key: 'kept' });
		// hidden again: the flag stays (never switched off: the user may show their own Codex)
		db.setEnabled('flag', false);
		expect(settings().show_codex).toBe(true);
		// user turned it off, then enabling a Codex account turns it back on
		fs.writeFileSync(file, JSON.stringify({ ...settings(), show_codex: false }, null, 2));
		db.setEnabled('flag', true);
		expect(settings().show_codex).toBe(true);
		db.removeAccount('flag');
	});

	it('create: %USERPROFILE%\\.codex-<id>, provider codex, never the user\'s own .codex', () => {
		const a = db.createAccount('Work', 'codex');
		expect(a).toMatchObject({ id: 'work', provider: 'codex', config_dir: path.join(env.home, '.codex-work') });
		expect(a.config_dir).not.toBe(paths.DEFAULT_CODEX_DIR);
		expect(() => db.createAccount('x', 'gemini')).toThrow(/claude or codex/);
		expect(db.createAccount('claude one').provider).toBe('claude'); // default stays Claude
	});

	it('ids stay unique across providers (row ids and folders on disk)', () => {
		fs.mkdirSync(path.join(env.home, '.claude-ops'), { recursive: true });
		expect(db.createAccount('ops', 'codex').id).toBe('ops_2');
		fs.mkdirSync(path.join(env.home, '.codex-dev'), { recursive: true });
		expect(db.createAccount('dev').id).toBe('dev_2');
		expect(JSON.parse(meta().used_ids)).toEqual(expect.arrayContaining(['work', 'ops_2', 'dev_2']));
	});

	it('card theme: codex rows bind accounts.codex.<id>.* and carry a "Codex" tag; settings.json lists Claude only', () => {
		const ids = layers().map((l) => l.id);
		expect(ids).toContain('tag-work-dark');
		expect(ids).toContain('tag-work-light');
		expect(ids).not.toContain('tag-old-dark');
		expect(layers().find((l) => l.id === 'tag-work-dark')!.content.template).toBe('Codex');
		const workLayers = layers().filter((l) => l.id.includes('-work'));
		expect(workLayers.find((l) => l.id === 'val-work-session-dark')!.content.template).toContain('accounts.codex.work.session.percentage');
		expect(workLayers.find((l) => l.id === 'expired-work-dark')!.render).toContain('accounts.codex.work.login_required');
		expect(layers().find((l) => l.id === 'val-old-session-dark')!.content.template).toContain('accounts.claude.old.session');
		expect(layers().find((l) => l.id === 'title-dark')!.content.template).toBe('Claude & Codex usage');
		expect(settings().accounts.claude.profiles.map((p: { id: string }) => p.id)).not.toContain('work');
	});

	it('folder guard: .codex-<id> may be deleted, %USERPROFILE%\\.codex never', () => {
		expect(paths.isDeletableConfigDir(path.join(env.home, '.codex-work'))).toBe(true);
		expect(paths.isDeletableConfigDir(path.join(env.home, '.codex'))).toBe(false);
		expect(paths.isDeletableConfigDir(path.join(env.home, '.CODEX'))).toBe(false);
		expect(paths.isDeletableConfigDir(path.join(env.home, 'x', '.codex-work'))).toBe(false);
		expect(paths.isDeletableConfigDir(path.join(env.home, '.codex-work', '..', '.codex'))).toBe(false);
	});

	it('remove deletes only the row\'s own .codex-<id>; a row pointing at .codex leaves it alone', () => {
		const own = path.join(env.home, '.codex-ops_2');
		const main = path.join(env.home, '.codex');
		for (const d of [own, main]) {
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(path.join(d, 'auth.json'), '{}');
		}
		expect(db.removeAccount('ops_2').folderDeleted).toBe(true);
		expect(fs.existsSync(own)).toBe(false);
		const d = new DatabaseSync(dbFile);
		const t = new Date().toISOString();
		d.prepare("INSERT INTO accounts (id, name, config_dir, enabled, sort_order, created_at, updated_at, provider) VALUES ('mine', 'mine', ?, 1, 99, ?, ?, 'codex')").run(main, t, t);
		d.close();
		const r = db.removeAccount('mine');
		expect(r.folderDeleted).toBe(false);
		expect(r.folderNote).toMatch(/\.codex-\*/);
		expect(fs.existsSync(path.join(main, 'auth.json'))).toBe(true);
	});

	it('usage: provider "codex" cache entries match <config_dir>\\auth.json', () => {
		const work = db.getAccount('work')!;
		const now = Math.floor(Date.now() / 1000);
		const w = (p: number) => ({ available: true, percentage: p, resets_at: { secs_since_epoch: now + 3600, nanos_since_epoch: 0 } });
		fs.writeFileSync(
			path.join(env.appDir, 'usage-cache.json'),
			JSON.stringify({
				updated_unix: now,
				data: {
					accounts: [
						// same folder, wrong provider/file: must not match
						{ provider: 'claude', source_path: path.join(work.config_dir, '.credentials.json'), usage: { session: w(99), weekly: w(99) }, error: null },
						{ provider: 'codex', source_path: path.join(work.config_dir, 'auth.json'), usage: { session: w(7), weekly: w(33) }, error: null }
					]
				}
			})
		);
		const u = usage.readUsage(db.listAccounts()).byId;
		expect(u.work).toMatchObject({ session: { percentage: 7 }, weekly: { percentage: 33 }, pollError: null });
		expect(u.old).toBeNull();
	});
});

describe('callback address validation (strict host / port / path)', () => {
	const ok = [
		'http://localhost:1455/auth/callback?code=abc&scope=openid&state=xyz',
		'http://127.0.0.1:1455/auth/callback?code=abc&state=xyz',
		'  http://localhost:1455/auth/callback?error=access_denied&state=xyz  '
	];
	const bad = [
		'',
		'abc',
		'https://localhost:1455/auth/callback?code=a&state=b',
		'http://localhost/auth/callback?code=a&state=b',
		'http://localhost:1456/auth/callback?code=a&state=b',
		'http://localhost:80/auth/callback?code=a&state=b',
		'http://evil.example:1455/auth/callback?code=a&state=b',
		'http://localhost.evil.example:1455/auth/callback?code=a&state=b',
		'http://127.0.0.2:1455/auth/callback?code=a&state=b',
		'http://[::1]:1455/auth/callback?code=a&state=b',
		'http://user@localhost:1455/auth/callback?code=a&state=b',
		'http://localhost:1455/auth/callback/../cancel?code=a&state=b',
		'http://localhost:1455/cancel?code=a&state=b',
		'http://localhost:1455/auth/callback?code=a',
		'http://localhost:1455/auth/callback?state=b',
		'http://localhost:1455/auth/callback?code=a b&state=b',
		`http://localhost:1455/auth/callback?code=${'a'.repeat(9000)}&state=b`
	];
	it('accepts only the CLI callback on localhost/127.0.0.1:1455', () => {
		for (const u of ok) expect(codex.callbackQuery(u), u).toMatch(/^\?/);
		for (const u of bad) expect(() => codex.callbackQuery(u), u).toThrow(/localhost:1455\/auth\/callback/);
		expect(() => codex.callbackQuery(42)).toThrow();
	});
});

describe('auth.json + `codex login status`', () => {
	it('email + plan come from the id_token payload; tokens never leave the module', async () => {
		const dir = path.join(env.root, 'status-home');
		expect(await codex.codexAuthStatusOrNull(dir)).toEqual({ loggedIn: false, email: null, plan: null });
		const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
		fs.writeFileSync(
			path.join(dir, 'auth.json'),
			JSON.stringify({
				tokens: {
					id_token: `${b64({ alg: 'none' })}.${b64({ email: 'me@x.io', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })}.s`,
					access_token: 'secret-access',
					account_id: 'acct-1'
				}
			})
		);
		expect(codex.readCodexAuth(dir)).toEqual({ accessToken: 'secret-access', accountId: 'acct-1', email: 'me@x.io', plan: 'pro' });
		expect(await codex.codexAuthStatusOrNull(dir)).toEqual({ loggedIn: true, email: 'me@x.io', plan: 'pro' });
		expect(codex.jwtPayload('not-a-jwt')).toBeNull();
		expect(codex.jwtPayload(undefined)).toBeNull();
	});
});

describe('login through the CLI (fake app-server with a real 127.0.0.1:1455 callback server)', () => {
	it('start -> authorize URL with the localhost:1455 redirect; a wrong address is refused, the right one completes', async () => {
		const a = db.getAccount('work')!;
		const r = await codex.startCodexLogin(a.id, a.config_dir);
		expect(r).toMatchObject({ provider: 'codex', edgeOpened: false });
		const u = new URL(r.url);
		expect(u.origin).toBe('https://auth.openai.com');
		expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
		expect(await portOpen()).toBe(true);
		expect(api.pendingLoginFor(a.id)).toBe(r.sessionId);

		// not the CLI's address at all: refused before anything is replayed
		await expect(codex.submitCodexCallback(r.sessionId, 'http://evil.example:1455/auth/callback?code=good&state=x')).rejects.toThrow(/localhost:1455/);
		// the CLI's address but from another sign-in: the CLI answers "State mismatch" and keeps waiting
		const stale = await codex.submitCodexCallback(r.sessionId, cb('wrong-state', 'good'));
		expect(stale).toMatchObject({ ok: false });
		expect(stale.message).toMatch(/different or older sign-in/);
		expect(codex.codexSessionStatus(r.sessionId)!.state).toBe('waiting');

		const done = await codex.submitCodexCallback(r.sessionId, cb(stateOf(r.url), 'good'));
		expect(done).toMatchObject({ ok: true, email: 'work@example.com', plan: 'plus' });
		expect(db.getAccount('work')).toMatchObject({ email: 'work@example.com', plan: 'plus' });
		expect(fs.existsSync(path.join(env.home, '.codex-work', 'auth.json'))).toBe(true);
		expect(await portOpen()).toBe(false);
		expect(api.pendingLoginFor(a.id)).toBeNull();

		const snap = await api.snapshot();
		const row = snap.accounts.find((x) => x.id === 'work')!;
		expect(row).toMatchObject({ provider: 'codex', email: 'work@example.com', plan: 'plus', status: { state: 'ok' } });
		expect(JSON.stringify(snap)).not.toMatch(/fake-codex-|secret|refresh_token|id_token/);
	});

	it('local mode: a login the browser completed by itself is reported by the status poll (no paste)', async () => {
		const a = db.createAccount('autologin', 'codex');
		const r = await codex.startCodexLogin(a.id, a.config_dir);
		expect(await until(() => codex.codexSessionStatus(r.sessionId)?.state === 'done')).toBe(true);
		expect(codex.codexSessionStatus(r.sessionId)).toMatchObject({ email: 'autologin@example.com', plan: 'plus' });
		expect(db.getAccount(a.id)!.email).toBe('autologin@example.com');
		// pasting afterwards still reports the success instead of an error
		expect(await codex.submitCodexCallback(r.sessionId, cb(stateOf(r.url), 'good'))).toMatchObject({ ok: true });
	});

	it('no email in the id_token -> "ChatGPT account", never flagged as a duplicate', async () => {
		const a = db.createAccount('anon', 'codex');
		const r = await codex.startCodexLogin(a.id, a.config_dir);
		expect(await codex.submitCodexCallback(r.sessionId, cb(stateOf(r.url), 'noemail'))).toMatchObject({ ok: true, email: null });
		expect(db.getAccount(a.id)!.email).toBe(db.CODEX_NO_EMAIL);
		const b = db.createAccount('anon2', 'codex');
		const r2 = await codex.startCodexLogin(b.id, b.config_dir);
		await codex.submitCodexCallback(r2.sessionId, cb(stateOf(r2.url), 'noemail'));
		const snap = await api.snapshot();
		expect(snap.accounts.find((x) => x.id === 'anon')!.sameEmailAs).toEqual([]);
	});

	it('same email on two Codex rows is flagged; the same email on a Claude row is not', async () => {
		const a = db.createAccount('twin', 'codex');
		const r = await codex.startCodexLogin(a.id, a.config_dir);
		await codex.submitCodexCallback(r.sessionId, cb(stateOf(r.url), 'good:work@example.com'));
		db.setAuth('claude_one', 'work@example.com', 'max');
		const snap = await api.snapshot();
		expect(snap.accounts.find((x) => x.id === 'twin')!.sameEmailAs).toEqual(['Work']);
		expect(snap.accounts.find((x) => x.id === 'claude_one')!.sameEmailAs).toEqual([]);
	});

	it('a rejected sign-in reports the CLI failure', async () => {
		const a = db.createAccount('reject', 'codex');
		const r = await codex.startCodexLogin(a.id, a.config_dir);
		const out = await codex.submitCodexCallback(r.sessionId, cb(stateOf(r.url), 'bad'));
		expect(out.ok).toBe(false);
		expect(out.message).toMatch(/did not finish: token exchange failed/);
		expect(db.getAccount(a.id)!.email).toBeNull();
	});

	it('cancel stops the CLI and frees port 1455; the session is gone afterwards', async () => {
		const a = db.getAccount('reject')!;
		const r = await codex.startCodexLogin(a.id, a.config_dir);
		expect(await portOpen()).toBe(true);
		expect(await api.cancelAnyLogin(r.sessionId)).toBe(true);
		expect(await portOpen()).toBe(false);
		expect(codex.codexSessionStatus(r.sessionId)).toBeNull();
		await expect(codex.submitCodexCallback(r.sessionId, cb(stateOf(r.url), 'good'))).rejects.toThrow(/no longer exists/);
	});

	it('a second Codex login replaces the first (the CLI has one callback port)', async () => {
		const a = db.getAccount('reject')!;
		const b = db.getAccount('anon')!;
		const first = await codex.startCodexLogin(a.id, a.config_dir);
		const second = await codex.startCodexLogin(b.id, b.config_dir);
		expect(codex.codexSessionStatus(first.sessionId)).toBeNull();
		expect(codex.codexSessionStatus(second.sessionId)!.state).toBe('waiting');
		await codex.cancelCodexLogin(second.sessionId);
		expect(await portOpen()).toBe(false);
	});

	it('the temp work folders are removed', async () => {
		const tmp = os.tmpdir();
		const left = () => fs.readdirSync(tmp).filter((n) => n.startsWith('claude-acctmgr-login-codex-'));
		await until(() => left().length === 0);
		expect(left()).toEqual([]);
	});
});
