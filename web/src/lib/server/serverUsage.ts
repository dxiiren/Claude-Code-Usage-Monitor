// Server mode: account_usage rows (the server's own poll results) + the one Poller instance.
import { database, listAccounts, type Account } from './db';
import { refreshTokenViaCli } from './claude';
import { Poller, defaultUrls, type PollResult, type Usage } from './poller';
import type { AccountUsage, UsageSnapshot } from './usage';

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
	} else {
		d.prepare(
			`INSERT INTO account_usage (account_id, usage_json, error_json, polled_at, polled_unix, ok_unix) VALUES (?, NULL, ?, ?, ?, NULL)
			 ON CONFLICT(account_id) DO UPDATE SET error_json = excluded.error_json, polled_at = excluded.polled_at, polled_unix = excluded.polled_unix`
		).run(id, JSON.stringify(r.error), iso, unix);
	}
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
	const interval = Math.max(30, Number(process.env.ACCTMGR_POLL_SECONDS) || 300);
	poller = new Poller(
		{
			targets: () =>
				listAccounts()
					.filter((a) => a.enabled)
					.map((a) => ({ id: a.id, configDir: a.config_dir })),
			save: saveResult
		},
		{ fetch: globalThis.fetch, refresh: (dir) => refreshTokenViaCli(dir), nowMs: Date.now, ...defaultUrls() },
		interval
	);
	return poller;
}

/** Fire-and-forget poll of one account (after login); errors land in the row, never thrown. */
export function pollAccountSoon(a: Pick<Account, 'id' | 'config_dir'>): Promise<void> {
	return getPoller().pollOne({ id: a.id, configDir: a.config_dir }, true);
}
