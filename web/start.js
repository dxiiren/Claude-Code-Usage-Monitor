// `npm start` = `node build`.
// Local mode (default): bound to 127.0.0.1:47291 (set here so it works in cmd, pwsh and bash alike).
// Server mode (ACCTMGR_MODE=server, the Docker image): refuses to start without the admin password,
// listens on HOST (default 0.0.0.0) and tells adapter-node the public origin, so SvelteKit's own
// CSRF check and cookies see the https URL the browser uses behind a tunnel / reverse proxy.
const server = (process.env.ACCTMGR_MODE ?? '').trim().toLowerCase() === 'server';
if (server) {
	if (!process.env.ACCTMGR_ADMIN_PASSWORD) {
		console.error(
			'[account-manager] FATAL: ACCTMGR_ADMIN_PASSWORD is required in server mode (it protects every page and API). Set it in deploy/.env.'
		);
		process.exit(1);
	}
	process.env.HOST = process.env.HOST || '0.0.0.0';
	process.env.PORT = process.env.PORT || '47291';
	if (!process.env.ORIGIN) {
		let origin = `http://127.0.0.1:${process.env.PORT}`;
		if (process.env.ACCTMGR_PUBLIC_ORIGIN) {
			try {
				origin = new URL(process.env.ACCTMGR_PUBLIC_ORIGIN).origin;
			} catch {
				console.error(`[account-manager] FATAL: ACCTMGR_PUBLIC_ORIGIN is not a valid URL: ${process.env.ACCTMGR_PUBLIC_ORIGIN}`);
				process.exit(1);
			}
		}
		process.env.ORIGIN = origin;
	}
} else {
	process.env.HOST = '127.0.0.1';
	process.env.PORT = process.env.PORT || '47291';
}
// ACCTMGR_BUILD_DIR: tests run the e2e build (build-e2e/) through this same entry point.
const dir = process.env.ACCTMGR_BUILD_DIR || 'build';
await import(new URL(`./${dir}/index.js`, import.meta.url).href);
