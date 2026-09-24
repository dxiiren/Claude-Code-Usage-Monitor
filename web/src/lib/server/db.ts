// accounts.db -- schema and write rules from docs/account-manager-contract.md.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { APP_DIR, DB_FILE, MANAGER_URL, PROVIDERS, SERVER, configDirFor, isDeletableConfigDir, pathKey, type Provider } from './paths';
import { usedClaudeIds, writeSettings, writeTheme } from './widgetFiles';
import { CARD_THEMES, type CardTheme } from './theme';

export interface Account {
	id: string;
	name: string;
	config_dir: string;
	email: string | null;
	plan: string | null;
	enabled: number;
	sort_order: number;
	created_at: string;
	updated_at: string;
	/** schema 2: which CLI owns the login ('claude' | 'codex'). */
	provider: Provider;
}

/** meta.schema this app writes: 2 = accounts.provider exists (contract, "Codex accounts"). */
export const SCHEMA_VERSION = '2';
/** Stored as `email` when a Codex login carries no id_token email (contract: "ChatGPT account"). */
export const CODEX_NO_EMAIL = 'ChatGPT account';

export class UserError extends Error {
	constructor(
		message: string,
		public status = 400
	) {
		super(message);
	}
}

let db: DatabaseSync | null = null;

/**
 * Server mode only (the local DB keeps exactly the contract's two tables).
 * - api_tokens: widget API tokens, SHA-256 hashes only (contract).
 * - account_usage: the server's own poll result per account. Poll results are NOT account writes,
 *   so they never bump meta.revision (the widget's read contract is unchanged).
 * - admin_sessions: browser sessions, SHA-256 of the session id only.
 */
const SERVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  token_hash   TEXT UNIQUE,
  created_at   TEXT,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS account_usage (
  account_id   TEXT PRIMARY KEY,
  usage_json   TEXT,               -- last GOOD usage: {"session":{available,percentage,resets_at_unix},"weekly":{...}}
  error_json   TEXT,               -- last poll error, serialized like the widget's PollError; NULL = last poll ok
  polled_at    TEXT,               -- ISO-8601 UTC of the last poll attempt
  polled_unix  INTEGER,
  ok_unix      INTEGER             -- last successful poll
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash      TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_unix INTEGER NOT NULL
);`;

function open(): DatabaseSync {
	if (db) return db;
	fs.mkdirSync(APP_DIR, { recursive: true });
	const fresh = !fs.existsSync(DB_FILE);
	const d = new DatabaseSync(DB_FILE);
	// Rollback journal, NOT WAL: the widget reads read-only through winsqlite3.dll.
	d.exec('PRAGMA journal_mode = DELETE;');
	d.exec('PRAGMA busy_timeout = 5000;');
	d.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  config_dir  TEXT NOT NULL,
  email       TEXT,
  plan        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'claude'
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`);
	if (SERVER) d.exec(SERVER_SCHEMA);
	// Schema 1 DB (no provider column): add it; every existing row is Claude (the DEFAULT).
	const cols = (d.prepare('PRAGMA table_info(accounts)').all() as unknown as { name: string }[]).map((c) => c.name);
	const migrated = !cols.includes('provider');
	if (migrated) d.exec("ALTER TABLE accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
	const ins = d.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)');
	ins.run('revision', '0');
	// schema 2 tells the widget that zero codex rows means zero Codex accounts.
	d.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);
	const themeRowAdded = ins.run('card_theme', 'auto').changes === 1;
	d.prepare("INSERT INTO meta (key, value) VALUES ('manager_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
		MANAGER_URL
	);
	db = d;
	if (SERVER) {
		// The schema change counts as a write for remote widgets too.
		if (migrated) d.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
		return d; // no widget files on a server
	}
	// Deliberately NO import from kit/accounts.json or settings.json: a new DB starts empty.
	if (fresh) syncWidgetFiles();
	// Existing DB from before card_theme existed, or just migrated to schema 2: one normal write, so
	// the widget sees a new revision and reloads (its Codex profiles now come from this DB).
	else if (themeRowAdded || migrated) write(() => undefined);
	return d;
}

const now = () => new Date().toISOString();

export function listAccounts(): Account[] {
	return open().prepare('SELECT * FROM accounts ORDER BY sort_order, name').all() as unknown as Account[];
}

export function getAccount(id: string): Account | undefined {
	return open().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as unknown as Account | undefined;
}

export function getMeta(): Record<string, string> {
	const rows = open().prepare('SELECT key, value FROM meta').all() as unknown as { key: string; value: string }[];
	return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Theme + settings.json for the official widget, from the enabled rows in card order. */
function syncWidgetFiles(): void {
	if (SERVER) return; // no settings.json / theme on a server: remote widgets read /api/v1/widget
	const rows = listAccounts().filter((a) => a.enabled);
	const list = rows.map((a) => ({ id: a.id, name: a.name, config_dir: a.config_dir, provider: a.provider }));
	writeTheme(list, getCardTheme());
	// settings.json keeps the Claude profiles only (the compat layer for the official widget). Codex
	// rows reach the widget through accounts.db itself; the user's own Codex profile is left alone.
	writeSettings(
		list.filter((a) => a.provider === 'claude'),
		{ enableCodex: list.some((a) => a.provider === 'codex') }
	);
}

/** Every write: one transaction + meta.revision += 1, then regenerate theme + settings.json. */
function write<T>(fn: (d: DatabaseSync) => T): T {
	const d = open();
	d.exec('BEGIN IMMEDIATE');
	let result: T;
	try {
		result = fn(d);
		d.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
		d.exec('COMMIT');
	} catch (e) {
		d.exec('ROLLBACK');
		throw e;
	}
	syncWidgetFiles();
	return result;
}

export function validateName(raw: unknown): string {
	const name = typeof raw === 'string' ? raw.trim() : '';
	if (!name) throw new UserError('Give the account a name.');
	if (name.length > 24) throw new UserError('Keep the name to 24 characters or fewer (it has to fit on the card).');
	if (/[\u0000-\u001f]/.test(name)) throw new UserError('The name contains invalid characters.');
	return name;
}

function assertNameFree(d: DatabaseSync, name: string, exceptId?: string): void {
	const clash = d
		.prepare('SELECT id FROM accounts WHERE lower(name) = lower(?) AND id <> ?')
		.get(name, exceptId ?? '') as { id: string } | undefined;
	if (clash) throw new UserError(`There is already an account called "${name}".`, 409);
}

/**
 * Id = the name as [a-z0-9_] only: the widget's theme language reads `accounts.claude.<id>.x` and
 * accepts only [A-Za-z0-9_] ids ('-' would parse as minus). Anything else -> '_', repeats collapsed.
 * Never reuse an id the widget has seen, never collide with a folder on disk.
 */
export function slugId(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function newId(d: DatabaseSync, name: string): string {
	let base = slugId(name) || 'account';
	if (base === 'default') base = 'account';
	const taken = new Set([
		...(d.prepare('SELECT id FROM accounts').all() as unknown as { id: string }[]).map((r) => r.id),
		...usedIds(d),
		...(SERVER ? [] : usedClaudeIds()),
		'default'
	]);
	// Ids are unique across providers: free only if no provider's folder for it exists.
	const onDisk = (id: string) => PROVIDERS.some((p) => fs.existsSync(configDirFor(id, p)));
	let id = base;
	for (let i = 2; taken.has(id) || onDisk(id); i++) id = `${base}_${i}`;
	return id;
}

/** Ids ever handed out (meta.used_ids, JSON array), so an id is never reused by either provider. */
function usedIds(d: DatabaseSync): string[] {
	const v = (d.prepare("SELECT value FROM meta WHERE key = 'used_ids'").get() as { value: string } | undefined)?.value;
	try {
		const a = JSON.parse(v ?? '[]');
		return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

export function validateProvider(raw: unknown): Provider {
	if (raw === undefined || raw === null || raw === '') return 'claude';
	if (raw === 'claude' || raw === 'codex') return raw;
	throw new UserError('Provider must be claude or codex.');
}

export function createAccount(rawName: unknown, rawProvider: unknown = 'claude'): Account {
	const name = validateName(rawName);
	const provider = validateProvider(rawProvider);
	return write((d) => {
		assertNameFree(d, name);
		const id = newId(d, name);
		const t = now();
		const max = (d.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM accounts').get() as { m: number }).m;
		d.prepare(
			'INSERT INTO accounts (id, name, config_dir, email, plan, enabled, sort_order, created_at, updated_at, provider) VALUES (?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?)'
		).run(id, name, configDirFor(id, provider), max + 1, t, t, provider);
		d.prepare("INSERT INTO meta (key, value) VALUES ('used_ids', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
			JSON.stringify([...new Set([...usedIds(d), id])])
		);
		return getAccount(id)!;
	});
}

function mustGet(id: string): Account {
	const a = getAccount(id);
	if (!a) throw new UserError('That account no longer exists. Reload the page.', 404);
	return a;
}

export function renameAccount(id: string, rawName: unknown): void {
	const name = validateName(rawName);
	mustGet(id);
	write((d) => {
		assertNameFree(d, name, id);
		d.prepare('UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id);
	});
}

export function setEnabled(id: string, enabled: boolean): void {
	mustGet(id);
	write((d) => {
		d.prepare('UPDATE accounts SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, now(), id);
	});
}

export function moveAccount(id: string, dir: 'up' | 'down'): void {
	mustGet(id);
	write((d) => {
		const ids = (d.prepare('SELECT id FROM accounts ORDER BY sort_order, name').all() as unknown as { id: string }[]).map(
			(r) => r.id
		);
		const i = ids.indexOf(id);
		const j = dir === 'up' ? i - 1 : i + 1;
		if (j >= 0 && j < ids.length) [ids[i], ids[j]] = [ids[j], ids[i]];
		const upd = d.prepare('UPDATE accounts SET sort_order = ?, updated_at = ? WHERE id = ?');
		const t = now();
		ids.forEach((x, k) => upd.run(k, t, x));
	});
}

export function setAuth(id: string, email: string | null, plan: string | null): void {
	mustGet(id);
	write((d) => {
		d.prepare('UPDATE accounts SET email = ?, plan = ?, updated_at = ? WHERE id = ?').run(email, plan, now(), id);
	});
}

/** Other rows already logged in as this email (the "browser was already signed in" trap). */
export function accountsWithEmail(email: string, exceptId: string): Account[] {
	if (email === CODEX_NO_EMAIL) return []; // a placeholder, not an identity
	// Same provider only: one person with both a Claude and a Codex login is normal, not the trap.
	const provider = getAccount(exceptId)?.provider;
	return listAccounts().filter(
		(a) => a.id !== exceptId && (!provider || a.provider === provider) && a.email && a.email.toLowerCase() === email.toLowerCase()
	);
}

export interface RemoveResult {
	folder: string;
	folderDeleted: boolean;
	folderNote: string;
}

export function removeAccount(id: string): RemoveResult {
	const a = mustGet(id);
	write((d) => {
		d.prepare('DELETE FROM accounts WHERE id = ?').run(id);
		if (SERVER) d.prepare('DELETE FROM account_usage WHERE account_id = ?').run(id);
	});
	const folder = a.config_dir;
	const sharedWith = listAccounts().some((o) => pathKey(o.config_dir) === pathKey(folder));
	if (sharedWith) return { folder, folderDeleted: false, folderNote: 'Another account still uses this folder, so it was kept.' };
	// Server: only `<data>/accounts/<id>` of THIS row, never another folder the row might point at.
	if (SERVER && path.resolve(folder) !== path.resolve(configDirFor(a.id, a.provider)))
		return { folder, folderDeleted: false, folderNote: "The folder is not this account's own data folder, so it was left alone." };
	if (!isDeletableConfigDir(folder))
		return {
			folder,
			folderDeleted: false,
			folderNote: SERVER
				? 'The folder is not under the data volume accounts folder, so it was left alone.'
				: `The folder is not a %USERPROFILE%\\.${a.provider === 'codex' ? 'codex' : 'claude'}-* folder, so it was left alone.`
		};
	if (!fs.existsSync(folder)) return { folder, folderDeleted: true, folderNote: 'The folder did not exist.' };
	try {
		fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
		return { folder, folderDeleted: !fs.existsSync(folder), folderNote: '' };
	} catch (e) {
		return { folder, folderDeleted: false, folderNote: `Could not delete the folder: ${(e as Error).message}` };
	}
}

export function getCardTheme(): CardTheme {
	const v = (open().prepare("SELECT value FROM meta WHERE key = 'card_theme'").get() as { value: string } | undefined)?.value;
	return CARD_THEMES.includes(v as CardTheme) ? (v as CardTheme) : 'auto';
}

/** Card theme change counts as a write: revision bump + theme regenerated. */
export function setCardTheme(raw: unknown): void {
	if (!CARD_THEMES.includes(raw as CardTheme)) throw new UserError('Card theme must be auto, light or dark.');
	write((d) => {
		d.prepare("INSERT INTO meta (key, value) VALUES ('card_theme', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(raw as string);
	});
}

/** Server mode: the shared connection for auth / tokens / usage tables (same file, same rules). */
export function database(): DatabaseSync {
	return open();
}

/** Called at startup so the DB and its meta rows exist before the first request. */
export function initDb(): void {
	open();
}
