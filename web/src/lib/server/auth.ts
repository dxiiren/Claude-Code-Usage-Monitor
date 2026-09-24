// Server-mode access control: admin password -> session cookie, login rate limit, widget API tokens.
// Nothing secret is ever logged or returned: sessions and tokens are stored as SHA-256 hashes only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserError, database } from './db';
import { DATA_DIR, PUBLIC_ORIGIN } from './paths';

const env = process.env;
export const SESSION_TTL_S = 14 * 24 * 3600;
/** Below this the server still starts (the owner decides), but logs a warning at every start. */
export const WEAK_PASSWORD_LENGTH = 12;

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---------- configuration ----------

/** Everything server mode refuses to start without. Returns the problems (empty = ok). */
export function serverConfigProblems(e: NodeJS.ProcessEnv = env): string[] {
	const out: string[] = [];
	if (!e.ACCTMGR_ADMIN_PASSWORD) out.push('ACCTMGR_ADMIN_PASSWORD is required in server mode (it protects every page and API).');
	if (e.ACCTMGR_ADMIN_USER !== undefined && !e.ACCTMGR_ADMIN_USER.trim()) out.push('ACCTMGR_ADMIN_USER is set but empty.');
	if (e.ACCTMGR_PUBLIC_ORIGIN) {
		try {
			const u = new URL(e.ACCTMGR_PUBLIC_ORIGIN);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
		} catch {
			out.push(`ACCTMGR_PUBLIC_ORIGIN is not an http(s) URL: ${e.ACCTMGR_PUBLIC_ORIGIN}`);
		}
	}
	return out;
}

export const secureCookies = () => PUBLIC_ORIGIN.startsWith('https:');
/** `__Host-` pins the cookie to this exact host (requires Secure, Path=/, no Domain). */
export const cookieName = () => (secureCookies() ? '__Host-acctmgr_session' : 'acctmgr_session');

// ---------- username + password ----------

/** Constant-time: both sides hashed to 32 bytes first, so length differences leak nothing either. */
function sameSecret(given: unknown, expected: string): boolean {
	const a = crypto.createHash('sha256').update(typeof given === 'string' ? given : '', 'utf8').digest();
	const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
	return crypto.timingSafeEqual(a, b) && typeof given === 'string' && expected.length > 0;
}

export function checkPassword(given: unknown, expected: string = env.ACCTMGR_ADMIN_PASSWORD ?? ''): boolean {
	return sameSecret(given, expected);
}

/** ACCTMGR_ADMIN_USER (default "Admin"), compared case-insensitively. */
export const adminUser = (e: NodeJS.ProcessEnv = env) => (e.ACCTMGR_ADMIN_USER ?? '').trim() || 'Admin';

/** Username AND password; both are always compared (no early exit that would time the username). */
export function checkCredentials(user: unknown, password: unknown, e: NodeJS.ProcessEnv = env): boolean {
	const u = sameSecret(typeof user === 'string' ? user.trim().toLowerCase() : user, adminUser(e).toLowerCase());
	const p = sameSecret(password, e.ACCTMGR_ADMIN_PASSWORD ?? '');
	return u && p;
}

/**
 * The address a login attempt is counted against. `CF-Connecting-IP` is honoured ONLY with
 * ACCTMGR_TRUST_PROXY=1 (the container is reachable only through a Cloudflare tunnel); otherwise
 * anyone could send that header and pick a fresh address per attempt. Else: the socket address.
 */
export function clientIp(headers: Headers, socketAddress: () => string, e: NodeJS.ProcessEnv = env): string {
	if (e.ACCTMGR_TRUST_PROXY === '1') {
		const cf = headers.get('cf-connecting-ip')?.trim();
		if (cf && cf.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(cf)) return cf;
	}
	try {
		return socketAddress();
	} catch {
		return 'unknown';
	}
}

// ---------- session secret ----------

let secret: Buffer | null = null;

/** ACCTMGR_SESSION_SECRET, else a random one generated once and kept in <data>/session-secret (0600). */
export function sessionSecret(): Buffer {
	if (secret) return secret;
	if (env.ACCTMGR_SESSION_SECRET) return (secret = Buffer.from(env.ACCTMGR_SESSION_SECRET, 'utf8'));
	const file = path.join(DATA_DIR, 'session-secret');
	try {
		const v = fs.readFileSync(file, 'utf8').trim();
		if (v.length >= 32) return (secret = Buffer.from(v, 'utf8'));
	} catch {
		/* first start */
	}
	const v = crypto.randomBytes(32).toString('base64url');
	fs.mkdirSync(DATA_DIR, { recursive: true });
	fs.writeFileSync(file, v, { mode: 0o600 });
	return (secret = Buffer.from(v, 'utf8'));
}

const sign = (id: string) => crypto.createHmac('sha256', sessionSecret()).update(id).digest('base64url');

// ---------- sessions ----------

/**
 * New session: cookie value `<id>.<hmac>`; only sha256(id) is stored. Changing the admin password
 * ends every existing session (a fingerprint of it is kept in meta).
 */
export function createSession(nowS = Math.floor(Date.now() / 1000)): string {
	const id = crypto.randomBytes(32).toString('base64url');
	const d = database();
	d.prepare('DELETE FROM admin_sessions WHERE expires_unix <= ?').run(nowS);
	d.prepare('INSERT INTO admin_sessions (id_hash, created_at, expires_unix) VALUES (?, ?, ?)').run(
		sha256(id),
		new Date(nowS * 1000).toISOString(),
		nowS + SESSION_TTL_S
	);
	return `${id}.${sign(id)}`;
}

function parseCookie(value: string | undefined | null): string | null {
	if (!value) return null;
	const i = value.lastIndexOf('.');
	if (i <= 0) return null;
	const id = value.slice(0, i);
	const mac = Buffer.from(value.slice(i + 1));
	const want = Buffer.from(sign(id));
	if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
	return id;
}

export function validSession(cookie: string | undefined | null, nowS = Math.floor(Date.now() / 1000)): boolean {
	const id = parseCookie(cookie);
	if (!id) return false;
	const row = database().prepare('SELECT expires_unix FROM admin_sessions WHERE id_hash = ?').get(sha256(id)) as
		| { expires_unix: number }
		| undefined;
	return !!row && row.expires_unix > nowS;
}

export function destroySession(cookie: string | undefined | null): void {
	const id = parseCookie(cookie);
	if (id) database().prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(sha256(id));
}

/** Startup: if the admin user or password changed since the sessions were issued, log everyone out. */
export function rotateSessionsIfPasswordChanged(password = env.ACCTMGR_ADMIN_PASSWORD ?? '', user = adminUser()): void {
	const fp = crypto.createHmac('sha256', sessionSecret()).update(`pw:${user.toLowerCase()}:${password}`).digest('hex');
	const d = database();
	const old = (d.prepare("SELECT value FROM meta WHERE key = 'admin_pw_fp'").get() as { value: string } | undefined)?.value;
	if (old === fp) return;
	d.prepare('DELETE FROM admin_sessions').run();
	d.prepare("INSERT INTO meta (key, value) VALUES ('admin_pw_fp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(fp);
}

// ---------- login rate limit ----------

/**
 * Failed attempts per client in a sliding window, plus a global cap (behind a tunnel every client
 * can look like the same address). Success clears that client's failures.
 */
export class RateLimiter {
	private perKey = new Map<string, number[]>();
	private all: number[] = [];
	constructor(
		private maxPerKey = 5,
		private maxGlobal = 30,
		private windowMs = 15 * 60_000,
		private now: () => number = Date.now
	) {}

	private prune(list: number[]): number[] {
		const since = this.now() - this.windowMs;
		return list.filter((t) => t > since);
	}

	/** 0 = allowed; else seconds until the next attempt is allowed. */
	retryAfter(key: string): number {
		const mine = this.prune(this.perKey.get(key) ?? []);
		this.perKey.set(key, mine);
		this.all = this.prune(this.all);
		const blockedBy = (list: number[], max: number) => (list.length >= max ? list[list.length - max] + this.windowMs - this.now() : 0);
		const ms = Math.max(blockedBy(mine, this.maxPerKey), blockedBy(this.all, this.maxGlobal));
		return ms > 0 ? Math.ceil(ms / 1000) : 0;
	}

	fail(key: string): void {
		const t = this.now();
		this.perKey.set(key, [...this.prune(this.perKey.get(key) ?? []), t]);
		this.all = [...this.prune(this.all), t];
	}

	succeed(key: string): void {
		this.perKey.delete(key);
	}
}

export const loginLimiter = new RateLimiter();

// ---------- widget API tokens ----------

export interface ApiToken {
	id: string;
	name: string;
	created_at: string;
	last_used_at: string | null;
}

export function listTokens(): ApiToken[] {
	return database().prepare('SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY created_at').all() as unknown as ApiToken[];
}

/** Returns the token ONCE; only its SHA-256 is stored. */
export function createToken(rawName: unknown): { id: string; name: string; token: string } {
	const name = typeof rawName === 'string' ? rawName.trim() : '';
	if (!name) throw new UserError('Give the token a name (for example the PC it is for).');
	if (name.length > 40 || /[\u0000-\u001f]/.test(name))
		throw new UserError('Keep the name to 40 plain characters or fewer.');
	const id = crypto.randomUUID();
	const token = `cum_${crypto.randomBytes(32).toString('base64url')}`;
	database()
		.prepare('INSERT INTO api_tokens (id, name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)')
		.run(id, name, sha256(token), new Date().toISOString());
	return { id, name, token };
}

export function revokeToken(id: string): boolean {
	return database().prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes > 0;
}

/** `Authorization: Bearer <token>` -> the token row id, or null (missing / unknown / revoked). */
export function verifyBearer(header: string | null | undefined, nowMs = Date.now()): string | null {
	const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
	if (!m) return null;
	const d = database();
	const row = d.prepare('SELECT id, last_used_at FROM api_tokens WHERE token_hash = ?').get(sha256(m[1])) as
		| { id: string; last_used_at: string | null }
		| undefined;
	if (!row) return null;
	// At most one write a minute per token (widgets poll every 30 s).
	if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) >= 60_000)
		d.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(new Date(nowMs).toISOString(), row.id);
	return row.id;
}

export const hashToken = sha256;
