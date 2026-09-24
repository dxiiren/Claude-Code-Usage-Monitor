import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	compilerOptions: { runes: true },
	kit: {
		// e2e builds go to build-e2e/ (scripts/build-e2e.mjs) so tests never rewrite the live build/.
		adapter: adapter({ out: process.env.ACCTMGR_BUILD_OUT || 'build' })
		// Origin/Host are enforced for every request in src/hooks.server.ts.
	}
};
