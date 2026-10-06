import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { isolateServer } from './helpers';

const env = isolateServer();
type Auth = typeof import('../../src/lib/server/auth');
type Users = typeof import('../../src/lib/server/users');
let auth: Auth;
let users: Users;
/** A user to own the sessions these tests create. */
let uid: string;

const dbFile = () => path.join(env.data, 'accounts.db');
function rows<T>(sql: string): T[] {
	const d = new DatabaseSync(dbFile(), { readOnly: true });
	try {
		return d.prepare(sql).all() as T[];
	} finally {
		d.close();
	}
}

beforeAll(async () => {
	auth = await import('../../src/lib/server/auth');
	users = await import('../../src/lib/server/users');
	(await import('../../src/lib/server/db')).initDb();
	uid = (await users.createUser('session-owner', 'a long enough password', ['usage'])).id;
});

describe('server config', () => {
	it('refuses to start without an admin password, or with a bad public origin', () => {
		expect(auth.serverConfigProblems({})).toEqual([expect.stringMatching(/ACCTMGR_ADMIN_PASSWORD is required/)]);
		expect(auth.serverConfigProblems({ ACCTMGR_ADMIN_PASSWORD: 'short' })).toEqual([]); // weak: warned at start, not refused
		expect(auth.serverConfigProblems({ ACCTMGR_ADMIN_PASSWORD: 'long enough', ACCTMGR_ADMIN_USER: '  ' })[0]).toMatch(/ADMIN_USER is set but empty/);
		expect(auth.serverConfigProblems({ ACCTMGR_ADMIN_PASSWORD: 'long enough', ACCTMGR_PUBLIC_ORIGIN: 'ftp://x' })[0]).toMatch(
			/not an http\(s\) URL/
		);
		expect(auth.serverConfigProblems({ ACCTMGR_ADMIN_PASSWORD: 'long enough', ACCTMGR_PUBLIC_ORIGIN: 'https://a.example' })).toEqual([]);
	});
	it('https public origin -> Secure __Host- cookie', () => {
		expect(auth.secureCookies()).toBe(true);
		expect(auth.cookieName()).toBe('__Host-acctmgr_session');
	});
});

describe('the bootstrap admin name', () => {
	it('defaults to Admin; ACCTMGR_ADMIN_USER overrides it (surrounding spaces ignored)', () => {
		expect(auth.adminUser({})).toBe('Admin');
		expect(auth.adminUser({ ACCTMGR_ADMIN_USER: '  Yana ' })).toBe('Yana');
	});
});

describe('where sign-in sends you next', () => {
	it('keeps a same-site path, falls back for anything that could leave the site', () => {
		const next = (raw: string | null) => auth.safeNext(raw, '/home');
		expect(next('/usage')).toBe('/usage');
		expect(next('/report?period=week&date=2026-10-06')).toBe('/report?period=week&date=2026-10-06');
		for (const bad of [null, '', 'usage', 'https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/a\\b', '/a b'])
			expect(next(bad), JSON.stringify(bad)).toBe('/home');
	});
});

describe('client address for the rate limit', () => {
	const h = (v?: string) => new Headers(v ? { 'cf-connecting-ip': v } : {});
	const sock = () => '172.18.0.5';
	it('ignores CF-Connecting-IP unless ACCTMGR_TRUST_PROXY=1 (else anyone could rotate it)', () => {
		expect(auth.clientIp(h('203.0.113.9'), sock, {})).toBe('172.18.0.5');
		expect(auth.clientIp(h('203.0.113.9'), sock, { ACCTMGR_TRUST_PROXY: 'true' })).toBe('172.18.0.5');
		expect(auth.clientIp(h('203.0.113.9'), sock, { ACCTMGR_TRUST_PROXY: '1' })).toBe('203.0.113.9');
		expect(auth.clientIp(h('2001:db8::1'), sock, { ACCTMGR_TRUST_PROXY: '1' })).toBe('2001:db8::1');
	});
	it('with trust on, a missing or junk header falls back to the socket address', () => {
		expect(auth.clientIp(h(), sock, { ACCTMGR_TRUST_PROXY: '1' })).toBe('172.18.0.5');
		expect(auth.clientIp(h('<script>'), sock, { ACCTMGR_TRUST_PROXY: '1' })).toBe('172.18.0.5');
		expect(auth.clientIp(h(), () => { throw new Error('no socket'); }, {})).toBe('unknown');
	});
	it('per-IP lockout: 5 failures lock that IP (with a Retry-After), others still get in', () => {
		let t = 5_000_000;
		const rl = new auth.RateLimiter(5, 30, 15 * 60_000, () => t);
		const trust = { ACCTMGR_TRUST_PROXY: '1' };
		const attacker = auth.clientIp(h('198.51.100.7'), sock, trust);
		const user = auth.clientIp(h('203.0.113.9'), sock, trust);
		for (let i = 0; i < 5; i++) {
			t += 1000;
			expect(rl.retryAfter(attacker)).toBe(0);
			rl.fail(attacker);
		}
		expect(rl.retryAfter(attacker)).toBe(15 * 60 - 4); // oldest failure ages out first
		expect(rl.retryAfter(user)).toBe(0);
	});
});

describe('sessions', () => {
	it('generates and persists a session secret in the data dir (0600 on POSIX)', () => {
		const s1 = auth.sessionSecret();
		const file = path.join(env.data, 'session-secret');
		expect(fs.existsSync(file)).toBe(true);
		expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThanOrEqual(32);
		expect(auth.sessionSecret()).toBe(s1);
		if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});
	it('a new session validates; tampering, unknown ids and expiry do not', () => {
		const now = Math.floor(Date.now() / 1000);
		const c = auth.createSession(uid, now);
		expect(auth.validSession(c, now)).toBe(true);
		expect(auth.sessionUser(c, now)).toMatchObject({ id: uid, username: 'session-owner', screens: ['usage'], mustChange: true });
		const [id, mac] = c.split('.');
		expect(auth.validSession(`${id}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, now)).toBe(false);
		expect(auth.validSession(`${id}x.${mac}`, now)).toBe(false);
		expect(auth.validSession(id, now)).toBe(false);
		expect(auth.validSession('', now)).toBe(false);
		expect(auth.validSession(null, now)).toBe(false);
		expect(auth.validSession(c, now + auth.sessionTtlS() + 1)).toBe(false);
	});
	it('stores only a hash of the session id', () => {
		const c = auth.createSession(uid);
		const id = c.split('.')[0];
		const stored = rows<{ id_hash: string }>('SELECT id_hash FROM admin_sessions').map((r) => r.id_hash);
		expect(stored).toContain(auth.hashToken(id));
		expect(stored.join()).not.toContain(id);
	});
	it('logout destroys the session server side', () => {
		const c = auth.createSession(uid);
		expect(auth.validSession(c)).toBe(true);
		auth.destroySession(c);
		expect(auth.validSession(c)).toBe(false);
	});
	it('a session of a user who was removed stops working', async () => {
		const other = await users.createUser('short-lived', 'a long enough password', ['report']);
		const admin = await users.createUser('boss', 'a long enough password', ['users']);
		const c = auth.createSession(other.id);
		expect(auth.validSession(c)).toBe(true);
		users.removeUser(other.id, admin.id);
		expect(auth.validSession(c)).toBe(false);
	});
	it('signing a user out everywhere can keep the session that asked for it', () => {
		const a = auth.createSession(uid);
		const b = auth.createSession(uid);
		auth.destroyUserSessions(uid, a);
		expect(auth.validSession(a)).toBe(true);
		expect(auth.validSession(b)).toBe(false);
		auth.destroyUserSessions(uid);
		expect(auth.validSession(a)).toBe(false);
	});
});

describe('login rate limit', () => {
	it('blocks a client after 5 failures in the window, then frees it', () => {
		let t = 1_000_000;
		const rl = new auth.RateLimiter(5, 30, 15 * 60_000, () => t);
		for (let i = 0; i < 5; i++) {
			expect(rl.retryAfter('1.2.3.4')).toBe(0);
			rl.fail('1.2.3.4');
		}
		expect(rl.retryAfter('1.2.3.4')).toBe(15 * 60);
		expect(rl.retryAfter('5.6.7.8')).toBe(0); // other clients unaffected
		t += 15 * 60_000 + 1;
		expect(rl.retryAfter('1.2.3.4')).toBe(0);
	});
	it('forgive gives back one attempt only: a sign-in elsewhere does not wipe earlier guesses', () => {
		let t = 1_000_000;
		const rl = new auth.RateLimiter(3, 30, 60_000, () => t);
		rl.fail('a');
		rl.fail('a');
		// the third attempt is counted up front, turns out correct, and is given back
		rl.fail('a');
		expect(rl.retryAfter('a')).toBeGreaterThan(0);
		rl.forgive('a');
		expect(rl.retryAfter('a')).toBe(0);
		// the two real failures are still there: one more wrong guess locks the client
		rl.fail('a');
		expect(rl.retryAfter('a')).toBeGreaterThan(0);
		rl.forgive('nobody'); // unknown client: nothing to give back for it
		t += 60_001;
		expect(rl.retryAfter('a')).toBe(0);
	});
	it('success clears the client; the global cap still applies across clients', () => {
		let t = 0;
		const rl = new auth.RateLimiter(5, 6, 60_000, () => t);
		for (let i = 0; i < 4; i++) rl.fail('a');
		rl.succeed('a');
		expect(rl.retryAfter('a')).toBe(0);
		rl.fail('b');
		rl.fail('c');
		t += 1000;
		expect(rl.retryAfter('d')).toBe(59); // 6 failures in the window from 3 clients
	});
});

describe('widget API tokens', () => {
	it('create returns the token once and stores only its SHA-256', () => {
		const t = auth.createToken('office-pc');
		expect(t.token).toMatch(/^cum_[A-Za-z0-9_-]{40,}$/);
		const stored = rows<{ id: string; name: string; token_hash: string; last_used_at: string | null }>('SELECT * FROM api_tokens');
		const row = stored.find((r) => r.id === t.id)!;
		expect(row.name).toBe('office-pc');
		expect(row.token_hash).toBe(auth.hashToken(t.token));
		expect(JSON.stringify(stored)).not.toContain(t.token);
		expect(JSON.stringify(auth.listTokens())).not.toContain(t.token);
		expect(auth.listTokens().find((x) => x.id === t.id)).toEqual({ id: t.id, name: 'office-pc', created_at: expect.any(String), last_used_at: null });
	});
	it('rejects empty or oversized names', () => {
		expect(() => auth.createToken('  ')).toThrow(/name/);
		expect(() => auth.createToken('x'.repeat(41))).toThrow(/40/);
	});
	it('Bearer: valid token accepted (last_used_at set), anything else rejected, revoke works', () => {
		const t = auth.createToken('laptop');
		expect(auth.verifyBearer(`Bearer ${t.token}`)).toBe(t.id);
		expect(auth.listTokens().find((x) => x.id === t.id)!.last_used_at).not.toBeNull();
		expect(auth.verifyBearer(`bearer ${t.token}`)).toBe(t.id);
		expect(auth.verifyBearer(null)).toBeNull();
		expect(auth.verifyBearer('')).toBeNull();
		expect(auth.verifyBearer(t.token)).toBeNull();
		expect(auth.verifyBearer(`Basic ${t.token}`)).toBeNull();
		expect(auth.verifyBearer(`Bearer ${t.token}x`)).toBeNull();
		expect(auth.verifyBearer(`Bearer ${auth.hashToken(t.token)}`)).toBeNull(); // the hash is not a credential
		expect(auth.revokeToken(t.id)).toBe(true);
		expect(auth.verifyBearer(`Bearer ${t.token}`)).toBeNull();
		expect(auth.revokeToken(t.id)).toBe(false);
	});
});
