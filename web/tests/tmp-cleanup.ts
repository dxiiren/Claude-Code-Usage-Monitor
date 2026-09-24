// Test temp folders: every suite writes into os.tmpdir(); these helpers make sure they go away.
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
