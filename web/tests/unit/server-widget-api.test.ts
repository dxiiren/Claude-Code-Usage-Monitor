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
		expect(tables).toEqual(['account_usage', 'accounts', 'admin_sessions', 'api_tokens', 'app_settings', 'meta', 'report_accounts', 'usage_samples', 'users']);
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

		const r = await api.handleWidgetRequest(`Bearer ${t.token}`, loggedIn, 1790240820_000);
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

	it('after a restart, an account read within the last interval is not read again at once', () => {
		const [kv, ba] = db.listAccounts().filter((a) => a.enabled);
		const usage = { session: { available: true, percentage: 5, resets_at_unix: null }, weekly: { available: true, percentage: 6, resets_at_unix: null } };
		// ba was read 30 s before the server went down; kv long ago
		store.saveResult(ba.id, { ok: true, usage }, Date.now() - 30_000);
		const p = store.getPoller(); // the first use of the poller in this run, as at start-up
		expect(p.cooldownRemaining(ba.id)).toBeGreaterThan(200);
		expect(p.cooldownRemaining(ba.id)).toBeLessThanOrEqual(270);
		expect(p.cooldownRemaining(kv.id)).toBe(0);
	});

	it('"Refresh now" leaves alone accounts read a moment ago: the provider would refuse and the next reading would be lost', async () => {
		const enabled = db.listAccounts().filter((a) => a.enabled);
		const usage = { session: { available: true, percentage: 5, resets_at_unix: null }, weekly: { available: true, percentage: 6, resets_at_unix: null } };
		for (const a of enabled) store.saveResult(a.id, { ok: true, usage }, Date.now() - 40_000);
		store.resetManualRefresh();
		// no request leaves the server: every account is current
		expect(await store.refreshNow(Date.now(), 50)).toEqual({ refreshed: 0, failed: 0, pending: 0, skipped: 0, fresh: enabled.length, freshSeconds: 120 });
		expect(store.readServerUsage(enabled).byId[enabled[0].id]).toMatchObject({ pollError: null, session: { percentage: 5 } });
	});

	it('paid extra usage and the limits next to the two windows are sent too, and left out when there are none', async () => {
		const t = auth.createToken('extras');
		const acc = db.createAccount('extras acc');
		db.setAuth(acc.id, 'e@x', 'max');
		const now = Date.now();
		const win = (percentage: number) => ({ available: true, percentage, resets_at_unix: 1790456399 });
		store.saveResult(acc.id, { ok: true, usage: { session: win(100), weekly: win(40) } }, now);
		const get = async () =>
			((await api.handleWidgetRequest(`Bearer ${t.token}`, loggedIn, now)).body as { accounts: { id: string; usage: Record<string, unknown> }[] }).accounts.find((a) => a.id === acc.id)!.usage;
		expect(Object.keys(await get()).sort()).toEqual(['session', 'weekly']);
		store.saveResult(
			acc.id,
			{
				ok: true,
				usage: {
					session: win(100),
					weekly: win(40),
					extra: { percentage: 25, remaining: 37.5, total: 50 },
					models: [
						{ label: 'Opus', percentage: 100, resets_at_unix: 1790456399 },
						{ label: 'seven day cowork', percentage: 12, resets_at_unix: null, other: true }
					]
				}
			},
			now
		);
		expect(await get()).toMatchObject({
			credits: { percentage: 25, remaining: 37.5, total: 50 },
			limits: [
				{ label: 'Opus', percentage: 100, resets_at_unix: 1790456399, model: true },
				{ label: 'seven day cowork', percentage: 12, resets_at_unix: null, model: false }
			]
		});
		db.removeAccount(acc.id);
	});

	it('numbers nobody has refreshed for a while are sent as stale, never as current', async () => {
		const ba = db.listAccounts().find((a) => a.id === 'ba')!;
		const read = 1790241000;
		const usage = { session: { available: true, percentage: 3, resets_at_unix: read + 9000 }, weekly: { available: true, percentage: 10, resets_at_unix: read + 90_000 } };
		store.saveResult(ba.id, { ok: true, usage }, read * 1000);
		const t = auth.createToken('pc4');
		const at = async (secondsLater: number) =>
			((await api.handleWidgetRequest(`Bearer ${t.token}`, loggedIn, (read + secondsLater) * 1000)).body as { accounts: { id: string; status: string; status_message: string; usage: unknown }[] }).accounts.find((a) => a.id === 'ba')!;
		expect((await at(60)).status).toBe('ok');
		// no poll failed, the reader just stopped: the widget must not show these as fresh
		const later = await at(2 * 3600);
		expect(later.status).toBe('error');
		expect(later.status_message).toMatch(/No new reading/);
		expect(later.usage).toMatchObject({ session: { percentage: 3 } });
		// the dashboard gets the reading's own time, so it can say how old the numbers are
		expect(store.readServerUsage([ba]).byId[ba.id]).toMatchObject({ readUnix: read });
		store.saveResult(ba.id, { ok: false, error: 'network_error' }, (read + 600) * 1000);
		// a failed attempt has updated nothing: "updated" stays the time of the last good reading
		expect(store.readServerUsage([ba])).toMatchObject({ updatedUnix: read, byId: { [ba.id]: { readUnix: read, session: { percentage: 3 } } } });
		expect(store.staleAfterSeconds()).toBeGreaterThanOrEqual(600);
	});
});
