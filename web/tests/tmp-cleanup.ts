// Test temp folders: every suite writes into os.tmpdir(); these helpers make sure they go away.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Remove a folder; Windows may still hold a SQLite/log handle for a moment, so retry. */
export function removeTree(dir: string | undefined): void {
	if (!dir) return;
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		/* best effort: sweepStale() removes it on a later run */
	}
}

/**
 * Remove a folder once the test processes have exited. Teardown hooks run while a worker (vitest)
 * or the web server (Playwright) may still hold its SQLite file open, which Windows refuses to
 * delete, so try now and hand anything left to a short-lived detached process that retries.
 */
export function removeTreeLater(dir: string | undefined): void {
	if (!dir) return;
	removeTree(dir);
	if (!fs.existsSync(dir)) return;
	const script = `setTimeout(() => { try { require('fs').rmSync(${JSON.stringify(dir)}, { recursive: true, force: true, maxRetries: 30, retryDelay: 500 }); } catch {} }, 3000);`;
	spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * Remove leftovers of earlier runs that died before cleaning up (crash, Ctrl+C): folders in the
 * temp dir starting with `prefix` and older than `maxAgeMs`, so a suite running in parallel with a
 * different prefix, or one that just started, is never touched.
 */
export function sweepStale(prefix: string, maxAgeMs = 30 * 60_000): void {
	const tmp = os.tmpdir();
	let names: string[] = [];
	try {
		names = fs.readdirSync(tmp);
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const full = path.join(tmp, name);
		try {
			if (fs.statSync(full).mtimeMs < cutoff) removeTree(full);
		} catch {
			/* vanished meanwhile */
		}
	}
}
