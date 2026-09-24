// Files the official widget reads today: the card theme + settings.json (compat layer),
// plus the close menu the theme's close button opens. Ported from kit/UsageKit.psm1
// Write-UsageTheme / Write-MonitorSettings.
import fs from 'node:fs';
import path from 'node:path';
import closeMenu from './close-menu.json';
import { buildTheme, type CardTheme } from './theme';
import { MENU_DIR, SETTINGS_FILE, THEME_FILE } from './paths';

export interface ProfileAccount {
	id: string;
	name: string;
	config_dir: string;
}

/** Atomic write, UTF-8 WITHOUT BOM (the app's JSON parser rejects a BOM). */
function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	const text = JSON.stringify(value, null, 2);
	fs.writeFileSync(tmp, text, { encoding: 'utf8' });
	try {
		fs.renameSync(tmp, file);
	} catch {
		// Windows refuses the rename while another process holds the file open: write in place.
		fs.rmSync(tmp, { force: true });
		fs.writeFileSync(file, text, { encoding: 'utf8' });
	}
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		const raw = fs.readFileSync(file, 'utf8').trimStart() /* also strips a BOM (U+FEFF is whitespace in JS) */;
		const v = JSON.parse(raw);
		return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

export function writeTheme(accounts: ProfileAccount[], mode: CardTheme = 'auto'): void {
	writeJson(THEME_FILE, buildTheme(accounts, mode));
	writeJson(path.join(MENU_DIR, 'close-menu.json'), closeMenu);
}

/** Ids the widget has ever seen. New accounts must never reuse one (contract: ids are never reused). */
export function usedClaudeIds(): string[] {
	const s = readJson(SETTINGS_FILE);
	const claude = (s?.accounts as Record<string, unknown> | undefined)?.claude as Record<string, unknown> | undefined;
	const used = claude?.used_ids;
	return Array.isArray(used) ? used.filter((x): x is string => typeof x === 'string') : [];
}

export function writeSettings(accounts: ProfileAccount[]): void {
	const hadFile = fs.existsSync(SETTINGS_FILE);
	const existing = hadFile ? readJson(SETTINGS_FILE) : {};
	if (hadFile && existing === null) {
		// Unparseable settings.json: keep a copy before replacing it so nothing is lost.
		fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.bak-manager-${Date.now()}`);
	}
	const s: Record<string, unknown> = existing ?? {};
	const backup = `${SETTINGS_FILE}.bak-manager`;
	if (hadFile && existing && !fs.existsSync(backup)) fs.copyFileSync(SETTINGS_FILE, backup); // one-time backup

	const used = new Set(usedClaudeIds());
	for (const a of accounts) used.add(a.id);
	const acc =
		s.accounts && typeof s.accounts === 'object' && !Array.isArray(s.accounts)
			? (s.accounts as Record<string, unknown>)
			: {};
	acc.claude = {
		profiles: accounts.map((a) => ({
			config_dir: a.config_dir,
			credentials_path: '',
			enabled: true,
			id: a.id,
			name: a.name
		})),
		selected: accounts[0]?.id ?? '',
		used_ids: [...used]
	};
	s.accounts = acc;
	s.active_theme_path = THEME_FILE;
	s.custom_theme_enabled = true;
	s.show_claude_code = true;
	writeJson(SETTINGS_FILE, s);
}
