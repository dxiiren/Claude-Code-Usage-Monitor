import { defineConfig } from 'vitest/config';

// Unit tests only exercise src/lib/server (plain TS, relative imports) - no SvelteKit plugin needed.
export default defineConfig({
	test: {
		include: ['tests/unit/**/*.test.ts'],
		environment: 'node',
		pool: 'forks',
		testTimeout: 30_000
	}
});
