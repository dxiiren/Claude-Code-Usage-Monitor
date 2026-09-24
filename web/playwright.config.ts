import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// E2E runs the BUILT server on its own port against a throwaway APPDATA / USERPROFILE / TEMP,
// with fake Claude + Codex CLIs and no Edge, so it never touches the real accounts.db, settings.json,
// ~/.claude folders or browser. The temp root is created once in the runner process; workers
// inherit it through the environment.
const PORT = 47391;
if (!process.env.ACCTMGR_E2E_ROOT) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acctmgr-e2e-'));
	for (const d of ['home', 'appdata', 'localappdata', 'tmp']) fs.mkdirSync(path.join(root, d), { recursive: true });
	process.env.ACCTMGR_E2E_ROOT = root;
}
const root = process.env.ACCTMGR_E2E_ROOT;
process.env.ACCTMGR_E2E_PORT = String(PORT);

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: [['list']],
	use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'node build-e2e/index.js',
		url: `http://127.0.0.1:${PORT}/api/accounts`,
		reuseExistingServer: false,
		timeout: 30_000,
		env: {
			HOST: '127.0.0.1',
			PORT: String(PORT),
			USERPROFILE: path.join(root, 'home'),
			APPDATA: path.join(root, 'appdata'),
			LOCALAPPDATA: path.join(root, 'localappdata'),
			TEMP: path.join(root, 'tmp'),
			TMP: path.join(root, 'tmp'),
			CLAUDE_BIN: path.resolve('tests/fixtures/fake-claude.cmd'),
			// fake Codex CLI: never the real one (it would open the default, signed-in browser)
			CODEX_BIN: path.resolve('tests/fixtures/fake-codex.cmd'),
			EDGE_EXE: 'none',
			WIDGET_EXE: path.join(root, 'no-widget.exe')
		}
	}
});
