import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Points APPDATA / USERPROFILE / LOCALAPPDATA at a fresh temp tree BEFORE the server modules
 * are imported (paths.ts reads them at import time), so tests never touch the real accounts.db.
 */
export function isolateHome(): { root: string; home: string; appData: string; appDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acctmgr-unit-'));
	const home = path.join(root, 'home');
	const appData = path.join(root, 'appdata');
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(appData, { recursive: true });
	process.env.USERPROFILE = home;
	process.env.APPDATA = appData;
	process.env.LOCALAPPDATA = path.join(root, 'localappdata');
	process.env.WIDGET_EXE = path.join(root, 'no-widget.exe');
	return { root, home, appData, appDir: path.join(appData, 'ClaudeCodeUsageMonitor') };
}
