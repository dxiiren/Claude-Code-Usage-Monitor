import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	compilerOptions: { runes: true },
	kit: {
		adapter: adapter({ out: 'build' })
		// Origin/Host are enforced for every request in src/hooks.server.ts.
	}
};
