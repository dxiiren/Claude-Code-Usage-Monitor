import { describe, expect, it } from 'vitest';
import { AuthStatusCache, classifyPollError, loginStatus, needsLogin, type AuthSnapshot } from '../../src/lib/server/status';

const IN: AuthSnapshot = { loggedIn: true, email: 'a@example.com', plan: 'max' };
const OUT: AuthSnapshot = { loggedIn: false, email: null, plan: null };

describe('classifyPollError: every serialized PollError kind (src/poller.rs)', () => {
	const cases: [unknown, string | null][] = [
		[null, null],
		[undefined, null],
		['token_expired', 'expired'],
		['auth_required', 'expired'],
		[{ http_status: 401 }, 'expired'],
		[{ http_status: 403 }, 'expired'],
		['no_credentials', 'logged_out'],
		['network_error', 'transient'],
		['request_failed', 'transient'],
		['unexpected_response', 'transient'],
		[{ http_status: 429 }, 'transient'],
		[{ http_status: 500 }, 'transient'],
		['something_new', 'transient'],
		[{ weird: true }, 'transient']
	];
	for (const [raw, kind] of cases) {
		it(`${JSON.stringify(raw) ?? 'undefined'} -> ${kind}`, () => {
			const r = classifyPollError(raw);
			expect(r?.kind ?? null).toBe(kind);
			if (r) expect(r.message.length).toBeGreaterThan(0);
		});
	}
	it('429 says rate limited', () => {
		expect(classifyPollError({ http_status: 429 })!.message).toMatch(/rate limited/);
	});
});

describe('loginStatus combines the poll error and claude auth status', () => {
	it('ok when both are fine', () => {
		expect(loginStatus({ pollError: null, auth: IN, everLoggedIn: true })).toEqual({ state: 'ok', message: '' });
	});
	it('expired poll error wins even while the CLI still lists a login', () => {
		for (const e of ['token_expired', 'auth_required', { http_status: 401 }, { http_status: 403 }])
			expect(loginStatus({ pollError: e, auth: IN, everLoggedIn: true }).state).toBe('expired');
		expect(loginStatus({ pollError: 'token_expired', auth: OUT, everLoggedIn: true }).state).toBe('expired');
	});
	it('logged_out from no_credentials or loggedIn=false', () => {
		expect(loginStatus({ pollError: 'no_credentials', auth: IN, everLoggedIn: true }).state).toBe('logged_out');
		expect(loginStatus({ pollError: null, auth: OUT, everLoggedIn: true }).state).toBe('logged_out');
		expect(loginStatus({ pollError: 'network_error', auth: OUT, everLoggedIn: true }).state).toBe('logged_out');
	});
	it('transient errors are "error" (shown, but no re-login asked)', () => {
		const s = loginStatus({ pollError: 'network_error', auth: IN, everLoggedIn: true });
		expect(s.state).toBe('error');
		expect(needsLogin(s.state)).toBe(false);
		expect(loginStatus({ pollError: { http_status: 429 }, auth: IN, everLoggedIn: true }).state).toBe('error');
	});
	it('unknown auth (CLI unavailable) is ignored, unless the account never logged in', () => {
		expect(loginStatus({ pollError: null, auth: null, everLoggedIn: true }).state).toBe('ok');
		expect(loginStatus({ pollError: null, auth: null, everLoggedIn: false }).state).toBe('logged_out');
	});
	it('needsLogin only for expired + logged_out', () => {
		expect(['ok', 'expired', 'logged_out', 'error'].map((s) => needsLogin(s as never))).toEqual([false, true, true, false]);
	});
});

describe('AuthStatusCache', () => {
	function setup(ttl = 60_000) {
		let t = 1_000_000;
		const calls: string[] = [];
		let answer: AuthSnapshot | null = IN;
		const cache = new AuthStatusCache(
			async (dir) => {
				calls.push(dir);
				return answer;
			},
			ttl,
			() => t
		);
		return {
			cache,
			calls,
			tick: (ms: number) => (t += ms),
			set: (v: AuthSnapshot | null) => (answer = v)
		};
	}

	it('first read waits for the CLI; later reads inside the TTL do not spawn it', async () => {
		const { cache, calls, tick } = setup();
		expect(await cache.get('A')).toEqual(IN);
		for (let i = 0; i < 4; i++) {
			tick(14_000); // page polls every 15 s
			expect(await cache.get('A')).toEqual(IN);
		}
		expect(calls).toEqual(['A']);
	});

	it('concurrent first reads share one CLI call; folders are cached separately', async () => {
		const { cache, calls } = setup();
		await Promise.all([cache.get('A'), cache.get('A'), cache.get('B')]);
		expect(calls).toEqual(['A', 'B']);
	});

	it('after the TTL: returns the stale value at once and refreshes once in the background', async () => {
		const { cache, calls, tick, set } = setup();
		await cache.get('A');
		tick(61_000);
		set(OUT);
		expect(await cache.get('A')).toEqual(IN); // stale, no wait
		expect(await cache.get('A')).toEqual(IN); // refresh already in flight: not started twice
		await new Promise((r) => setTimeout(r, 0));
		expect(await cache.get('A')).toEqual(OUT);
		expect(calls).toEqual(['A', 'A']);
	});

	it('invalidate forces a fresh CLI read (used right after a login)', async () => {
		const { cache, calls, set } = setup();
		await cache.get('A');
		set(OUT);
		cache.invalidate('A');
		expect(await cache.get('A')).toEqual(OUT);
		expect(calls).toEqual(['A', 'A']);
	});

	it('a failing CLI yields null (unknown), not "logged out"', async () => {
		const cache = new AuthStatusCache(async () => {
			throw new Error('spawn failed');
		});
		expect(await cache.get('A')).toBeNull();
	});
});
