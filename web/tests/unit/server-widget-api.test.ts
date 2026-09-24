import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkServerRequest } from '../../src/lib/server/guard';
import { isolateServer } from './helpers';

const env = isolateServer();
type Db = typeof import('../../src/lib/server/db');
type Paths = typeof import('../../src/lib/server/paths');
let db: Db;
let paths: Paths;
let auth: typeof import('../../src/lib/server/auth');
let store: typeof import('../../src/lib/server/serverUsage');
let api: typeof import('../../src/lib/server/widgetApi');

const loggedIn = async () => ({ loggedIn: true, email: 'x@y', plan: 'max' });

beforeAll(async () => {
	db = await import('../../src/lib/server/db');
	paths = await import('../../src/lib/server/paths');
	auth = await import('../../src/lib/server/auth');
	store = await import('../../src/lib/server/serverUsage');
	api = await import('../../src/lib/server/widgetApi');
	db.initDb();
});

describe('server-mode data layout', () => {
	it('accounts.db lives in the data dir; config dirs are <data>/accounts/<id>; no widget files written', () => {
		const a = db.createAccount('Work Mail');
		expect(a.id).toBe('work_mail');
		expect(a.config_dir).toBe(path.join(env.data, 'accounts', 'work_mail'));
		expect(fs.existsSync(path.join(env.data, 'accounts.db'))).toBe(true);
		for (const f of ['settings.json', 'themes', 'context-menus']) expect(fs.existsSync(path.join(env.data, f))).toBe(false);
		const meta = db.getMeta();
		expect(meta).toMatchObject({ schema: '2', manager_url: 'https://claude.example.com' });
		// contract schema unchanged for the widget; server tables are extra
		const d = new DatabaseSync(path.join(env.data, 'accounts.db'), { readOnly: true });
		const cols = (d.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((c) => c.name);
		const mode = (d.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
		const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
		d.close();
		expect(cols).toEqual(['id', 'name', 'config_dir', 'email', 'plan', 'enabled', 'sort_order', 'created_at', 'updated_at', 'provider']);
		expect(mode).toBe('delete');
		expect(tables).toEqual(['account_usage', 'accounts', 'admin_sessions', 'api_tokens', 'meta']);
	});

	it('ids are never reused, even after removal', () => {
		const a = db.createAccount('reuse');
		db.removeAccount(a.id);
		expect(db.createAccount('reuse').id).toBe('reuse_2');
	});

	it('removal deletes only <data>/accounts/<id> of that row', () => {
		const a = db.createAccount('gone');
		fs.mkdirSync(path.join(a.config_dir, 'sub'), { recursive: true });
		const r = db.removeAccount(a.id);
		expect(r.folderDeleted).toBe(true);
		expect(fs.existsSync(a.config_dir)).toBe(false);
		expect(fs.existsSync(path.join(env.data, 'accounts'))).toBe(true);
		expect(fs.existsSync(path.join(env.data, 'accounts.db'))).toBe(true);
	});

	it('a row pointing anywhere else is never deleted', () => {
		const a = db.createAccount('pointer');
		const elsewhere = path.join(env.data, 'accounts', 'someone_else');
		fs.mkdirSync(elsewhere, { recursive: true });
		db.database().prepare('UPDATE accounts SET config_dir = ? WHERE id = ?').run(elsewhere, a.id);
		const r = db.removeAccount(a.id);
		expect(r.folderDeleted).toBe(false);
		expect(fs.existsSync(elsewhere)).toBe(true);
	});

	it('deletion guard: only direct [a-z0-9_] children of <data>/accounts', () => {
		const acc = path.join(env.data, 'accounts');
		expect(paths.isDeletableConfigDir(path.join(acc, 'ba'))).toBe(true);
		expect(paths.isDeletableConfigDir(acc)).toBe(false);
		expect(paths.isDeletableConfigDir(env.data)).toBe(false);
		expect(paths.isDeletableConfigDir(path.join(acc, 'ba', 'x'))).toBe(false);
		expect(paths.isDeletableConfigDir(path.join(acc, '..', 'accounts.db'))).toBe(false);
		expect(paths.isDeletableConfigDir(path.join(acc, 'Ba'))).toBe(false);
		expect(paths.isDeletableConfigDir(path.join(acc, 'b-a'))).toBe(false);
		expect(paths.isDeletableConfigDir(path.join(env.root, 'ba'))).toBe(false);
	});
});

describe('server Origin / Host guard', () => {
	const O = 'https://claude.example.com';
	it('accepts the public host (with or without the default port) and exact-Origin mutations', () => {
		expect(checkServerRequest('GET', 'claude.example.com', null, O)).toEqual({ action: 'allow' });
		expect(checkServerRequest('GET', 'claude.example.com:443', null, O)).toEqual({ action: 'allow' });
		expect(checkServerRequest('POST', 'claude.example.com', 'https://claude.example.com', O)).toEqual({ action: 'allow' });
	});
	it('rejects other hosts, foreign / missing / http Origins on mutations, and never redirects', () => {
		expect(checkServerRequest('GET', 'evil.example', null, O)).toEqual({ action: 'deny', reason: 'host' });
		expect(checkServerRequest('GET', '127.0.0.1:47291', null, O)).toEqual({ action: 'deny', reason: 'host' });
		for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(checkServerRequest(m, 'claude.example.com', null, O)).toEqual({ action: 'deny', reason: 'origin' });
			expect(checkServerRequest(m, 'claude.example.com', 'https://evil.example', O)).toEqual({ action: 'deny', reason: 'origin' });
			expect(checkServerRequest(m, 'claude.example.com', 'http://claude.example.com', O)).toEqual({ action: 'deny', reason: 'origin' });
		}
	});
	it('works for an http origin with an explicit port', () => {
		const L = 'http://127.0.0.1:47391';
		expect(checkServerRequest('POST', '127.0.0.1:47391', L, L)).toEqual({ action: 'allow' });
		expect(checkServerRequest('GET', 'localhost:47391', null, L)).toEqual({ action: 'deny', reason: 'host' });
	});
});

describe('GET /api/v1/widget', () => {
	it('401 for missing, unknown or revoked tokens', async () => {
		expect((await api.handleWidgetRequest(null, loggedIn)).status).toBe(401);
		expect((await api.handleWidgetRequest('Bearer nope', loggedIn)).status).toBe(401);
		const t = auth.createToken('pc');
		auth.revokeToken(t.id);
		expect((await api.handleWidgetRequest(`Bearer ${t.token}`, loggedIn)).status).toBe(401);
	});

	it('200 with exactly the contract shape: enabled accounts only, in sort_order', async () => {
		for (const a of db.listAccounts()) db.removeAccount(a.id);
		const ba = db.createAccount('ba');
		const kv = db.createAccount('kv');
		const off = db.createAccount('off');
		db.setAuth(ba.id, 'x@y', 'max');
		db.setAuth(kv.id, 'k@v', 'pro');
		db.setEnabled(off.id, false);
		db.moveAccount(kv.id, 'up'); // kv before ba
		const usage = {
			session: { available: true, percentage: 12, resets_at_unix: 1790248799 },
			weekly: { available: true, percentage: 44, resets_at_unix: 1790456399 }
		};
		store.saveResult(ba.id, { ok: true, usage }, 1790240810_000);
		store.saveResult(kv.id, { ok: false, error: { http_status: 401 } }, 1790240700_000);
		const t = auth.createToken('pc2');
		const rev = Number(db.getMeta().revision);

		const r = await api.handleWidgetRequest(`Bearer ${t.token}`, loggedIn);
		expect(r.status).toBe(200);
		expect(r.body).toEqual({
			schema: 2,
			revision: rev, // poll results never bump the revision
			updated_unix: 1790240810,
			manager_url: 'https://claude.example.com',
			card_theme: 'auto',
			accounts: [
				{
					id: 'kv',
					name: 'kv',
					email: 'k@v',
					plan: 'pro',
					provider: 'claude',
					status: 'expired',
					status_message: 'Claude rejected the saved login (HTTP 401).',
					usage: null
				},
				{ id: 'ba', name: 'ba', provider: 'claude', email: 'x@y', plan: 'max', status: 'ok', status_message: '', usage }
			]
		});
		expect(JSON.stringify(r.body)).not.toContain(t.token);
	});

	it('a failed poll keeps the last good usage; logged_out comes from missing credentials', async () => {
		const [kv, ba] = db.listAccounts().filter((a) => a.enabled);
		store.saveResult(ba.id, { ok: false, error: 'network_error' }, 1790240900_000);
		store.saveResult(kv.id, { ok: false, error: 'no_credentials' }, 1790240900_000);
		const t = auth.createToken('pc3');
		const body = (await api.handleWidgetRequest(`Bearer ${t.token}`, loggedIn)).body as { updated_unix: number; accounts: { status: string; usage: unknown }[] };
		expect(body.updated_unix).toBe(1790240900);
		expect(body.accounts.map((a) => a.status)).toEqual(['logged_out', 'error']);
		expect(body.accounts[1].usage).toMatchObject({ session: { percentage: 12 } });
	});
});
