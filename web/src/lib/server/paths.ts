import os from 'node:os';
import path from 'node:path';

const env = process.env;

/**
 * `local` (default): the Windows desktop companion on 127.0.0.1:47291, next to the widget.
 * `server` (ACCTMGR_MODE=server): the Linux container; it owns the logins and polls usage itself
 * (docs/account-manager-contract.md, "Server mode (Docker) and the widget's remote mode").
 */
export const MODE: 'local' | 'server' = (env.ACCTMGR_MODE ?? '').trim().toLowerCase() === 'server' ? 'server' : 'local';
export const SERVER = MODE === 'server';
export const IS_WINDOWS = process.platform === 'win32';

export const PORT = Number(env.PORT || 47291);

/** Server mode: the public origin users and widgets reach (drives the Origin/Host guard). */
export const PUBLIC_ORIGIN = SERVER ? normalizeOrigin(env.ACCTMGR_PUBLIC_ORIGIN || `http://127.0.0.1:${PORT}`) : '';
export const MANAGER_URL = SERVER ? PUBLIC_ORIGIN : 'http://127.0.0.1:47291';

/** Server mode: the one volume that holds accounts.db and every account's config folder. */
export const DATA_DIR = path.resolve(env.ACCTMGR_DATA_DIR || '/data');
/** Server mode: parent of the per-account Claude config folders (`<data>/accounts/<id>`). */
export const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');

export const USER_HOME = env.USERPROFILE || os.homedir();
export const APPDATA = env.APPDATA || path.join(USER_HOME, 'AppData', 'Roaming');
export const LOCALAPPDATA = env.LOCALAPPDATA || path.join(USER_HOME, 'AppData', 'Local');

export const APP_DIR = SERVER ? DATA_DIR : path.join(APPDATA, 'ClaudeCodeUsageMonitor');
export const DB_FILE = path.join(APP_DIR, 'accounts.db');
export const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
export const THEME_FILE = path.join(APP_DIR, 'themes', 'multi-claude-accounts.json');
export const MENU_DIR = path.join(APP_DIR, 'context-menus');
export const USAGE_CACHE_FILE = path.join(APP_DIR, 'usage-cache.json');

/** Claude Code's own default folder. NEVER deleted, never assigned to a new account. */
export const DEFAULT_CLAUDE_DIR = path.join(USER_HOME, '.claude');
/** The user's own Codex install (CODEX_HOME default). NEVER deleted, never assigned to a new account. */
export const DEFAULT_CODEX_DIR = path.join(USER_HOME, '.codex');

/** Which CLI owns an account (accounts.provider, schema 2). */
export type Provider = 'claude' | 'codex';
export const PROVIDERS: Provider[] = ['claude', 'codex'];
export const asProvider = (v: unknown): Provider => (v === 'codex' ? 'codex' : 'claude');

/** Prefix of temp work dirs a login creates (swept on startup). */
export const LOGIN_TMP_PREFIX = 'claude-usage-login-';

/** `https://Host:443/` -> `https://host` (what a browser sends as Origin). */
export function normalizeOrigin(raw: string): string {
	try {
		return new URL(raw.trim()).origin;
	} catch {
		throw new Error(`ACCTMGR_PUBLIC_ORIGIN is not a valid URL: ${raw}`);
	}
}

/** Claude: CLAUDE_CONFIG_DIR; Codex: CODEX_HOME. Server: `<data>/accounts/<id>` for both. */
export function configDirFor(id: string, provider: Provider = 'claude'): string {
	return SERVER ? path.join(ACCOUNTS_DIR, id) : path.join(USER_HOME, `.${provider}-${id}`);
}

/**
 * Local: true only for a folder that is directly `%USERPROFILE%\.claude-<id>` or `.codex-<id>`:
 * never `%USERPROFILE%\.claude` / `.codex` themselves, never a nested path, never `..` tricks.
 * Server: true only for a direct `<data>/accounts/<id>` child (id = [a-z0-9_]).
 */
export function isDeletableConfigDir(dir: string): boolean {
	const full = path.resolve(dir);
	const base = path.basename(full);
	if (SERVER) {
		if (path.dirname(full) !== path.resolve(ACCOUNTS_DIR)) return false;
		return /^[a-z0-9_]+$/.test(base);
	}
	if (path.dirname(full).toLowerCase() !== path.resolve(USER_HOME).toLowerCase()) return false;
	if (base.toLowerCase() === '.claude' || base.toLowerCase() === '.codex') return false;
	// `.claude-` / `.codex-` + an account id; ids are [a-z0-9_] only (see slugId in db.ts).
	return /^\.(claude|codex)-[a-z0-9_]+$/.test(base);
}

/** Path comparison key: strips the `\?\` prefix, unifies slashes, lower-cases (Windows paths only). */
export function pathKey(p: string): string {
	if (SERVER && !IS_WINDOWS) return p.replace(/\/+$/, '');
	return p.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}
