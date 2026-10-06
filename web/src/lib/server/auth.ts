// Server-mode access control: user sign-in -> session cookie, login rate limit, widget API tokens.
// Users, their passwords and the screens they may open live in users.ts.
// Nothing secret is ever logged or returned: sessions and tokens are stored as SHA-256 hashes only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserError, batch, database } from './db';
import { DATA_DIR, PUBLIC_ORIGIN } from './paths';
import { getSettings } from './settings';

const env = process.env;
/** How long a sign-in lasts (Settings > Sign-in). */
export const sessionTtlS = () => getSettings().sessionDays * 24 * 3600;
/** Below this the server still starts (the owner decides), but logs a warning at every start. */
export const WEAK_PASSWORD_LENGTH = 12;

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---------- configuration ----------

/** Everything server mode refuses to start without. Returns the problems (empty = ok). */
export function serverConfigProblems(e: NodeJS.ProcessEnv = env): string[] {
	const out: string[] = [];
	if (!e.ACCTMGR_ADMIN_PASSWORD) out.push('ACCTMGR_ADMIN_PASSWORD is required in server mode (it creates the first admin and is the way back in if you are locked out).');
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

// ---------- the bootstrap admin ----------

/** ACCTMGR_ADMIN_USER (default "Admin"): the first admin, and the way back in (see users.ts). */
export const adminUser = (e: NodeJS.ProcessEnv = env) => (e.ACCTMGR_ADMIN_USER ?? '').trim() || 'Admin';

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

/**
 * Where to go after sign-in: the `next` from the address only when it is one same-site path.
 * Never `//evil.example`, a backslash form or an absolute URL; and printable ASCII only, because
 * browsers drop tabs and newlines from addresses ("/<tab>/evil.example" would become "//evil.example").
 */
export function safeNext(raw: string | null | undefined, fallback: string): string {
	return raw && /^\/(?!\/)[\x21-\x7e]*$/.test(raw) && !raw.includes('\\') ? raw : fallback;
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

export interface SessionUser {
	id: string;
	username: string;
	screens: string[];
	mustChange: boolean;
}

/** New session for a user: cookie value `<id>.<hmac>`; only sha256(id) is stored. */
export function createSession(userId: string, nowS = Math.floor(Date.now() / 1000)): string {
	const id = crypto.randomBytes(32).toString('base64url');
	const ttl = sessionTtlS();
	batch((d) => {
		d.prepare('DELETE FROM admin_sessions WHERE expires_unix <= ?').run(nowS);
		d.prepare('INSERT INTO admin_sessions (id_hash, created_at, expires_unix, user_id) VALUES (?, ?, ?, ?)').run(
			sha256(id),
			new Date(nowS * 1000).toISOString(),
			nowS + ttl,
			userId
		);
	});
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

/** Who this cookie belongs to, or null (bad signature, expired, signed out, user removed). */
export function sessionUser(cookie: string | undefined | null, nowS = Math.floor(Date.now() / 1000)): SessionUser | null {
	const id = parseCookie(cookie);
	if (!id) return null;
	const row = database()
		.prepare(
			`SELECT s.expires_unix, u.id, u.username, u.screens, u.must_change
			   FROM admin_sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`
		)
		.get(sha256(id)) as { expires_unix: number; id: string; username: string; screens: string; must_change: number } | undefined;
	if (!row || row.expires_unix <= nowS) return null;
	let screens: string[] = [];
	try {
		const v = JSON.parse(row.screens);
		if (Array.isArray(v)) screens = v.filter((x): x is string => typeof x === 'string');
	} catch {
		/* no screens */
	}
	return { id: row.id, username: row.username, screens, mustChange: !!row.must_change };
}

export const validSession = (cookie: string | undefined | null, nowS?: number): boolean => !!sessionUser(cookie, nowS);

export function destroySession(cookie: string | undefined | null): void {
	const id = parseCookie(cookie);
	if (id) database().prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(sha256(id));
}

/** Signs a user out everywhere (password reset, removal); `exceptCookie` keeps the caller's own session. */
export function destroyUserSessions(userId: string, exceptCookie?: string | null): void {
	const keep = exceptCookie ? parseCookie(exceptCookie) : null;
	database().prepare('DELETE FROM admin_sessions WHERE user_id = ? AND id_hash <> ?').run(userId, keep ? sha256(keep) : '');
}

/** HMAC of the env admin's name + password, to notice when it was changed between starts. */
export function envAdminFingerprint(password = env.ACCTMGR_ADMIN_PASSWORD ?? '', user = adminUser()): string {
	return crypto.createHmac('sha256', sessionSecret()).update(`pw:${user.toLowerCase()}:${password}`).digest('hex');
}

// ---------- login rate limit ----------

/**
 * Failed attempts per client in a sliding window, plus a global cap (behind a tunnel every client
 * can look like the same address). Success clears that client's failures.
 */
export class RateLimiter {
	private perKey = new Map<string, number[]>();
	private all: number[] = [];
	/** Limits may be functions so the live Settings values apply without a restart. */
	constructor(
		private perKeyMax: number | (() => number) = 5,
		private maxGlobal = 30,
		private windowLength: number | (() => number) = 15 * 60_000,
		private now: () => number = Date.now
	) {}

	private get maxPerKey(): number {
		return typeof this.perKeyMax === 'function' ? this.perKeyMax() : this.perKeyMax;
	}
	private get windowMs(): number {
		return typeof this.windowLength === 'function' ? this.windowLength() : this.windowLength;
	}

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

	/**
	 * Gives back the newest attempt of this client (and one from the global count). Sign-in counts
	 * every attempt BEFORE checking the password, so guesses sent in parallel cannot all slip past
	 * the limit; a correct password then takes back only its own attempt. Earlier failures stay, so
	 * signing in to one account never wipes the count of guesses made against another.
	 */
	forgive(key: string): void {
		const mine = this.perKey.get(key);
		if (mine?.length) this.perKey.set(key, mine.slice(0, -1));
		if (this.all.length) this.all = this.all.slice(0, -1);
	}
}

export const loginLimiter = new RateLimiter(
	() => getSettings().loginTries,
	30,
	() => getSettings().loginPauseMinutes * 60_000
);

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
