// Per-account login status, from two sources:
//  1. the widget's usage-cache.json `error` for that account (serde snake_case of src/poller.rs PollError)
//  2. `claude auth status` for that account's folder (cached, so page polling does not spawn the CLI each time)

export type LoginState = 'ok' | 'expired' | 'logged_out' | 'error';

export interface LoginStatus {
	state: LoginState;
	message: string;
}

export type PollErrorKind = 'expired' | 'logged_out' | 'transient';

/**
 * Maps a PollError as serialized by serde (externally tagged, snake_case):
 * "token_expired" | "auth_required" | "no_credentials" | "request_failed" | "network_error" |
 * "unexpected_response" | { "http_status": 401 }. Same split as PollError::is_auth / is_transient.
 */
export function classifyPollError(raw: unknown): { kind: PollErrorKind; message: string } | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'string') {
		switch (raw) {
			case 'token_expired':
				return { kind: 'expired', message: 'The login token expired.' };
			case 'auth_required':
				return { kind: 'expired', message: 'Claude rejected the saved login.' };
			case 'no_credentials':
				return { kind: 'logged_out', message: 'No saved login in this folder.' };
			case 'network_error':
				return { kind: 'transient', message: 'The widget could not reach Claude (network error).' };
			case 'request_failed':
				return { kind: 'transient', message: 'The last usage request failed.' };
			case 'unexpected_response':
				return { kind: 'transient', message: 'Claude sent an unexpected response.' };
			default:
				return { kind: 'transient', message: `Last poll failed (${raw}).` };
		}
	}
	if (typeof raw === 'object' && raw && 'http_status' in raw) {
		const code = Number((raw as { http_status: unknown }).http_status);
		if (code === 401 || code === 403) return { kind: 'expired', message: `Claude rejected the saved login (HTTP ${code}).` };
		return { kind: 'transient', message: `Claude returned HTTP ${code}${code === 429 ? ' (rate limited)' : ''}.` };
	}
	return { kind: 'transient', message: 'Last poll failed.' };
}

export interface AuthSnapshot {
	loggedIn: boolean;
	email: string | null;
	plan: string | null;
}

/**
 * Combines both sources. Order: an auth-type poll error means "expired" (needs a fresh sign-in
 * even if the CLI still lists a login); then a missing login; then transient poll errors; else ok.
 * `auth === null` means auth status is unknown (not fetched yet / CLI unavailable) and is ignored.
 */
export function loginStatus(opts: { pollError: unknown; auth: AuthSnapshot | null; everLoggedIn: boolean }): LoginStatus {
	const p = classifyPollError(opts.pollError);
	if (p?.kind === 'expired') return { state: 'expired', message: p.message };
	if (p?.kind === 'logged_out') return { state: 'logged_out', message: p.message };
	if (opts.auth && !opts.auth.loggedIn) return { state: 'logged_out', message: 'Claude Code says this folder is not logged in.' };
	if (!opts.auth && !opts.everLoggedIn) return { state: 'logged_out', message: 'Not logged in yet.' };
	if (p?.kind === 'transient') return { state: 'error', message: p.message };
	return { state: 'ok', message: '' };
}

export const needsLogin = (s: LoginState) => s === 'expired' || s === 'logged_out';

// ---------- auth-status cache (stale-while-revalidate) ----------

interface Entry {
	value: AuthSnapshot | null;
	at: number;
	pending: Promise<AuthSnapshot | null> | null;
}

export class AuthStatusCache {
	private entries = new Map<string, Entry>();
	constructor(
		private fetcher: (configDir: string) => Promise<AuthSnapshot | null>,
		private ttlMs = 60_000,
		private now: () => number = Date.now
	) {}

	private refresh(key: string, e: Entry): Promise<AuthSnapshot | null> {
		if (!e.pending) {
			e.pending = this.fetcher(key)
				.catch(() => null)
				.then((v) => {
					e.value = v;
					e.at = this.now();
					e.pending = null;
					return v;
				});
		}
		return e.pending;
	}

	/**
	 * First call for a folder waits for the CLI. Afterwards the cached value is returned at once;
	 * once it is older than the TTL, one background refresh starts (concurrent calls share it).
	 */
	async get(configDir: string): Promise<AuthSnapshot | null> {
		let e = this.entries.get(configDir);
		if (!e) {
			e = { value: null, at: 0, pending: null };
			this.entries.set(configDir, e);
			return this.refresh(configDir, e);
		}
		if (e.at === 0) return e.pending ?? this.refresh(configDir, e);
		if (this.now() - e.at >= this.ttlMs) void this.refresh(configDir, e);
		return e.value;
	}

	/** After a login or removal: forget the folder so the next read asks the CLI again. */
	invalidate(configDir: string): void {
		this.entries.delete(configDir);
	}
}
