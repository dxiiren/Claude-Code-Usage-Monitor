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
	/** Paid extra usage in force past a spent window (server mode); null when there is none. */
	extra: { percentage: number; remaining: number; total: number } | null;
	/** Limits next to the two windows, when the provider reports them: one model's own, or (`other`) a feature, team or similar allowance. */
	models: (UsageWindow & { label: string; other?: boolean })[];
	/** The widget's PollError as serialized (e.g. "token_expired", {"http_status":401}); null when the last poll was fine. */
	pollError: unknown;
	/** When these numbers were read (unix seconds). Local mode: the time of the widget's cache, which keeps one for all. */
	readUnix: number | null;
	/** Local mode: the widget marked the numbers as carried over from an earlier poll (its last one failed). */
	stale?: boolean;
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

/**
 * The widget's `limits` (models.rs UsageLimit): every limit next to the two windows. The two windows
 * themselves are in the list too (kind session / weekly_all without a scope) and are left out here.
 */
function limits(list: unknown): AccountUsage['models'] {
	if (!Array.isArray(list)) return [];
	const out: AccountUsage['models'] = [];
	for (const l of list as { kind?: unknown; label?: unknown; model?: unknown; scope?: unknown; usage?: unknown }[]) {
		const w = win(l?.usage);
		if (!w || typeof l.label !== 'string' || !l.label.trim()) continue;
		if ((l.kind === 'session' || l.kind === 'weekly_all') && (l.scope === null || l.scope === undefined)) continue;
		out.push({ label: l.label.trim(), ...w, ...(typeof l.model === 'string' && l.model.trim() ? {} : { other: true }) });
	}
	return out;
}

/** The widget's `credits` (models.rs CreditsSection): paid extra usage in force past a spent window. */
function credits(c: unknown): AccountUsage['extra'] {
	const o = c as { percentage?: unknown; remaining?: unknown; total?: unknown } | null;
	if (!o || typeof o !== 'object' || typeof o.percentage !== 'number' || typeof o.remaining !== 'number' || typeof o.total !== 'number') return null;
	return { percentage: o.percentage, remaining: o.remaining, total: o.total };
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
	const updatedUnix = typeof cache.updated_unix === 'number' ? cache.updated_unix : null;
	const entries = Array.isArray(cache.data?.accounts) ? (cache.data!.accounts as Record<string, unknown>[]) : [];
	for (const a of accounts) {
		// Claude: <config_dir>\.credentials.json; Codex: <CODEX_HOME>\auth.json (src/accounts.rs).
		const provider = a.provider === 'codex' ? 'codex' : 'claude';
		const want = pathKey(path.join(a.config_dir, provider === 'codex' ? 'auth.json' : '.credentials.json'));
		const e = entries.find(
			(x) => x.provider === provider && typeof x.source_path === 'string' && pathKey(x.source_path) === want
		);
		if (!e) continue;
		const u = (e.usage ?? {}) as { session?: unknown; weekly?: unknown; limits?: unknown; credits?: unknown; stale?: unknown };
		byId[a.id] = {
			session: win(u.session),
			weekly: win(u.weekly),
			models: limits(u.limits),
			extra: credits(u.credits),
			pollError: e.error ?? null,
			readUnix: updatedUnix,
			stale: u.stale === true
		};
	}
	return { updatedUnix, byId };
}
