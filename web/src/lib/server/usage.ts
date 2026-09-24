// Usage numbers come from the widget's own cache (no API call), matched by provider +
// source_path = <config_dir>\.credentials.json (Claude, same as kit Show-UsageStatus) or
// <config_dir>\auth.json (Codex).
import fs from 'node:fs';
import path from 'node:path';
import { USAGE_CACHE_FILE, pathKey } from './paths';
import type { Account } from './db';

export interface UsageWindow {
	percentage: number;
	resetsAt: number | null; // unix seconds
}

export interface AccountUsage {
	session: UsageWindow | null;
	weekly: UsageWindow | null;
	/** The widget's PollError as serialized (e.g. "token_expired", {"http_status":401}); null when the last poll was fine. */
	pollError: unknown;
}

export interface UsageSnapshot {
	updatedUnix: number | null;
	byId: Record<string, AccountUsage | null>;
}

function win(w: unknown): UsageWindow | null {
	if (!w || typeof w !== 'object') return null;
	const o = w as { percentage?: unknown; available?: unknown; resets_at?: { secs_since_epoch?: unknown } };
	if (o.available === false || typeof o.percentage !== 'number') return null;
	const r = o.resets_at?.secs_since_epoch;
	return { percentage: o.percentage, resetsAt: typeof r === 'number' ? r : null };
}

/** provider may be missing (rows from before schema 2): Claude. */
type UsageAccount = Pick<Account, 'id' | 'config_dir'> & { provider?: Account['provider'] };

export function readUsage(accounts: UsageAccount[]): UsageSnapshot {
	const byId: Record<string, AccountUsage | null> = {};
	for (const a of accounts) byId[a.id] = null;
	let cache: { updated_unix?: unknown; data?: { accounts?: unknown } };
	try {
		cache = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8').trimStart() /* also strips a BOM (U+FEFF is whitespace in JS) */);
	} catch {
		return { updatedUnix: null, byId };
	}
	const entries = Array.isArray(cache.data?.accounts) ? (cache.data!.accounts as Record<string, unknown>[]) : [];
	for (const a of accounts) {
		// Claude: <config_dir>\.credentials.json; Codex: <CODEX_HOME>\auth.json (src/accounts.rs).
		const provider = a.provider === 'codex' ? 'codex' : 'claude';
		const want = pathKey(path.join(a.config_dir, provider === 'codex' ? 'auth.json' : '.credentials.json'));
		const e = entries.find(
			(x) => x.provider === provider && typeof x.source_path === 'string' && pathKey(x.source_path) === want
		);
		if (!e) continue;
		const u = (e.usage ?? {}) as { session?: unknown; weekly?: unknown };
		byId[a.id] = {
			session: win(u.session),
			weekly: win(u.weekly),
			pollError: e.error ?? null
		};
	}
	return { updatedUnix: typeof cache.updated_unix === 'number' ? cache.updated_unix : null, byId };
}
