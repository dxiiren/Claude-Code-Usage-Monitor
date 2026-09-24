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
	// Never spawn the real Claude CLI or Edge from unit tests.
	process.env.CLAUDE_BIN = path.resolve(__dirname, '../fixtures/fake-claude.cmd');
	process.env.EDGE_EXE = 'none';
	return { root, home, appData, appDir: path.join(appData, 'ClaudeCodeUsageMonitor') };
}

/** Fake CLI for this platform: the .cmd shim on Windows, the POSIX shim elsewhere. */
export const FAKE_CLAUDE = path.resolve(__dirname, '../fixtures', process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh');

/**
 * Server mode (ACCTMGR_MODE=server) against a fresh temp data dir, set BEFORE the server modules
 * are imported (paths.ts reads the environment at import time).
 */
export function isolateServer(extra: Record<string, string> = {}): { root: string; data: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acctmgr-srv-'));
	const data = path.join(root, 'data');
	fs.mkdirSync(data, { recursive: true });
	Object.assign(process.env, {
		ACCTMGR_MODE: 'server',
		ACCTMGR_DATA_DIR: data,
		ACCTMGR_ADMIN_PASSWORD: 'correct horse battery',
		ACCTMGR_PUBLIC_ORIGIN: 'https://claude.example.com',
		CLAUDE_BIN: FAKE_CLAUDE,
		EDGE_EXE: 'none',
		...extra
	});
	delete process.env.ACCTMGR_SESSION_SECRET;
	return { root, data };
}
