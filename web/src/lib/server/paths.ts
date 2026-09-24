import os from 'node:os';
import path from 'node:path';

const env = process.env;

export const PORT = Number(env.PORT || 47291);
export const MANAGER_URL = 'http://127.0.0.1:47291';

export const USER_HOME = env.USERPROFILE || os.homedir();
export const APPDATA = env.APPDATA || path.join(USER_HOME, 'AppData', 'Roaming');
export const LOCALAPPDATA = env.LOCALAPPDATA || path.join(USER_HOME, 'AppData', 'Local');

export const APP_DIR = path.join(APPDATA, 'ClaudeCodeUsageMonitor');
export const DB_FILE = path.join(APP_DIR, 'accounts.db');
export const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
export const THEME_FILE = path.join(APP_DIR, 'themes', 'multi-claude-accounts.json');
export const MENU_DIR = path.join(APP_DIR, 'context-menus');
export const USAGE_CACHE_FILE = path.join(APP_DIR, 'usage-cache.json');

/** Claude Code's own default folder. NEVER deleted, never assigned to a new account. */
export const DEFAULT_CLAUDE_DIR = path.join(USER_HOME, '.claude');

/** Prefix of temp work dirs a login creates (swept on startup). */
export const LOGIN_TMP_PREFIX = 'claude-usage-login-';

export function configDirFor(id: string): string {
	return path.join(USER_HOME, `.claude-${id}`);
}

/**
 * True only for a folder that is directly `%USERPROFILE%\.claude-<something>`:
 * never `%USERPROFILE%\.claude` itself, never a nested path, never `..` tricks.
 */
export function isDeletableConfigDir(dir: string): boolean {
	const full = path.resolve(dir);
	if (path.dirname(full).toLowerCase() !== path.resolve(USER_HOME).toLowerCase()) return false;
	const base = path.basename(full);
	if (base.toLowerCase() === '.claude') return false;
	// `.claude-` + an account id; ids are [a-z0-9_] only (see slugId in db.ts).
	return /^\.claude-[a-z0-9_]+$/.test(base);
}

/** Path comparison key: strips the `\\?\` prefix, unifies slashes, lower-cases. */
export function pathKey(p: string): string {
	return p.replace(/^\\\\\?\\/, '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}
