// Server mode: account_usage rows (the server's own poll results), the reading history that
// reports are cut from (usage_samples), and the one Poller instance.
import { UserError, database, listAccounts, type Account } from './db';
import { refreshTokenViaCli } from './claude';
import { refreshCodexTokenViaCli } from './codex';
import { Poller, defaultUrls, type PollResult, type Usage } from './poller';
import type { AccountUsage, UsageSnapshot } from './usage';
import { getSettings, onSettingsChange } from './settings';
import type { ReportAccount, Sample } from './report';

interface Row {
	account_id: string;
	usage_json: string | null;
	error_json: string | null;
	polled_unix: number | null;
	ok_unix: number | null;
}

/** Keeps the last GOOD usage when a poll fails (like the widget keeps stale data). */
export function saveResult(id: string, r: PollResult, nowMs: number): void {
	const d = database();
	// The account may have been removed while its poll was running.
	if (!d.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) return;
	const unix = Math.floor(nowMs / 1000);
	const iso = new Date(nowMs).toISOString();
	if (r.ok) {
		d.prepare(
			`INSERT INTO account_usage (account_id, usage_json, error_json, polled_at, polled_unix, ok_unix) VALUES (?, ?, NULL, ?, ?, ?)
			 ON CONFLICT(account_id) DO UPDATE SET usage_json = excluded.usage_json, error_json = NULL, polled_at = excluded.polled_at,
			   polled_unix = excluded.polled_unix, ok_unix = excluded.ok_unix`
		).run(id, JSON.stringify(r.usage), iso, unix, unix);
		recordSample(id, r.usage, unix);
	} else {
		d.prepare(
			`INSERT INTO account_usage (account_id, usage_json, error_json, polled_at, polled_unix, ok_unix) VALUES (?, NULL, ?, ?, ?, NULL)
			 ON CONFLICT(account_id) DO UPDATE SET error_json = excluded.error_json, polled_at = excluded.polled_at, polled_unix = excluded.polled_unix`
		).run(id, JSON.stringify(r.error), iso, unix);
	}
}

// ---------- reading history (what reports are cut from) ----------

let lastPruneUnix = 0;

/** Keeps one good reading. Failed polls store nothing, so an outage shows as a gap, not as zero use. */
function recordSample(id: string, usage: Usage, unix: number): void {
	const d = database();
	const win = (w: Usage['session'] | undefined) => (w && w.available ? { pct: w.percentage, reset: w.resets_at_unix ?? null } : { pct: null, reset: null });
	const s = win(usage.session);
	const w = win(usage.weekly);
	d.prepare('INSERT OR REPLACE INTO usage_samples (account_id, ts_unix, s_pct, s_reset_unix, w_pct, w_reset_unix) VALUES (?, ?, ?, ?, ?, ?)').run(
		id,
		unix,
		s.pct,
		s.reset,
		w.pct,
		w.reset
	);
	// The account's current name, so a report can still name it after it is removed.
	d.prepare(
		`INSERT INTO report_accounts (account_id, name, provider) SELECT id, name, provider FROM accounts WHERE id = ?
		 ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, provider = excluded.provider`
	).run(id);
	if (unix - lastPruneUnix >= 86_400) {
		lastPruneUnix = unix;
		pruneSamples(unix);
	}
}

/** Drops readings older than Settings > Keep history for (0 = keep forever). Returns rows removed. */
export function pruneSamples(nowUnix: number, days = getSettings().historyDays): number {
	if (days <= 0) return 0;
	return Number(database().prepare('DELETE FROM usage_samples WHERE ts_unix < ?').run(nowUnix - days * 86_400).changes);
}

/** Readings of the hourly-session window per account, oldest first, for from <= ts < to. */
export function samplesBetween(from: number, to: number): Map<string, Sample[]> {
	const rows = database()
		.prepare('SELECT account_id, ts_unix, s_pct, s_reset_unix FROM usage_samples WHERE ts_unix >= ? AND ts_unix < ? ORDER BY account_id, ts_unix')
		.all(from, to) as unknown as { account_id: string; ts_unix: number; s_pct: number | null; s_reset_unix: number | null }[];
	const out = new Map<string, Sample[]>();
	for (const r of rows) {
		let list = out.get(r.account_id);
		if (!list) out.set(r.account_id, (list = []));
		list.push({ ts: r.ts_unix, pct: r.s_pct, reset: r.s_reset_unix });
	}
	return out;
}

/** One timestamp per hour that has any reading in the range (enough to mark calendar days). */
export function sampleHours(from: number, to: number): number[] {
	return (
		database().prepare('SELECT DISTINCT ts_unix / 3600 AS h FROM usage_samples WHERE ts_unix >= ? AND ts_unix < ? ORDER BY h').all(from, to) as unknown as {
			h: number;
		}[]
	).map((r) => r.h * 3600);
}

/** Oldest reading kept, or null when there is no history yet. */
export function firstSampleUnix(): number | null {
	return (database().prepare('SELECT MIN(ts_unix) AS m FROM usage_samples').get() as { m: number | null }).m;
}

/** Current accounts in card order, then removed accounts that still have a name on record. */
export function reportAccounts(): ReportAccount[] {
	const current = listAccounts().map((a) => ({ id: a.id, name: a.name, provider: a.provider as string, current: true }));
	const known = new Set(current.map((a) => a.id));
	const gone = (database().prepare('SELECT account_id, name, provider FROM report_accounts ORDER BY name').all() as unknown as {
		account_id: string;
		name: string;
		provider: string;
	}[])
		.filter((r) => !known.has(r.account_id))
		.map((r) => ({ id: r.account_id, name: r.name, provider: r.provider, current: false }));
	return [...current, ...gone];
}

/** After a successful login: the old error no longer applies (the next poll replaces the row anyway). */
export function clearError(id: string): void {
	database().prepare('UPDATE account_usage SET error_json = NULL WHERE account_id = ?').run(id);
}

export function readRows(): Map<string, Row> {
	const rows = database().prepare('SELECT account_id, usage_json, error_json, polled_unix, ok_unix FROM account_usage').all() as unknown as Row[];
	return new Map(rows.map((r) => [r.account_id, r]));
}

function parse<T>(s: string | null): T | null {
	if (!s) return null;
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
}

/** Stored usage in the widget-API shape, or null when never fetched. */
export function storedUsage(row: Row | undefined): Usage | null {
	return parse<Usage>(row?.usage_json ?? null);
}

/** Same shape readUsage() gives in local mode, from the DB instead of usage-cache.json. */
export function readServerUsage(accounts: Account[]): UsageSnapshot {
	const rows = readRows();
	const byId: Record<string, AccountUsage | null> = {};
	let updated: number | null = null;
	for (const a of accounts) {
		const r = rows.get(a.id);
		if (!r) {
			byId[a.id] = null;
			continue;
		}
		if (r.polled_unix && (updated === null || r.polled_unix > updated)) updated = r.polled_unix;
		const u = storedUsage(r);
		const win = (w: Usage['session'] | undefined) =>
			w && w.available ? { percentage: w.percentage, resetsAt: w.resets_at_unix ?? null } : null;
		byId[a.id] = { session: win(u?.session), weekly: win(u?.weekly), pollError: parse(r.error_json) };
	}
	return { updatedUnix: updated, byId };
}

let poller: Poller | null = null;

export function getPoller(): Poller {
	if (poller) return poller;
	const interval = getSettings().pollSeconds;
	onSettingsChange((next) => poller?.setIntervalS(next.pollSeconds));
	poller = new Poller(
		{
			targets: () =>
				listAccounts()
					.filter((a) => a.enabled)
					.map((a) => ({ id: a.id, configDir: a.config_dir, provider: a.provider })),
			save: saveResult
		},
		{
			fetch: globalThis.fetch,
			refresh: (dir) => refreshTokenViaCli(dir),
			refreshCodex: (dir) => refreshCodexTokenViaCli(dir),
			nowMs: Date.now,
			...defaultUrls()
		},
		interval
	);
	return poller;
}

/** Fire-and-forget poll of one account (after login); errors land in the row, never thrown. */
export function pollAccountSoon(a: Pick<Account, 'id' | 'config_dir'> & { provider?: Account['provider'] }): Promise<void> {
	return getPoller().pollOne({ id: a.id, configDir: a.config_dir, provider: a.provider ?? 'claude' }, true);
}

// ---------- "Refresh now" on the Usage page ----------

let lastManualMs = 0;

/**
 * Reads usage straight away for every enabled account instead of waiting for the next scheduled
 * reading. Accounts the API has rate limited are skipped (their cooldown still applies).
 * Settings > Wait between manual refreshes spaces the button out for everyone.
 */
export async function refreshNow(nowMs = Date.now()): Promise<{ refreshed: number; skipped: number }> {
	const waitS = getSettings().refreshWaitSeconds;
	const left = Math.ceil((lastManualMs + waitS * 1000 - nowMs) / 1000);
	if (left > 0) throw Object.assign(new UserError(`Refreshed a moment ago. Try again in ${left} seconds.`, 429), { retryAfter: left });
	const p = getPoller();
	const targets = listAccounts().filter((a) => a.enabled);
	lastManualMs = nowMs;
	const ready = targets.filter((a) => p.cooldownRemaining(a.id) === 0);
	// A slow or hung API must not hold the button forever; the readings still land when they finish.
	const settle = Promise.all(ready.map((a) => p.pollOne({ id: a.id, configDir: a.config_dir, provider: a.provider })));
	await Promise.race([settle, new Promise((r) => setTimeout(r, 20_000))]);
	return { refreshed: ready.length, skipped: targets.length - ready.length };
}

/** Tests only. */
export function resetManualRefresh(): void {
	lastManualMs = 0;
}
