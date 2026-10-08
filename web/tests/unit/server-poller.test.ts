import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isolateServer } from './helpers';

const env = isolateServer();
type P = typeof import('../../src/lib/server/poller');
let P: P;
let refreshTokenViaCli: (dir: string) => Promise<void>;

const USAGE = 'https://usage.test/api/oauth/usage';
const MESSAGES = 'https://usage.test/v1/messages';

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
}

/** fetch stand-in: records every call, answers from `route`. */
function fakeFetch(route: (url: string, auth: string) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		calls.push({ url, method: init?.method ?? 'GET', headers });
		return route(url, headers.authorization ?? '');
	}) as typeof fetch;
	return { fn, calls };
}

let n = 0;
function account(creds: object | null): string {
	const dir = path.join(env.data, 'accounts', `a${n++}`);
	fs.mkdirSync(dir, { recursive: true });
	if (creds) fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(creds));
	return dir;
}
const future = () => Date.now() + 3600_000;
const okBody = {
	five_hour: { utilization: 12, resets_at: '2026-09-24T12:00:00Z' },
	seven_day: { utilization: 44, resets_at: '2026-09-28T00:00:00.123+00:00' }
};
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });

function deps(f: typeof fetch, refresh: (dir: string) => Promise<void> = async () => undefined, now = Date.now) {
	return { fetch: f, refresh, nowMs: now, usageUrl: USAGE, messagesUrl: MESSAGES };
}

beforeAll(async () => {
	P = await import('../../src/lib/server/poller');
	({ refreshTokenViaCli } = await import('../../src/lib/server/claude'));
});

describe('pollAccount (port of src/poller/claude.rs)', () => {
	it('ok: same endpoint + headers as the widget, parsed into the widget API shape', async () => {
		const dir = account({ claudeAiOauth: { accessToken: 'tok-1', expiresAt: future() } });
		const f = fakeFetch(() => json(okBody));
		const r = await P.pollAccount(dir, deps(f.fn));
		expect(r).toEqual({
			ok: true,
			usage: {
				session: { available: true, percentage: 12, resets_at_unix: Date.parse('2026-09-24T12:00:00Z') / 1000 },
				weekly: { available: true, percentage: 44, resets_at_unix: Math.floor(Date.parse('2026-09-28T00:00:00.123Z') / 1000) }
			}
		});
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]).toMatchObject({
			url: USAGE,
			method: 'GET',
			headers: { authorization: 'Bearer tok-1', 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': P.USER_AGENT }
		});
	});

	it('no credentials file / blank token -> no_credentials, no request', async () => {
		const f = fakeFetch(() => json(okBody));
		expect(await P.pollAccount(account(null), deps(f.fn))).toEqual({ ok: false, error: 'no_credentials' });
		expect(await P.pollAccount(account({ claudeAiOauth: { accessToken: ' ' } }), deps(f.fn))).toEqual({ ok: false, error: 'no_credentials' });
		expect(f.calls).toHaveLength(0);
	});

	it('401 -> {http_status:401}, which status.ts reports as expired', async () => {
		const { loginStatus } = await import('../../src/lib/server/status');
		const dir = account({ claudeAiOauth: { accessToken: 'tok', expiresAt: future() } });
		const r = await P.pollAccount(dir, deps(fakeFetch(() => json({ error: 'x' }, 401)).fn));
		expect(r).toEqual({ ok: false, error: { http_status: 401 } });
		expect(loginStatus({ pollError: !r.ok && r.error, auth: { loggedIn: true, email: 'a@b', plan: 'max' }, everLoggedIn: true }).state).toBe(
			'expired'
		);
	});

	it('429 -> http_status 429 + Retry-After seconds, no Messages fallback (it would spend quota)', async () => {
		const dir = account({ claudeAiOauth: { accessToken: 'tok', expiresAt: future() } });
		const f = fakeFetch(() => json({}, 429, { 'retry-after': '120' }));
		expect(await P.pollAccount(dir, deps(f.fn))).toEqual({ ok: false, error: { http_status: 429 }, retryAfter: 120 });
		expect(f.calls.map((c) => c.url)).toEqual([USAGE]);
	});

	it('network failure -> network_error; garbage body -> unexpected_response', async () => {
		const dir = account({ claudeAiOauth: { accessToken: 'tok', expiresAt: future() } });
		const boom = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
		expect(await P.pollAccount(dir, deps(boom))).toEqual({ ok: false, error: 'network_error' });
		expect(await P.pollAccount(dir, deps(fakeFetch(() => json({ nothing: true })).fn))).toEqual({ ok: false, error: 'unexpected_response' });
	});

	it('endpoint unsupported (404) -> Messages API header probe, like the widget', async () => {
		const dir = account({ claudeAiOauth: { accessToken: 'tok', expiresAt: future() } });
		const f = fakeFetch((url) =>
			url === USAGE
				? json({}, 404)
				: new Response('{}', {
						status: 200,
						headers: {
							'anthropic-ratelimit-unified-5h-utilization': '0.25',
							'anthropic-ratelimit-unified-5h-reset': '1790248799',
							'anthropic-ratelimit-unified-7d-utilization': '0.5',
							'anthropic-ratelimit-unified-7d-reset': '1790456399'
						}
					})
		);
		const r = await P.pollAccount(dir, deps(f.fn));
		expect(r).toEqual({
			ok: true,
			usage: {
				session: { available: true, percentage: 25, resets_at_unix: 1790248799 },
				weekly: { available: true, percentage: 50, resets_at_unix: 1790456399 }
			}
		});
		expect(f.calls[1]).toMatchObject({ url: MESSAGES, method: 'POST', headers: { 'anthropic-version': '2023-06-01' } });
	});

	it('expired token -> the CLI refresh is invoked, then the NEW token is used', async () => {
		const dir = account({ claudeAiOauth: { accessToken: 'old-token', expiresAt: Date.now() - 1000 } });
		fs.writeFileSync(path.join(dir, 'fake-refresh.json'), JSON.stringify({ accessToken: 'new-token' }));
		const f = fakeFetch((_u, auth) => (auth === 'Bearer new-token' ? json(okBody) : json({}, 401)));
		const r = await P.pollAccount(dir, deps(f.fn, refreshTokenViaCli));
		expect(r.ok).toBe(true);
		// The real spawn path ran the fake CLI as `claude -p .` with CLAUDE_CONFIG_DIR = this folder.
		expect(fs.readFileSync(path.join(dir, 'refresh.log'), 'utf8').trim()).toBe('.');
		expect(f.calls.map((c) => c.headers.authorization)).toEqual(['Bearer new-token']);
	});

	it('expired token and the refresh does not help -> token_expired, no request', async () => {
		const dir = account({ claudeAiOauth: { accessToken: 'old-token', expiresAt: Date.now() - 1000 } });
		const f = fakeFetch(() => json(okBody));
		expect(await P.pollAccount(dir, deps(f.fn, refreshTokenViaCli))).toEqual({ ok: false, error: 'token_expired' });
		expect(fs.existsSync(path.join(dir, 'refresh.log'))).toBe(true);
		expect(f.calls).toHaveLength(0);
	});
});

describe('login URL choice (server mode)', () => {
	it('a loopback redirect_uri is recognised; the hosted callback is not', async () => {
		const { isLocalCallback } = await import('../../src/lib/server/claude');
		const u = (r: string) => `https://claude.com/cai/oauth/authorize?code=true&redirect_uri=${encodeURIComponent(r)}`;
		expect(isLocalCallback(u('http://localhost:45849/callback'))).toBe(true);
		expect(isLocalCallback(u('http://127.0.0.1:1/callback'))).toBe(true);
		expect(isLocalCallback(u('https://platform.claude.com/oauth/code/callback'))).toBe(false);
		expect(isLocalCallback('https://claude.com/cai/oauth/authorize?code=true')).toBe(false);
	});
	it('startLogin returns the printed hosted-callback URL, not the one handed to BROWSER', async () => {
		const { startLogin, cancelLogin } = await import('../../src/lib/server/claude');
		const r = await startLogin('urltest', path.join(env.data, 'accounts', 'urltest'));
		try {
			expect(new URL(r.url).searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
			expect(r.edgeOpened).toBe(false);
		} finally {
			await cancelLogin(r.sessionId);
		}
	});
});

describe('parsers', () => {
	it('limits[]: scope-less session / weekly_all fill missing legacy windows', () => {
		expect(
			P.usageFromResponse({
				limits: [
					{ kind: 'session', percent: 7, resets_at: '2026-09-24T12:00:00Z' },
					{ kind: 'weekly_all', utilization: 30 },
					{ kind: 'weekly_model', percent: 90, scope: { model: { id: 'opus' } } }
				]
			})
		).toEqual({
			session: { available: true, percentage: 7, resets_at_unix: Date.parse('2026-09-24T12:00:00Z') / 1000 },
			weekly: { available: true, percentage: 30, resets_at_unix: null },
			models: [{ label: 'opus', percentage: 90, resets_at_unix: null }]
		});
	});
	it('per-model limits are kept: an account can be out of one model while both windows have room', () => {
		const at = '2026-09-28T00:00:00Z';
		const u = P.usageFromResponse({
			five_hour: { utilization: 10, resets_at: at },
			seven_day: { utilization: 60, resets_at: at },
			seven_day_opus: { utilization: 100, resets_at: at },
			seven_day_sonnet: null
		})!;
		expect(u.weekly.percentage).toBe(60);
		expect(u.models).toEqual([{ label: 'Opus', percentage: 100, resets_at_unix: Date.parse(at) / 1000 }]);
		// the array names the model itself and wins over the older field for the same allowance
		const opus5 = { kind: 'weekly_scoped', percent: 100, resets_at: at, scope: { model: { id: 'claude-opus-5', display_name: 'Claude Opus 5' } } };
		const same = P.usageFromResponse({ seven_day: { utilization: 60 }, seven_day_opus: { utilization: 100 }, limits: [opus5] })!;
		expect(same.models).toEqual([{ label: 'Claude Opus 5', percentage: 100, resets_at_unix: Date.parse(at) / 1000 }]);
		const exact = P.usageFromResponse({ seven_day: { utilization: 60 }, seven_day_opus: { utilization: 40 }, limits: [{ ...opus5, scope: { model: { display_name: 'opus' } } }] })!;
		expect(exact.models).toEqual([{ label: 'opus', percentage: 100, resets_at_unix: Date.parse(at) / 1000 }]);
		// ... but a longer name at another level may be another allowance: both stay, so neither can hide a full one
		const both = P.usageFromResponse({ seven_day: { utilization: 60 }, seven_day_opus: { utilization: 100 }, limits: [{ ...opus5, percent: 10 }] })!;
		expect(both.models!.map((m) => [m.label, m.percentage])).toEqual([
			['Opus', 100],
			['Claude Opus 5', 10]
		]);
		// two answers for one limit: the active one wins, then the fullest
		const twice = P.usageFromResponse({
			seven_day: { utilization: 60 },
			limits: [
				{ ...opus5, percent: 90 },
				{ ...opus5, percent: 30, is_active: true },
				{ ...opus5, percent: 20, is_active: true }
			]
		})!;
		expect(twice.models).toEqual([{ label: 'Claude Opus 5', percentage: 30, resets_at_unix: Date.parse(at) / 1000 }]);
		// a weekly and a daily limit of one model are two limits, told apart by their kind
		const kinds = P.usageFromResponse({ seven_day: { utilization: 60 }, limits: [opus5, { ...opus5, kind: 'daily_scoped', percent: 5 }] })!;
		expect(kinds.models!.map((m) => [m.label, m.percentage])).toEqual([
			['Claude Opus 5 (daily scoped)', 5],
			['Claude Opus 5 (weekly scoped)', 100]
		]);
		// limits that are not a model's are kept too, marked as such: older buckets and array entries alike
		const others = P.usageFromResponse({
			five_hour: { utilization: 10 },
			seven_day: { utilization: 20 },
			seven_day_cowork: { utilization: 100, resets_at: at },
			seven_day_oauth_apps: null,
			extra_note: { text: 'not a bucket' },
			limits: [
				{ kind: 'daily_team', percent: 100, scope: { team: 'example' } },
				{ kind: 'monthly', percent: 55 },
				{ kind: 'session', percent: 99 }
			]
		})!;
		expect(others.session.percentage).toBe(10);
		expect(others.models).toEqual([
			{ label: 'daily team', percentage: 100, resets_at_unix: null, other: true },
			{ label: 'monthly', percentage: 55, resets_at_unix: null, other: true },
			{ label: 'seven day cowork', percentage: 100, resets_at_unix: Date.parse(at) / 1000, other: true }
		]);
		// two limits of one kind for different scopes are told apart by what the scope names, or numbered
		const teams = P.usageFromResponse({
			seven_day: { utilization: 20 },
			extra_usage: { is_enabled: true, utilization: 3 },
			limits: [
				{ kind: 'team', percent: 9, scope: { team: 'a' } },
				{ kind: 'team', percent: 3, scope: { team: 'b' } },
				{ kind: 'pool', percent: 1, scope: { id: [1] } },
				{ kind: 'pool', percent: 2, scope: { id: [2] } }
			]
		})!;
		// extra_usage is the paid-usage switch, not an allowance
		expect(teams.models!.map((m) => m.label).sort()).toEqual(['pool 1', 'pool 2', 'team (a)', 'team (b)']);
		// ... also when the provider's own names already look numbered
		const odd = P.usageFromResponse({
			seven_day: { utilization: 20 },
			limits: [
				{ kind: 'foo', percent: 1, scope: { t: 'x' } },
				{ kind: 'foo', percent: 2, scope: { g: 'x' } },
				{ kind: 'foo (x) 1', percent: 3 },
				{ kind: 'bar', percent: 4 },
				{ kind: 'bar', percent: 5, scope: { a: [1] } },
				{ kind: 'bar 1', percent: 6 }
			]
		})!;
		const names = odd.models!.map((m) => m.label.toLowerCase());
		expect(new Set(names).size).toBe(names.length);
		// an answer made only of such a bucket is still an answer
		expect(P.usageFromResponse({ seven_day_cowork: { utilization: 5 } })).toMatchObject({ models: [{ label: 'seven day cowork', other: true }] });
		// no per-model limit in the answer: the field is left out, as before
		expect(P.usageFromResponse({ five_hour: { utilization: 1 }, seven_day: { utilization: 2 } })).not.toHaveProperty('models');
	});
	it('a window that is present but unreadable fails the answer instead of reading as "no data"', () => {
		// an absent or null window is fine: some plans have one window only
		expect(P.usageFromResponse({ five_hour: { utilization: 10, resets_at: null }, seven_day: null })).toMatchObject({ session: { available: true, percentage: 10 }, weekly: { available: false } });
		// "100" as text would otherwise show the weekly bar as "no data" while the account is blocked
		expect(P.usageFromResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: '100' } })).toBeNull();
		expect(P.usageFromResponse({ five_hour: 'soon', seven_day: { utilization: 50 } })).toBeNull();
	});
	it('paid extra usage past a spent window is kept, so the account is not called blocked while it still works', () => {
		const spend = { enabled: true, used: { amount_minor: 1250, exponent: 2 }, limit: { amount_minor: 5000, exponent: 2 } };
		const spent = P.usageFromResponse({ five_hour: { utilization: 20 }, seven_day: { utilization: 100 }, spend })!;
		expect(spent.extra).toEqual({ percentage: 25, remaining: 37.5, total: 50 });
		// no window is spent yet, the paid amount is untouched, or the option is off: nothing to show
		expect(P.usageFromResponse({ five_hour: { utilization: 20 }, seven_day: { utilization: 60 }, spend })).not.toHaveProperty('extra');
		expect(P.usageFromResponse({ five_hour: { utilization: 100 }, seven_day: { utilization: 60 }, spend: { ...spend, used: { amount_minor: 0, exponent: 2 } } })).not.toHaveProperty('extra');
		expect(P.usageFromResponse({ five_hour: { utilization: 100 }, seven_day: { utilization: 60 }, spend: { ...spend, enabled: false } })).not.toHaveProperty('extra');
		expect(P.usageFromResponse({ five_hour: { utilization: 100 }, seven_day: { utilization: 60 }, spend: null })).not.toHaveProperty('extra');
		// all of it used: kept, with nothing remaining, so the screen can say it has run out as well
		const out = P.usageFromResponse({ five_hour: { utilization: 100 }, seven_day: { utilization: 60 }, spend: { ...spend, used: { amount_minor: 5000, exponent: 2 } } })!;
		expect(out.extra).toEqual({ percentage: 100, remaining: 0, total: 50 });
	});
	it('Retry-After: seconds, HTTP date, cap 24 h, junk ignored', () => {
		const now = Date.parse('2026-09-24T00:00:00Z');
		expect(P.parseRetryAfter('30', now)).toBe(30);
		expect(P.parseRetryAfter('Thu, 24 Sep 2026 00:01:00 GMT', now)).toBe(60);
		expect(P.parseRetryAfter('999999', now)).toBe(86400);
		expect(P.parseRetryAfter('soon', now)).toBeNull();
		expect(P.parseRetryAfter(null, now)).toBeNull();
		expect(P.parseRetryAfter('0', now)).toBeNull();
	});
	it('rejected status header with a five_hour claim reads as 100%', () => {
		const h = new Headers({
			'anthropic-ratelimit-unified-status': 'rejected',
			'anthropic-ratelimit-unified-representative-claim': 'five_hour',
			'anthropic-ratelimit-unified-reset': '1790248799'
		});
		expect(P.usageFromHeaders(h).session).toEqual({ available: true, percentage: 100, resets_at_unix: 1790248799 });
	});
});

describe('Poller scheduling', () => {
	it('429 backoff: honours Retry-After, skips the account until then, then polls again', async () => {
		let now = 1_000_000_000_000;
		const dir = account({ claudeAiOauth: { accessToken: 'tok', expiresAt: now + 3600_000 } });
		let answer: Response | (() => Response) = () => json({}, 429, { 'retry-after': '600' });
		const f = fakeFetch(() => (typeof answer === 'function' ? answer() : answer));
		const saved: unknown[] = [];
		const p = new P.Poller({ targets: () => [{ id: 'x', configDir: dir }], save: (_id, r) => saved.push(r) }, deps(f.fn, async () => undefined, () => now), 300, 0, async () => undefined);
		await p.cycle();
		expect(saved).toEqual([{ ok: false, error: { http_status: 429 }, retryAfter: 600 }]);
		expect(p.cooldownRemaining('x')).toBe(600);
		now += 300_000; // next cycle, still inside Retry-After
		await p.cycle();
		expect(f.calls).toHaveLength(1);
		expect(saved).toHaveLength(1);
		now += 301_000;
		answer = () => json(okBody);
		await p.cycle();
		expect(f.calls).toHaveLength(2);
		expect(saved[1]).toMatchObject({ ok: true });
		expect(p.cooldownRemaining('x')).toBe(0);
	});
	it('an account the previous run read a moment ago is left alone at start-up', async () => {
		let now = 4_000_000_000_000;
		const dir = account({ claudeAiOauth: { accessToken: 'tok', expiresAt: now + 3600_000 } });
		const f = fakeFetch(() => json(okBody));
		const p = new P.Poller({ targets: () => [{ id: 'h', configDir: dir }], save: () => undefined }, deps(f.fn, async () => undefined, () => now), 120, 0, async () => undefined);
		p.hold('h', now + 50_000); // read 70 s ago, with readings every 120 s
		await p.cycle();
		expect(f.calls).toHaveLength(0);
		expect(p.cooldownRemaining('h')).toBe(50);
		// a hold in the past changes nothing, and never shortens a wait already in force
		p.hold('h', now - 1);
		expect(p.cooldownRemaining('h')).toBe(50);
		now += 120_000;
		await p.cycle();
		expect(f.calls).toHaveLength(1);
		// a login reads the account straight away whatever the hold says
		p.hold('h', now + 60_000);
		expect(await p.pollOne({ id: 'h', configDir: dir }, true)).toBe(true);
	});
	it('pollOne says whether a new reading was saved', async () => {
		const now = 3_000_000_000_000;
		const dir = account({ claudeAiOauth: { accessToken: 'tok', expiresAt: now + 3600_000 } });
		let answer = () => json(okBody);
		const p = new P.Poller({ targets: () => [], save: () => undefined }, deps(fakeFetch(() => answer()).fn, async () => undefined, () => now), 300, 0, async () => undefined);
		expect(await p.pollOne({ id: 'z', configDir: dir })).toBe(true);
		answer = () => json({}, 429, { 'retry-after': '600' });
		expect(await p.pollOne({ id: 'z', configDir: dir })).toBe(false);
		// inside the cooldown nothing is asked at all
		expect(await p.pollOne({ id: 'z', configDir: dir })).toBe(false);
	});
	it('429 without Retry-After backs off interval * 2^(n-1), capped at 1 h', async () => {
		let now = 2_000_000_000_000;
		const dir = account({ claudeAiOauth: { accessToken: 'tok', expiresAt: now + 3600_000 * 24 } });
		const f = fakeFetch(() => json({}, 429));
		const p = new P.Poller({ targets: () => [{ id: 'y', configDir: dir }], save: () => undefined }, deps(f.fn, async () => undefined, () => now), 300, 0, async () => undefined);
		const waits: number[] = [];
		for (let i = 0; i < 5; i++) {
			await p.pollOne({ id: 'y', configDir: dir }, true);
			waits.push(p.cooldownRemaining('y'));
			now += waits[i] * 1000;
		}
		expect(waits).toEqual([300, 600, 1200, 2400, 3600]);
	});
	it('staggers accounts across the interval (bounded gap), one at a time', async () => {
		const dirs = [0, 1, 2].map(() => account({ claudeAiOauth: { accessToken: 'tok', expiresAt: future() } }));
		const sleeps: number[] = [];
		const f = fakeFetch(() => json(okBody));
		const p = new P.Poller(
			{ targets: () => dirs.map((d, i) => ({ id: `s${i}`, configDir: d })), save: () => undefined },
			deps(f.fn),
			300,
			15_000,
			async (ms) => void sleeps.push(ms)
		);
		await p.cycle();
		expect(f.calls).toHaveLength(3);
		expect(sleeps).toEqual([15_000, 15_000]);
	});
});
