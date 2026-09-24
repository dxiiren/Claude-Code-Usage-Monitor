// Server-mode usage poller: a Node port of the widget's Claude poller (src/poller/claude.rs +
// src/poller.rs + src/poller/retry_after.rs). Same endpoint, same headers, same error kinds,
// same token refresh (run the CLI, never the OAuth endpoint). Results go to account_usage.
import fs from 'node:fs';
import path from 'node:path';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** Header probes stay on the low-cost Haiku tier (claude.rs MODEL_FALLBACK_CHAIN). */
const MODEL_FALLBACK_CHAIN = ['claude-haiku-4-5'];
/**
 * The widget sets no User-Agent for Claude, so ureq sends its default. We send the same value
 * (Cargo.lock: ureq 3.4.2) so the server's traffic looks exactly like a widget poll.
 */
export const USER_AGENT = 'ureq/3.4.2';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_S = 24 * 60 * 60;

/** Serialized like the widget's PollError (serde, snake_case, externally tagged) so status.ts reads it. */
export type PollErrorJson =
	| 'no_credentials'
	| 'token_expired'
	| 'auth_required'
	| 'request_failed'
	| 'network_error'
	| 'unexpected_response'
	| { http_status: number };

export interface WindowUsage {
	available: boolean;
	percentage: number;
	resets_at_unix: number | null;
}
export interface Usage {
	session: WindowUsage;
	weekly: WindowUsage;
}

export type PollResult =
	| { ok: true; usage: Usage }
	| { ok: false; error: PollErrorJson; /** seconds, from Retry-After on 429/5xx */ retryAfter?: number };

export interface PollDeps {
	fetch: typeof fetch;
	/** Runs the CLI so it refreshes its own token (claude.ts refreshTokenViaCli). */
	refresh: (configDir: string) => Promise<void>;
	nowMs: () => number;
	usageUrl: string;
	messagesUrl: string;
}

export function defaultUrls(): { usageUrl: string; messagesUrl: string } {
	// Overrides exist for tests only (e2e points them at a local fake).
	return {
		usageUrl: process.env.ACCTMGR_USAGE_URL || USAGE_URL,
		messagesUrl: process.env.ACCTMGR_MESSAGES_URL || MESSAGES_URL
	};
}

// ---------- credentials ----------

interface Credentials {
	accessToken: string;
	expiresAt: number | null; // unix ms
}

/** claude.rs parse_credentials: claudeAiOauth.accessToken (non-blank) + expiresAt. Never logged. */
export function readCredentials(configDir: string): Credentials | null {
	try {
		const j = JSON.parse(fs.readFileSync(path.join(configDir, '.credentials.json'), 'utf8').trimStart());
		const o = j?.claudeAiOauth;
		const t = o?.accessToken;
		if (typeof t !== 'string' || !t.trim()) return null;
		return { accessToken: t, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null };
	} catch {
		return null;
	}
}

const isExpired = (c: Credentials, nowMs: number) => c.expiresAt !== null && nowMs >= c.expiresAt;

// ---------- parsing ----------

const emptyWindow = (): WindowUsage => ({ available: false, percentage: 0, resets_at_unix: null });

function isoToUnix(v: unknown): number | null {
	if (typeof v !== 'string' || !v) return null;
	const ms = Date.parse(v);
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** claude.rs usage_from_response (session/weekly part) + validated_usage_from_response. */
export function usageFromResponse(body: unknown): Usage | null {
	if (!body || typeof body !== 'object') return null;
	const r = body as Record<string, unknown>;
	const u: Usage = { session: emptyWindow(), weekly: emptyWindow() };
	const bucket = (b: unknown): WindowUsage | null => {
		if (!b || typeof b !== 'object') return null;
		const x = b as { utilization?: unknown; resets_at?: unknown };
		if (typeof x.utilization !== 'number') return null;
		return { available: true, percentage: x.utilization, resets_at_unix: isoToUnix(x.resets_at) };
	};
	u.session = bucket(r.five_hour) ?? u.session;
	u.weekly = bucket(r.seven_day) ?? u.weekly;
	let anyLimit = false;
	// New-format responses may omit the legacy fields; only scope-less limits fill them.
	if (Array.isArray(r.limits)) {
		for (const l of r.limits as Record<string, unknown>[]) {
			const pct = typeof l?.percent === 'number' ? l.percent : typeof l?.utilization === 'number' ? l.utilization : NaN;
			if (typeof l?.kind !== 'string' || !l.kind.trim() || !Number.isFinite(pct) || pct < 0) continue;
			anyLimit = true;
			if (l.scope !== undefined && l.scope !== null) continue;
			const w = { available: true, percentage: pct, resets_at_unix: isoToUnix(l.resets_at) };
			if (l.kind === 'session' && !u.session.available) u.session = w;
			if (l.kind === 'weekly_all' && !u.weekly.available) u.weekly = w;
		}
	}
	if (!u.session.available && !u.weekly.available && !anyLimit) return null;
	return u;
}

const hNum = (h: Headers, n: string) => {
	const v = h.get(n);
	const x = v === null ? NaN : Number(v);
	return Number.isFinite(x) ? x : null;
};

/** claude.rs parse_rate_limit_headers. */
export function usageFromHeaders(h: Headers): Usage {
	const u: Usage = { session: emptyWindow(), weekly: emptyWindow() };
	u.session.percentage = (hNum(h, 'anthropic-ratelimit-unified-5h-utilization') ?? 0) * 100;
	u.session.resets_at_unix = hNum(h, 'anthropic-ratelimit-unified-5h-reset');
	u.weekly.percentage = (hNum(h, 'anthropic-ratelimit-unified-7d-utilization') ?? 0) * 100;
	u.weekly.resets_at_unix = hNum(h, 'anthropic-ratelimit-unified-7d-reset');
	u.session.available = u.session.resets_at_unix !== null || h.has('anthropic-ratelimit-unified-5h-utilization');
	u.weekly.available = u.weekly.resets_at_unix !== null || h.has('anthropic-ratelimit-unified-7d-utilization');
	const overall = hNum(h, 'anthropic-ratelimit-unified-reset');
	const claim = h.get('anthropic-ratelimit-unified-representative-claim');
	if (claim === 'five_hour') u.session.available = true;
	if (claim === 'seven_day') u.weekly.available = true;
	if (u.session.percentage === 0 && u.weekly.percentage === 0) {
		if (h.get('anthropic-ratelimit-unified-status') === 'rejected') {
			if (claim === 'five_hour') u.session.percentage = 100;
			if (claim === 'seven_day') u.weekly.percentage = 100;
		}
		if (u.session.resets_at_unix === null && overall !== null) u.session.resets_at_unix = overall;
	}
	return u;
}

/** retry_after.rs parse_retry_after: delta-seconds or an HTTP date, capped at 24 h. */
export function parseRetryAfter(v: string | null, nowMs: number): number | null {
	if (!v) return null;
	const s = v.trim();
	let secs: number;
	if (/^\d+$/.test(s)) secs = Number(s);
	else {
		const t = Date.parse(s);
		if (!Number.isFinite(t)) return null;
		secs = Math.max(0, Math.ceil((t - nowMs) / 1000));
	}
	secs = Math.min(secs, MAX_RETRY_AFTER_S);
	return secs > 0 ? secs : null;
}

// ---------- HTTP ----------

class HttpStatus {
	constructor(
		public status: number,
		public retryAfter: number | null
	) {}
}

async function tryUsageEndpoint(token: string, deps: PollDeps): Promise<Usage | null> {
	let res: Response;
	try {
		res = await deps.fetch(deps.usageUrl, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch {
		throw 'network_error' as const;
	}
	if (res.status >= 400) {
		void res.body?.cancel().catch(() => undefined);
		const s = res.status;
		// classify_usage_failure: auth and transient failures end the poll; any other status means the
		// endpoint is not usable for this account and the Messages API fallback is tried.
		if (s === 401 || s === 403) throw new HttpStatus(s, null);
		if (s === 429 || s >= 500) throw new HttpStatus(s, parseRetryAfter(res.headers.get('retry-after'), deps.nowMs()));
		return null;
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw 'unexpected_response' as const;
	}
	const u = usageFromResponse(body);
	if (!u) throw 'unexpected_response' as const;
	return u;
}

/** claude.rs fetch_usage_via_messages: a 1-token Haiku request whose only purpose is its headers. */
async function viaMessages(token: string, deps: PollDeps): Promise<Usage> {
	let last: PollErrorJson = 'request_failed';
	for (const model of MODEL_FALLBACK_CHAIN) {
		let res: Response;
		try {
			res = await deps.fetch(deps.messagesUrl, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'anthropic-version': '2023-06-01',
					'anthropic-beta': 'oauth-2025-04-20',
					'content-type': 'application/json',
					'User-Agent': USER_AGENT
				},
				body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: '.' }] }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch {
			last = 'network_error';
			continue;
		}
		void res.body?.cancel().catch(() => undefined);
		if (res.status === 401 || res.status === 403) throw new HttpStatus(res.status, null);
		const h = res.headers;
		if (
			h.has('anthropic-ratelimit-unified-5h-utilization') ||
			h.has('anthropic-ratelimit-unified-7d-utilization') ||
			h.has('anthropic-ratelimit-unified-status')
		)
			return usageFromHeaders(h);
		last = res.status >= 400 ? { http_status: res.status } : 'request_failed';
	}
	throw last;
}

/** claude.rs fetch_usage_with_fallback. */
async function fetchUsage(token: string, deps: PollDeps): Promise<Usage> {
	const data = await tryUsageEndpoint(token, deps);
	if (data) {
		if ((data.session.available && data.session.resets_at_unix === null) || (data.weekly.available && data.weekly.resets_at_unix === null)) {
			try {
				const fb = await viaMessages(token, deps);
				data.session.available ||= fb.session.available;
				data.weekly.available ||= fb.weekly.available;
				data.session.resets_at_unix ??= fb.session.resets_at_unix;
				data.weekly.resets_at_unix ??= fb.weekly.resets_at_unix;
			} catch {
				/* keep the endpoint's numbers */
			}
		}
		return data;
	}
	return viaMessages(token, deps);
}

/** claude.rs poll_account for one `<config_dir>/.credentials.json`, refreshing via the CLI when expired. */
export async function pollAccount(configDir: string, deps: PollDeps): Promise<PollResult> {
	let creds = readCredentials(configDir);
	if (!creds) return { ok: false, error: 'no_credentials' };
	if (isExpired(creds, deps.nowMs())) {
		await deps.refresh(configDir);
		creds = readCredentials(configDir);
		if (!creds || isExpired(creds, deps.nowMs())) return { ok: false, error: 'token_expired' };
	}
	try {
		return { ok: true, usage: await fetchUsage(creds.accessToken, deps) };
	} catch (e) {
		if (e instanceof HttpStatus)
			return { ok: false, error: { http_status: e.status }, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) };
		if (typeof e === 'string' || (e && typeof e === 'object' && 'http_status' in e)) return { ok: false, error: e as PollErrorJson };
		return { ok: false, error: 'request_failed' };
	}
}

// ---------- scheduling ----------

export interface PollTarget {
	id: string;
	configDir: string;
}

export interface PollStore {
	targets: () => PollTarget[];
	save: (id: string, r: PollResult, nowMs: number) => void;
}

/**
 * Cycles through the enabled accounts every `intervalS`, one at a time, spaced out across the
 * interval (at most `maxStaggerMs` apart) so a burst never hits the API. 429/5xx: honour
 * Retry-After (capped 24 h); a 429 without it backs off interval * 2^(n-1), at most 1 h.
 */
export class Poller {
	private cooldownUntil = new Map<string, number>();
	private strikes = new Map<string, number>();
	private timer: NodeJS.Timeout | null = null;
	private running: Promise<void> | null = null;
	private inFlight = new Map<string, Promise<void>>();
	private stopped = false;

	constructor(
		private store: PollStore,
		private deps: PollDeps,
		private intervalS = 300,
		private maxStaggerMs = 15_000,
		private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
	) {}

	/** Poll one account now (after a login, or from a cycle); concurrent calls for one id share the run. */
	pollOne(t: PollTarget, force = false): Promise<void> {
		const existing = this.inFlight.get(t.id);
		if (existing) return existing;
		const now = this.deps.nowMs();
		if (!force && (this.cooldownUntil.get(t.id) ?? 0) > now) return Promise.resolve();
		const p = (async () => {
			try {
				const r = await pollAccount(t.configDir, this.deps);
				const at = this.deps.nowMs();
				this.applyBackoff(t.id, r, at);
				this.store.save(t.id, r, at);
			} catch (e) {
				console.error('[account-manager] poll failed:', (e as Error).message);
			} finally {
				this.inFlight.delete(t.id);
			}
		})();
		this.inFlight.set(t.id, p);
		return p;
	}

	private applyBackoff(id: string, r: PollResult, at: number): void {
		const status = !r.ok && typeof r.error === 'object' ? r.error.http_status : 0;
		if (r.ok || (status !== 429 && status < 500)) {
			this.strikes.delete(id);
			this.cooldownUntil.delete(id);
			return;
		}
		const n = (this.strikes.get(id) ?? 0) + 1;
		this.strikes.set(id, n);
		const retryAfter = !r.ok && r.retryAfter ? r.retryAfter : null;
		let secs = retryAfter ?? (status === 429 ? Math.min(this.intervalS * 2 ** (n - 1), 3600) : 0);
		secs = Math.min(secs, MAX_RETRY_AFTER_S);
		if (secs > 0) this.cooldownUntil.set(id, at + secs * 1000);
	}

	/** Seconds until this account may be polled again (0 = no cooldown). */
	cooldownRemaining(id: string): number {
		return Math.max(0, Math.ceil(((this.cooldownUntil.get(id) ?? 0) - this.deps.nowMs()) / 1000));
	}

	async cycle(): Promise<void> {
		const targets = this.store.targets();
		const gap = targets.length > 1 ? Math.min((this.intervalS * 1000) / targets.length, this.maxStaggerMs) : 0;
		for (let i = 0; i < targets.length && !this.stopped; i++) {
			if (i > 0 && gap > 0) await this.sleep(gap);
			await this.pollOne(targets[i]);
		}
	}

	start(): void {
		if (this.timer || this.stopped) return;
		const tick = () => {
			if (!this.running)
				this.running = this.cycle()
					.catch((e) => console.error('[account-manager] poll cycle failed:', (e as Error).message))
					.finally(() => (this.running = null));
		};
		tick();
		this.timer = setInterval(tick, this.intervalS * 1000);
		this.timer.unref?.();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
