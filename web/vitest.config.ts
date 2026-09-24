import { defineConfig } from 'vitest/config';

// Unit tests only exercise src/lib/server (plain TS, relative imports) - no SvelteKit plugin needed.
// The Codex login files share the CLI's fixed callback port 1455 and the login temp-folder prefix,
// so they run one after the other; everything else runs in parallel.
const CODEX = ['tests/unit/codex.test.ts', 'tests/unit/server-codex.test.ts'];
export default defineConfig({
	test: {
		// one temp folder per run, removed at the end (tests/unit/global-setup.ts)
		globalSetup: ['tests/unit/global-setup.ts'],
		environment: 'node',
		pool: 'forks',
		testTimeout: 30_000,
		projects: [
			{ extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], exclude: CODEX } },
			{ extends: true, test: { name: 'codex', include: CODEX, fileParallelism: false } }
		]
	}
});
