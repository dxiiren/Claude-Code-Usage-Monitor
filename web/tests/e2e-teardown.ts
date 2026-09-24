// Playwright globalTeardown (both configs): remove this run's temp root. It runs BEFORE Playwright
// stops the web server, which still holds the SQLite file open (Windows refuses to delete it), so
// hand the removal to a short-lived detached process that retries after the server has exited.
import { spawn } from 'node:child_process';

export default function teardown() {
	for (const dir of [process.env.ACCTMGR_E2E_ROOT, process.env.ACCTMGR_E2E_SERVER_ROOT]) {
		if (!dir) continue;
		const script = `setTimeout(() => { try { require('fs').rmSync(${JSON.stringify(dir)}, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 }); } catch {} }, 3000);`;
		spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
	}
}
