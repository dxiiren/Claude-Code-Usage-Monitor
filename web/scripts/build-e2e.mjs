// Builds the app for the e2e suite into build-e2e/ instead of build/.
// build/ is what the live Account Manager (kit/manager.vbs -> start.js) serves; rebuilding
// it under a running server makes every not-yet-loaded route 500 until a restart.
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx vite build', {
	stdio: 'inherit',
	shell: true,
	env: { ...process.env, ACCTMGR_BUILD_OUT: 'build-e2e' }
});
process.exit(r.status ?? 1);
