// Dashboard users (server mode): who may sign in and which screens each one may open.
// Passwords are stored as scrypt hashes only; nothing here ever logs or returns one.
import crypto from 'node:crypto';
import { UserError, database } from './db';
import { adminUser, destroyUserSessions, envAdminFingerprint } from './auth';
import { getSettings } from './settings';

/** Every screen a user can be given. Whoever has `users` is an admin. */
export const SCREENS = ['accounts', 'usage', 'report', 'tokens', 'settings', 'users'] as const;
export type Screen = (typeof SCREENS)[number];
export const SCREEN_LABELS: Record<Screen, string> = {
	accounts: 'Accounts',
	usage: 'Usage',
	report: 'Report',
	tokens: 'Widget tokens',
	settings: 'Settings',
	users: 'Users'
};
/** Where each screen lives, in menu order. */
export const SCREEN_PATHS: Record<Screen, string> = { accounts: '/', usage: '/usage', report: '/report', tokens: '/tokens', settings: '/settings', users: '/users' };

export interface User {
	id: string;
	username: string;
	screens: Screen[];
	mustChange: boolean;
	createdAt: string;
	lastLoginAt: string | null;
}

interface Row {
	id: string;
	username: string;
	screens: string;
	pw_hash: string;
	must_change: number;
	created_at: string;
	last_login_at: string | null;
}

// ---------- password hashing ----------

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		crypto.scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p }, (e, key) => (e ? reject(e) : resolve(key)))
	);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.randomBytes(16);
	return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${(await scrypt(password, salt)).toString('base64url')}`;
}

export async function verifyPassword(password: unknown, stored: string): Promise<boolean> {
	const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
	if (!m || typeof password !== 'string') return false;
	const want = Buffer.from(m[5], 'base64url');
	const got = await scrypt(password, Buffer.from(m[4], 'base64url'), +m[1], +m[2], +m[3]);
	return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Verified against when the username is unknown, so a wrong name costs the same time as a wrong password. */
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(crypto.randomBytes(16).toString('hex')));

// ---------- validation ----------

export function cleanUsername(raw: unknown): string {
	const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	if (!/^[a-z0-9][a-z0-9._-]{1,23}$/.test(name))
		throw new UserError('Usernames are 2 to 24 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.');
	return name;
}

export function cleanPassword(raw: unknown): string {
	const min = getSettings().minPassword;
	if (typeof raw !== 'string' || raw.length < min) throw new UserError(`Use a password of at least ${min} characters.`);
	if (raw.length > 200) throw new UserError('Use a password of 200 characters or fewer.');
	return raw;
}

export function cleanScreens(raw: unknown): Screen[] {
	const list = Array.isArray(raw) ? raw : [];
	const bad = list.find((x) => !SCREENS.includes(x as Screen));
	if (bad !== undefined) throw new UserError(`Unknown screen: ${String(bad)}`);
	// stored in menu order, no repeats
	return SCREENS.filter((sc) => list.includes(sc));
}

/** A readable one-time password, e.g. `kq7m-x2np-84ht`. */
export function temporaryPassword(): string {
	const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
	const pick = () => chars[crypto.randomInt(chars.length)];
	return Array.from({ length: 3 }, () => Array.from({ length: 4 }, pick).join('')).join('-');
}

// ---------- reads ----------

function toUser(r: Row): User {
	let screens: Screen[] = [];
	try {
		screens = cleanScreens(JSON.parse(r.screens));
	} catch {
		/* a row with unreadable screens opens nothing */
	}
	return { id: r.id, username: r.username, screens, mustChange: !!r.must_change, createdAt: r.created_at, lastLoginAt: r.last_login_at };
}

const COLS = 'id, username, screens, pw_hash, must_change, created_at, last_login_at';
const rowById = (id: string) => database().prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id) as unknown as Row | undefined;
const rowByName = (name: string) => database().prepare(`SELECT ${COLS} FROM users WHERE username = ?`).get(name) as unknown as Row | undefined;

export function listUsers(): User[] {
	return (database().prepare(`SELECT ${COLS} FROM users ORDER BY created_at, username`).all() as unknown as Row[]).map(toUser);
}

export function getUser(id: string): User | undefined {
	const r = rowById(id);
	return r ? toUser(r) : undefined;
}

function mustGet(id: string): Row {
	const r = rowById(id);
	if (!r) throw new UserError('That user no longer exists. Reload the page.', 404);
	return r;
}

const admins = () => listUsers().filter((u) => u.screens.includes('users'));

// ---------- sign-in ----------

/** The user for a correct username + password, else null. Always does one password check. */
export async function authenticate(username: unknown, password: unknown, nowMs = Date.now()): Promise<User | null> {
	const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
	const row = name ? rowByName(name) : undefined;
	const ok = await verifyPassword(password, row?.pw_hash ?? (await dummyHash()));
	if (!row || !ok) return null;
	database().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date(nowMs).toISOString(), row.id);
	return toUser(row);
}

// ---------- writes ----------

async function insert(username: string, password: string, screens: Screen[], mustChange: boolean): Promise<User> {
	const id = crypto.randomUUID();
	const t = new Date().toISOString();
	database()
		.prepare('INSERT INTO users (id, username, screens, pw_hash, must_change, created_at, updated_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
		.run(id, username, JSON.stringify(screens), await hashPassword(password), mustChange ? 1 : 0, t, t);
	return toUser(rowById(id)!);
}

/** Admin adds a user with a temporary password; they must choose their own at first sign-in. */
export async function createUser(rawName: unknown, rawPassword: unknown, rawScreens: unknown): Promise<User> {
	const username = cleanUsername(rawName);
	const password = cleanPassword(rawPassword);
	const screens = cleanScreens(rawScreens);
	if (rowByName(username)) throw new UserError(`There is already a user called "${username}".`, 409);
	return insert(username, password, screens, true);
}

/** Changes which screens a user may open. `actorId` = who is doing it (cannot lock themselves out). */
export function setScreens(id: string, rawScreens: unknown, actorId: string): User {
	const row = mustGet(id);
	const screens = cleanScreens(rawScreens);
	if (!screens.includes('users')) {
		if (id === actorId) throw new UserError('You cannot remove your own access to Users. Ask another admin to do it.');
		if (admins().every((u) => u.id === id)) throw new UserError('At least one user must keep the Users screen, or nobody could manage users.');
	}
	database().prepare('UPDATE users SET screens = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(screens), new Date().toISOString(), row.id);
	return toUser(rowById(id)!);
}

/** Admin reset: a new temporary password, signed out everywhere, must change at next sign-in. */
export async function resetPassword(id: string): Promise<{ user: User; password: string }> {
	const row = mustGet(id);
	const password = temporaryPassword();
	database()
		.prepare('UPDATE users SET pw_hash = ?, must_change = 1, updated_at = ? WHERE id = ?')
		.run(await hashPassword(password), new Date().toISOString(), row.id);
	destroyUserSessions(row.id);
	return { user: toUser(rowById(id)!), password };
}

export function removeUser(id: string, actorId: string): void {
	const row = mustGet(id);
	if (id === actorId) throw new UserError('You cannot remove yourself.');
	if (admins().every((u) => u.id === id)) throw new UserError('This is the only user who can manage users, so it cannot be removed.');
	destroyUserSessions(row.id);
	database().prepare('DELETE FROM users WHERE id = ?').run(row.id);
}

/** A user changes their own password; other browsers they are signed in on are signed out. */
export async function changeOwnPassword(id: string, current: unknown, next: unknown, keepCookie?: string | null): Promise<void> {
	const row = mustGet(id);
	if (!(await verifyPassword(current, row.pw_hash))) throw new UserError('The current password is not right.');
	const password = cleanPassword(next);
	if (password === current) throw new UserError('Choose a password that is different from the current one.');
	database()
		.prepare('UPDATE users SET pw_hash = ?, must_change = 0, updated_at = ? WHERE id = ?')
		.run(await hashPassword(password), new Date().toISOString(), row.id);
	destroyUserSessions(row.id, keepCookie);
}

// ---------- the environment admin ----------

/**
 * Startup. ACCTMGR_ADMIN_USER / ACCTMGR_ADMIN_PASSWORD create the first admin, and stay the way
 * back in: when they change between starts (or no admin can sign in at all), that user gets the
 * environment password and every screen again, and every session ends.
 */
export async function syncEnvAdmin(e: NodeJS.ProcessEnv = process.env): Promise<'created' | 'reset' | 'unchanged'> {
	const username = adminUser(e).toLowerCase();
	const password = e.ACCTMGR_ADMIN_PASSWORD ?? '';
	if (!password) return 'unchanged';
	const d = database();
	const fp = envAdminFingerprint(password, username);
	const old = (d.prepare("SELECT value FROM meta WHERE key = 'admin_pw_fp'").get() as { value: string } | undefined)?.value;
	const existing = rowByName(username);
	const lockedOut = admins().length === 0;
	if (old === fp && existing && !lockedOut) return 'unchanged';
	// A database from before users existed has the fingerprint but no user: create it, keep nothing else.
	const outcome = existing ? 'reset' : 'created';
	if (existing) {
		if (old !== fp || lockedOut)
			d.prepare('UPDATE users SET pw_hash = ?, screens = ?, must_change = 0, updated_at = ? WHERE id = ?').run(
				await hashPassword(password),
				JSON.stringify(SCREENS),
				new Date().toISOString(),
				existing.id
			);
	} else {
		await insert(username, password, [...SCREENS], false);
	}
	if (old !== fp) d.prepare('DELETE FROM admin_sessions').run();
	d.prepare("INSERT INTO meta (key, value) VALUES ('admin_pw_fp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(fp);
	return outcome;
}

// ---------- which screen owns a request ----------

/**
 * The screens that may make this request: any one of them is enough. An empty list means any
 * signed-in user. Unknown paths need Users (admins only), so a new route is closed by default.
 */
export function screensFor(method: string, pathname: string): Screen[] {
	const read = method === 'GET' || method === 'HEAD';
	const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
	if (pathname === '/account' || pathname === '/logout' || under('/api/account')) return [];
	if (pathname === '/api/accounts' && read) return ['accounts', 'usage']; // both pages read the account list
	if (pathname === '/') return ['accounts'];
	if (under('/api/accounts') || under('/api/login') || pathname === '/api/settings' || under('/api/widget')) return ['accounts'];
	if (pathname === '/usage') return ['usage'];
	if (under('/api/usage')) return ['usage', 'accounts']; // Refresh now sits on both pages
	if (pathname === '/report' || under('/api/report')) return ['report'];
	if (pathname === '/tokens' || under('/api/tokens')) return ['tokens'];
	if (pathname === '/settings' || under('/api/app-settings')) return ['settings'];
	if (pathname === '/users' || under('/api/users')) return ['users'];
	return ['users'];
}

/** The first screen in menu order this user may open, as a path; `/account` when they have none. */
export function homeFor(screens: string[]): string {
	const first = SCREENS.find((sc) => screens.includes(sc));
	return first ? SCREEN_PATHS[first] : '/account';
}
