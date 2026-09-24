// Server mode, Codex: the usage poller (port of src/poller/codex.rs), the scheduler's provider
// dispatch, the CLI token refresh, and the widget API's provider field. No login runs here (the
// login flow owns port 1455 in codex.test.ts / the e2e suites).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isolateServer } from './helpers';

const env = isolateServer();
type P = typeof import('../../src/lib/server/poller');
let P: P;
let codex: typeof import('../../src/lib/server/codex');

const CODEX_URL = 'https://chatgpt.test/backend-api/wham/usage';

interface Call {
	url: string;
	headers: Record<string, string>;
}
function fakeFetch(route: (auth: string, n: number) => Response) {
	const calls: Call[] = [];
	const fn = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
		return route(calls[calls.length - 1].headers.authorization ?? '', calls.length);
	}) as typeof fetch;
	return { fn, calls };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });

let n = 0;
function home(auth: object | null): string {
	const dir = path.join(env.data, 'accounts', `c${n++}`);
	fs.mkdirSync(dir, { recursive: true });
	if (auth) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
	return dir;
}
const authJson = (access: string, accountId: string | null = 'acct-1') => ({
	auth_mode: 'chatgpt',
	tokens: { id_token: 'x.e30.y', access_token: access, refresh_token: 'r', account_id: accountId }
});
function deps(f: typeof fetch, refreshCodex: (dir: string) => Promise<void> = async () => undefined) {
	return {
		fetch: f,
		refresh: async () => undefined,
		refreshCodex,
		nowMs: Date.now,
		usageUrl: 'https://unused.test/claude',
		messagesUrl: 'https://unused.test/messages',
		codexUsageUrl: CODEX_URL
	};
}
const body = (primary: object | null, secondary: object | null) => ({ rate_limit: { primary_window: primary, secondary_window: secondary } });

beforeAll(async () => {
	P = await import('../../src/lib/server/poller');
	codex = await import('../../src/lib/server/codex');
});

describe('pollCodexAccount (port of src/poller/codex.rs)', () => {
	it('same endpoint + headers as the widget (Bearer, User-Agent codex-cli, ChatGPT-Account-Id)', async () => {
		const f = fakeFetch(() => json(body({ used_percent: 20, limit_window_seconds: 18000, reset_at: 1787100000 }, { used_percent: 80, limit_window_seconds: 604800, reset_at: 1787198224 })));
		const r = await P.pollCodexAccount(home(authJson('tok-a')), deps(f.fn));
		expect(r).toEqual({
			ok: true,
			usage: {
				session: { available: true, percentage: 20, resets_at_unix: 1787100000 },
				weekly: { available: true, percentage: 80, resets_at_unix: 1787198224 }
			}
		});
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0].url).toBe(CODEX_URL);
		expect(f.calls[0].headers).toMatchObject({ authorization: 'Bearer tok-a', 'user-agent': 'codex-cli', 'chatgpt-account-id': 'acct-1' });
		expect(P.CODEX_USAGE_URL).toBe('https://chatgpt.com/backend-api/wham/usage');
	});

	it('no account id -> no ChatGPT-Account-Id header', async () => {
		const f = fakeFetch(() => json(body({ used_percent: 1, reset_at: 1 }, null)));
		await P.pollCodexAccount(home(authJson('tok', null)), deps(f.fn));
		expect(f.calls[0].headers['chatgpt-account-id']).toBeUndefined();
	});

	it('window mapping: by length, not slot; unlabelled keeps primary=session/secondary=weekly; reset_at < 0 = none', () => {
		const m = (b: unknown) => P.codexUsageFromResponse(b)!;
		// a lone weekly window in primary lands in the weekly bar
		expect(m(body({ used_percent: 100, limit_window_seconds: 604800, reset_at: 1787198224 }, null))).toEqual({
			session: { available: false, percentage: 0, resets_at_unix: null },
			weekly: { available: true, percentage: 100, resets_at_unix: 1787198224 }
		});
		// swapped slots
		const sw = m(body({ used_percent: 80, limit_window_seconds: 604800, reset_at: 2 }, { used_percent: 20, limit_window_seconds: 18000, reset_at: 1 }));
		expect([sw.session.percentage, sw.weekly.percentage]).toEqual([20, 80]);
		// zero usage with no usable reset is still available
		expect(m(body({ used_percent: 0, limit_window_seconds: 18000, reset_at: -1 }, null)).session).toEqual({ available: true, percentage: 0, resets_at_unix: null });
		// unlabelled windows
		const un = m(body({ used_percent: 20, reset_at: 1 }, { used_percent: 80, reset_at: 2 }));
		expect([un.session.percentage, un.weekly.percentage]).toEqual([20, 80]);
		expect(P.codexUsageFromResponse({})).toBeNull();
		expect(P.codexUsageFromResponse({ rate_limit: null })).toBeNull();
	});

	it('401 -> refresh via the CLI, re-read auth.json, retry once with the new token', async () => {
		const dir = home(authJson('old-tok'));
		const refreshed: string[] = [];
		const f = fakeFetch((auth) => (auth.includes('old-tok') ? json({}, 401) : json(body({ used_percent: 5, limit_window_seconds: 18000, reset_at: 9 }, null))));
		const r = await P.pollCodexAccount(
			dir,
			deps(f.fn, async (d) => {
				refreshed.push(d);
				fs.writeFileSync(path.join(d, 'auth.json'), JSON.stringify(authJson('new-tok')));
			})
		);
		expect(r.ok).toBe(true);
		expect(refreshed).toEqual([dir]);
		expect(f.calls.map((c) => c.headers.authorization)).toEqual(['Bearer old-tok', 'Bearer new-tok']);
	});

	it('still rejected after the refresh -> auth_required (the account shows as expired)', async () => {
		const f = fakeFetch(() => json({}, 403));
		const r = await P.pollCodexAccount(home(authJson('t')), deps(f.fn));
		expect(r).toEqual({ ok: false, error: 'auth_required' });
		expect(f.calls).toHaveLength(2);
	});

	it('refresh left no credentials -> token_expired; no auth.json at all -> no_credentials', async () => {
		const dir = home(authJson('t'));
		const f = fakeFetch(() => json({}, 401));
		expect(await P.pollCodexAccount(dir, deps(f.fn, async (d) => fs.rmSync(path.join(d, 'auth.json'))))).toEqual({ ok: false, error: 'token_expired' });
		expect(await P.pollCodexAccount(home(null), deps(fakeFetch(() => json({})).fn))).toEqual({ ok: false, error: 'no_credentials' });
		expect(await P.pollCodexAccount(home({ tokens: { access_token: '  ' } }), deps(fakeFetch(() => json({})).fn))).toEqual({ ok: false, error: 'no_credentials' });
	});

	it('429 honours Retry-After (scheduler backoff); other failures are request_failed / network_error', async () => {
		const r = await P.pollCodexAccount(home(authJson('t')), deps(fakeFetch(() => json({}, 429, { 'retry-after': '120' })).fn));
		expect(r).toEqual({ ok: false, error: { http_status: 429 }, retryAfter: 120 });
		expect(await P.pollCodexAccount(home(authJson('t')), deps(fakeFetch(() => json({}, 404)).fn))).toEqual({ ok: false, error: 'request_failed' });
		expect(await P.pollCodexAccount(home(authJson('t')), deps(fakeFetch(() => new Response('not json')).fn))).toEqual({ ok: false, error: 'request_failed' });
		const boom = (async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch;
		expect(await P.pollCodexAccount(home(authJson('t')), deps(boom))).toEqual({ ok: false, error: 'network_error' });
	});

	it('the scheduler polls codex targets with the Codex poller and backs off on 429', async () => {
		const saved: [string, unknown][] = [];
		const dir = home(authJson('t'));
		const f = fakeFetch(() => json({}, 429, { 'retry-after': '600' }));
		const poller = new P.Poller({ targets: () => [{ id: 'cx', configDir: dir, provider: 'codex' }], save: (id, r) => saved.push([id, r]) }, deps(f.fn), 300, 0, async () => undefined);
		await poller.cycle();
		expect(f.calls[0].url).toBe(CODEX_URL);
		expect(saved[0]).toEqual(['cx', { ok: false, error: { http_status: 429 }, retryAfter: 600 }]);
		expect(poller.cooldownRemaining('cx')).toBeGreaterThan(590);
		await poller.cycle(); // in cooldown: not polled again
		expect(f.calls).toHaveLength(1);
	});
});

describe('token refresh by invoking the CLI (never the OAuth endpoint)', () => {
	it('runs `codex app-server` account/read {refreshToken: true} with CODEX_HOME set', async () => {
		const dir = home(authJson('before'));
		fs.writeFileSync(path.join(dir, 'fake-refresh.json'), JSON.stringify({ accessToken: 'after' }));
		const argsLog = path.join(dir, 'args.log');
		process.env.FAKE_CODEX_ARGS_LOG = argsLog;
		await codex.refreshCodexTokenViaCli(dir);
		expect(await codex.codexAuthStatusOrNull(dir)).toMatchObject({ loggedIn: true });
		delete process.env.FAKE_CODEX_ARGS_LOG;
		// every CLI call keeps the login in auth.json (never the OS keyring the widget cannot read)
		const calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
		expect(calls).toEqual([
			{ config: ['cli_auth_credentials_store=file'], args: ['app-server'] },
			{ config: ['cli_auth_credentials_store=file'], args: ['login', 'status'] }
		]);
		expect(fs.readFileSync(path.join(dir, 'refresh.log'), 'utf8').trim()).toBe('refresh');
		expect(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).tokens.access_token).toBe('after');
	});
});

describe('GET /api/v1/widget carries provider', () => {
	it('codex rows say "provider": "codex", claude rows "claude"; usage from the codex poll', async () => {
		const db = await import('../../src/lib/server/db');
		const auth = await import('../../src/lib/server/auth');
		const store = await import('../../src/lib/server/serverUsage');
		const api = await import('../../src/lib/server/widgetApi');
		db.initDb();
		const cl = db.createAccount('cl');
		const cx = db.createAccount('cx', 'codex');
		expect(cx.config_dir).toBe(path.join(env.data, 'accounts', 'cx'));
		db.setAuth(cl.id, 'a@b', 'max');
		db.setAuth(cx.id, 'c@d', 'plus');
		const usage = { session: { available: true, percentage: 7, resets_at_unix: 1 }, weekly: { available: true, percentage: 33, resets_at_unix: 2 } };
		store.saveResult(cx.id, { ok: true, usage }, Date.now());
		store.saveResult(cl.id, { ok: false, error: 'auth_required' }, Date.now());
		const t = auth.createToken('pc');
		const seen: [string, string][] = [];
		const r = await api.handleWidgetRequest(`Bearer ${t.token}`, async (dir, provider) => {
			seen.push([path.basename(dir), provider]);
			return { loggedIn: true, email: null, plan: null };
		});
		const b = r.body as { schema: number; accounts: Record<string, unknown>[] };
		expect(b.schema).toBe(2);
		expect(b.accounts).toEqual([
			expect.objectContaining({ id: 'cl', provider: 'claude', status: 'expired', status_message: 'Claude rejected the saved login.' }),
			expect.objectContaining({ id: 'cx', provider: 'codex', email: 'c@d', plan: 'plus', status: 'ok', usage })
		]);
		expect(seen).toEqual([
			['cl', 'claude'],
			['cx', 'codex']
		]);
		// codex messages name ChatGPT, not Claude
		store.saveResult(cx.id, { ok: false, error: 'auth_required' }, Date.now());
		const r2 = (await api.handleWidgetRequest(`Bearer ${t.token}`, async () => ({ loggedIn: true, email: null, plan: null }))).body as {
			accounts: { id: string; status_message: string }[];
		};
		expect(r2.accounts.find((a) => a.id === 'cx')!.status_message).toBe('ChatGPT rejected the saved login.');
		// removing a codex row deletes only its own <data>/accounts/<id>
		fs.mkdirSync(cx.config_dir, { recursive: true });
		fs.writeFileSync(path.join(cx.config_dir, 'auth.json'), '{}');
		expect(db.removeAccount(cx.id).folderDeleted).toBe(true);
		expect(fs.existsSync(cx.config_dir)).toBe(false);
	});
});
