import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Server mode (ACCTMGR_MODE=server) e2e: the BUILT server against a throwaway data dir, the fake
// Claude CLI, and a fake usage endpoint (ACCTMGR_USAGE_URL). Own ports, so it can run next to the
// local-mode suite and never touches a real accounts.db, CLI login or Anthropic.
const PORT = 47392;
const USAGE_PORT = 47393;
if (!process.env.ACCTMGR_E2E_SERVER_ROOT) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acctmgr-e2e-srv-'));
	fs.mkdirSync(path.join(root, 'data'), { recursive: true });
	fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
	process.env.ACCTMGR_E2E_SERVER_ROOT = root;
}
const root = process.env.ACCTMGR_E2E_SERVER_ROOT;
const ORIGIN = `http://127.0.0.1:${PORT}`;
process.env.ACCTMGR_E2E_PORT = String(PORT);
process.env.ACCTMGR_E2E_USAGE_PORT = String(USAGE_PORT);
process.env.ACCTMGR_E2E_PASSWORD = 'e2e-admin-password';

export default defineConfig({
	testDir: 'tests/e2e-server',
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	reporter: [['list']],
	use: { baseURL: ORIGIN, trace: 'retain-on-failure' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			command: 'node tests/fixtures/fake-usage-server.mjs',
			url: `http://127.0.0.1:${USAGE_PORT}/calls`,
			reuseExistingServer: false,
			timeout: 15_000,
			env: { FAKE_USAGE_PORT: String(USAGE_PORT) }
		},
		{
			// start.js = what the Docker image runs (sets ORIGIN from ACCTMGR_PUBLIC_ORIGIN, checks config)
			command: 'node start.js',
			url: `${ORIGIN}/healthz`,
			reuseExistingServer: false,
			timeout: 30_000,
			env: {
				ACCTMGR_BUILD_DIR: 'build-e2e',
				ACCTMGR_MODE: 'server',
				ACCTMGR_DATA_DIR: path.join(root, 'data'),
				ACCTMGR_ADMIN_USER: 'Admin',
				ACCTMGR_ADMIN_PASSWORD: process.env.ACCTMGR_E2E_PASSWORD,
				ACCTMGR_TRUST_PROXY: '1',
				ACCTMGR_PUBLIC_ORIGIN: ORIGIN,
				ACCTMGR_USAGE_URL: `http://127.0.0.1:${USAGE_PORT}/api/oauth/usage`,
				ACCTMGR_MESSAGES_URL: `http://127.0.0.1:${USAGE_PORT}/v1/messages`,
				ACCTMGR_CODEX_USAGE_URL: `http://127.0.0.1:${USAGE_PORT}/backend-api/wham/usage`,
				ACCTMGR_POLL_SECONDS: '300',
				HOST: '127.0.0.1',
				PORT: String(PORT),
				TEMP: path.join(root, 'tmp'),
				TMP: path.join(root, 'tmp'),
				TMPDIR: path.join(root, 'tmp'),
				CLAUDE_BIN: path.resolve('tests/fixtures', process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh'),
				CODEX_BIN: path.resolve('tests/fixtures', process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex.sh'),
				EDGE_EXE: 'none'
			}
		}
	]
});
