// Server-mode usage poller: a Node port of the widget's Claude poller (src/poller/claude.rs +
// src/poller.rs + src/poller/retry_after.rs). Same endpoint, same headers, same error kinds,
// same token refresh (run the CLI, never the OAuth endpoint). Results go to account_usage.
import fs from 'node:fs';
import path from 'node:path';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** src/poller/codex.rs CODEX_USAGE_URL. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
/** codex.rs sends exactly this User-Agent. */
export const CODEX_USER_AGENT = 'codex-cli';
/** codex.rs WEEKLY_WINDOW_THRESHOLD_SECONDS: a window of a day or longer is the weekly allowance. */
const WEEKLY_WINDOW_THRESHOLD_SECONDS = 86_400;
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
/**
 * A limit next to the two windows (src/poller/claude/limits.rs): usually one model's own allowance,
 * such as a weekly Opus limit.
 */
export interface ModelLimit {
	label: string;
	percentage: number;
	resets_at_unix: number | null;
	/** Set when the limit is NOT one model's: a feature, team or other allowance. What it stops is not known. */
	other?: true;
}
/** Paid extra usage that carries an account past a spent window (claude.rs claude_credits). Amounts are in the account's own currency. */
export interface ExtraUsage {
	percentage: number;
	remaining: number;
	total: number;
}
/**
 * A Codex credit balance as one answer gave it, in raw credits (codex.rs CodexCredits). Codex reports
 * no ceiling, so `baseline` (the balance at the last top-up) is learned from reading to reading by
 * codexExtra; a fresh answer carries its own balance there.
 */
export interface CodexCredits {
	/** the ChatGPT account the balance belongs to */
	account: string | null;
	balance: number;
	baseline: number;
	/** credits can carry the account right now: it has some, they are not unlimited, and an allowance is spent */
	live: boolean;
	/** the provider says the credit spending limit is reached as well */
	capped: boolean;
}
export interface Usage {
	session: WindowUsage;
	weekly: WindowUsage;
	/** Codex only: the credit balance behind `extra`, kept with the reading so the next one can be measured against it. */
	credits?: CodexCredits;
	/** Present only while a window is spent and paid extra usage has started covering the overflow. */
	extra?: ExtraUsage;
	/** Present only when the answer carried per-model limits: an account can be out of one model while both windows have room. */
	models?: ModelLimit[];
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
	/** Codex: the wham/usage endpoint (defaults to CODEX_USAGE_URL). */
	codexUsageUrl?: string;
	/** Codex: runs the CLI so it refreshes its own token (codex.ts refreshCodexTokenViaCli). */
	refreshCodex?: (codexHome: string) => Promise<void>;
}

export function defaultUrls(): { usageUrl: string; messagesUrl: string; codexUsageUrl: string } {
	// Overrides exist for tests only (e2e points them at a local fake).
	return {
		usageUrl: process.env.ACCTMGR_USAGE_URL || USAGE_URL,
		messagesUrl: process.env.ACCTMGR_MESSAGES_URL || MESSAGES_URL,
		codexUsageUrl: process.env.ACCTMGR_CODEX_USAGE_URL || CODEX_USAGE_URL
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
	// A window that is present but unreadable fails the whole answer, as it does in the widget:
	// showing it as "no data" would hide a window that may be at its limit.
	for (const b of [r.five_hour, r.seven_day]) if (b !== undefined && b !== null && !bucket(b)) return null;
	u.session = bucket(r.five_hour) ?? u.session;
	u.weekly = bucket(r.seven_day) ?? u.weekly;
	let anyLimit = false;
	// Every limit next to the two windows, as the widget keeps them (limits.rs parse). `key` tells two
	// limits apart: the kind plus the model or scope it covers.
	const found: { key: string; kind: string; label: string; model: boolean; active: boolean; percentage: number; resets: unknown; scope?: unknown }[] = [];
	const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
	const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '_');
	const words = (v: string) => v.replace(/_/g, ' ').trim();
	// New-format responses may omit the legacy fields; only scope-less limits fill them.
	if (Array.isArray(r.limits)) {
		for (const l of r.limits as Record<string, unknown>[]) {
			const pct = typeof l?.percent === 'number' ? l.percent : typeof l?.utilization === 'number' ? l.utilization : NaN;
			if (typeof l?.kind !== 'string' || !l.kind.trim() || !Number.isFinite(pct) || pct < 0) continue;
			anyLimit = true;
			const scope = l.scope !== undefined && l.scope !== null ? l.scope : null;
			if (scope === null && (l.kind === 'session' || l.kind === 'weekly_all')) {
				// the two windows themselves
				const w = { available: true, percentage: pct, resets_at_unix: isoToUnix(l.resets_at) };
				if (l.kind === 'session' && !u.session.available) u.session = w;
				if (l.kind === 'weekly_all' && !u.weekly.available) u.weekly = w;
				continue;
			}
			const m = (scope as { model?: { display_name?: unknown; id?: unknown } } | null)?.model;
			const name = text(m?.display_name) ?? text(m?.id);
			found.push({
				key: `${slug(l.kind)}_${name ? slug(name) : scope === null ? '' : JSON.stringify(scope)}`,
				kind: l.kind,
				label: name ?? words(l.kind),
				model: !!name,
				active: l.is_active === true,
				percentage: pct,
				resets: l.resets_at,
				scope
			});
		}
	}
	// The older top-level buckets, known and future ones: any object with a numeric utilization.
	for (const [field, value] of Object.entries(r)) {
		// extra_usage describes the paid extra usage (it carries a utilization too): that is `extra`, not a limit
		if (['five_hour', 'seven_day', 'limits', 'spend', 'extra_usage'].includes(field) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
		const b = value as { utilization?: unknown; resets_at?: unknown; is_active?: unknown };
		if (typeof b.utilization !== 'number' || !Number.isFinite(b.utilization) || b.utilization < 0) continue;
		const name = field === 'seven_day_opus' ? 'Opus' : field === 'seven_day_sonnet' ? 'Sonnet' : null;
		// The array is authoritative when it carries the same allowance: the same model by name, or a
		// longer name for it ("Claude Opus 5") at the same level. A different level is a different
		// allowance, and dropping it could hide one that is used up.
		if (
			name &&
			found.some(
				(f) =>
					f.model &&
					((f.kind === 'weekly_scoped' && f.label.toLowerCase() === name.toLowerCase()) ||
						(f.label.toLowerCase().includes(name.toLowerCase()) && Math.abs(f.percentage - (b.utilization as number)) < 0.5))
			)
		)
			continue;
		found.push({ key: slug(field), kind: field, label: name ?? words(field), model: !!name, active: b.is_active === true, percentage: b.utilization, resets: b.resets_at });
	}
	if (!u.session.available && !u.weekly.available && !anyLimit && !found.length) return null;
	if (found.length) {
		// one row per limit: of two answers for the same one, the active wins, then the fullest
		found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : Number(b.active) - Number(a.active) || b.percentage - a.percentage));
		const kept = found.filter((f, i) => i === 0 || found[i - 1].key !== f.key);
		// two limits of one model (weekly and daily, say) must not look like one
		const twice = (f: (typeof kept)[number]) => kept.filter((x) => x.label.toLowerCase() === f.label.toLowerCase()).length > 1;
		// what a non-model scope names, e.g. {team: "design"} -> "design"
		const scopeText = (f: (typeof kept)[number]) =>
			f.scope && typeof f.scope === 'object' && !f.model
				? Object.values(f.scope as Record<string, unknown>)
						.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
						.join(' ')
						.trim()
				: '';
		const named = kept.map((f) => {
			if (!twice(f)) return f.label;
			if (words(f.kind).toLowerCase() !== f.label.toLowerCase()) return `${f.label} (${words(f.kind)})`;
			return scopeText(f) ? `${f.label} (${scopeText(f)})` : f.label;
		});
		// whatever is still the same after that is numbered, so no two rows carry one name
		const labels = named.map((n, i) => {
			const same = named.reduce<number[]>((acc, x, j) => (x.toLowerCase() === n.toLowerCase() ? [...acc, j] : acc), []);
			return same.length > 1 ? `${n} ${same.indexOf(i) + 1}` : n;
		});
		u.models = kept.map((f, i) => ({
			label: labels[i],
			percentage: f.percentage,
			resets_at_unix: isoToUnix(f.resets),
			...(f.model ? {} : { other: true as const })
		}));
	}
	const extra = extraUsage(r.spend, u);
	if (extra) u.extra = extra;
	return u;
}

/** claude.rs claude_credits: `spend` = { enabled, used: { amount_minor, exponent }, limit: { ... } }. */
function extraUsage(spend: unknown, u: Usage): ExtraUsage | null {
	if (!spend || typeof spend !== 'object') return null;
	const s = spend as { enabled?: unknown; used?: unknown; limit?: unknown };
	const major = (a: unknown): number | null => {
		const x = a as { amount_minor?: unknown; exponent?: unknown } | null;
		if (!x || typeof x.amount_minor !== 'number') return null;
		return x.amount_minor / 10 ** (typeof x.exponent === 'number' ? x.exponent : 0);
	};
	const used = major(s.used);
	const total = major(s.limit);
	if (s.enabled !== true || used === null || total === null || !Number.isFinite(total) || total <= 0) return null;
	// it only matters once a window is spent and the paid amount has started to be used
	const reached = u.session.percentage >= 100 || u.weekly.percentage >= 100;
	if (!reached || used <= 0) return null;
	return { percentage: Math.min(100, Math.max(0, (used / total) * 100)), remaining: Math.max(0, total - used), total };
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

// ---------- Codex (port of src/poller/codex.rs) ----------

interface CodexCreds {
	accessToken: string;
	accountId: string | null;
}

/** codex.rs read_codex_credentials_at: auth.json tokens.access_token (non-blank) + account_id. Never logged. */
export function readCodexCredentials(codexHome: string): CodexCreds | null {
	try {
		const j = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8').trimStart());
		const t = j?.tokens;
		if (typeof t?.access_token !== 'string' || !t.access_token.trim()) return null;
		return { accessToken: t.access_token, accountId: typeof t.account_id === 'string' && t.account_id ? t.account_id : null };
	} catch {
		return null;
	}
}

/**
 * codex.rs codex_usage_from_response_at. Windows are assigned by length, not slot: >= 1 day is
 * weekly; a window without a length keeps the legacy slot mapping (primary = session, secondary =
 * weekly). reset_at < 0 = no usable reset. The credit balance is returned as read; codexExtra turns
 * it into `extra` once the previous reading's balance is known.
 */
export function codexUsageFromResponse(body: unknown, accountId: string | null = null): Usage | null {
	if (!body || typeof body !== 'object') return null;
	const rl = (body as { rate_limit?: unknown }).rate_limit;
	if (!rl || typeof rl !== 'object') return null;
	const u: Usage = { session: emptyWindow(), weekly: emptyWindow() };
	const slots: [unknown, boolean][] = [
		[(rl as Record<string, unknown>).primary_window, false],
		[(rl as Record<string, unknown>).secondary_window, true]
	];
	for (const [w, defaultWeekly] of slots) {
		if (!w || typeof w !== 'object') continue;
		const x = w as { used_percent?: unknown; reset_at?: unknown; limit_window_seconds?: unknown };
		// The widget rejects the whole answer here (both fields are required). Skipping the window instead
		// would save a reading that says the window is not in use, while it may be at its limit.
		if (typeof x.used_percent !== 'number' || typeof x.reset_at !== 'number') return null;
		const section: WindowUsage = { available: true, percentage: x.used_percent, resets_at_unix: x.reset_at >= 0 ? x.reset_at : null };
		const weekly = typeof x.limit_window_seconds === 'number' ? x.limit_window_seconds >= WEEKLY_WINDOW_THRESHOLD_SECONDS : defaultWeekly;
		if (weekly) u.weekly = section;
		else u.session = section;
	}
	const c = (body as { credits?: unknown }).credits;
	if (c && typeof c === 'object') {
		const x = c as { has_credits?: unknown; unlimited?: unknown; overage_limit_reached?: unknown; balance?: unknown };
		// sent as a decimal string; anything else reads as an empty balance, as in the widget
		const n = typeof x.balance === 'string' && x.balance.trim() ? Number(x.balance) : NaN;
		const balance = Number.isFinite(n) && n >= 0 ? n : 0;
		u.credits = {
			account: accountId,
			balance,
			baseline: balance,
			live: x.has_credits === true && x.unlimited !== true && (rl as { limit_reached?: unknown }).limit_reached === true,
			capped: x.overage_limit_reached === true
		};
	}
	return u;
}

/** Codex bills credits at 25 to the dollar (codex.rs CODEX_CREDITS_PER_DOLLAR); only the displayed amounts depend on it. */
const CODEX_CREDITS_PER_DOLLAR = 25;

/**
 * codex.rs codex_credits: measures a Codex balance against the one kept with the previous reading
 * and, once an allowance is spent and credits have started going down, sets `extra`. The balance
 * only falls as credits are spent, so any rise is a top-up and becomes the new baseline. Call it
 * for every Codex reading, shown or not, so a top-up is never missed.
 */
export function codexExtra(u: Usage, previous: CodexCredits | null | undefined): void {
	const c = u.credits;
	if (!c) return;
	const prev = previous && previous.account === c.account && Number.isFinite(previous.balance) && Number.isFinite(previous.baseline) ? previous : null;
	c.baseline = prev && c.balance <= prev.balance ? Math.max(prev.baseline, c.balance) : c.balance;
	delete u.extra;
	if (!c.live || c.baseline <= 0 || c.balance >= c.baseline) return;
	u.extra = {
		percentage: c.capped ? 100 : Math.min(100, Math.max(0, ((c.baseline - c.balance) / c.baseline) * 100)),
		// with the spending limit reached the balance cannot be used: nothing is left to carry the account
		remaining: c.capped ? 0 : c.balance / CODEX_CREDITS_PER_DOLLAR,
		total: c.baseline / CODEX_CREDITS_PER_DOLLAR
	};
}

class CodexAuthRequired {}

async function fetchCodexUsage(creds: CodexCreds, deps: PollDeps): Promise<Usage> {
	const headers: Record<string, string> = { Authorization: `Bearer ${creds.accessToken}`, 'User-Agent': CODEX_USER_AGENT };
	if (creds.accountId) headers['ChatGPT-Account-Id'] = creds.accountId;
	let res: Response;
	try {
		res = await deps.fetch(deps.codexUsageUrl || CODEX_USAGE_URL, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch {
		throw 'network_error' as const;
	}
	if (res.status >= 400) {
		void res.body?.cancel().catch(() => undefined);
		if (res.status === 401 || res.status === 403) throw new CodexAuthRequired();
		// 429 / 5xx: honour Retry-After through the scheduler's backoff; anything else is request_failed.
		if (res.status === 429 || res.status >= 500)
			throw new HttpStatus(res.status, parseRetryAfter(res.headers.get('retry-after'), deps.nowMs()));
		throw 'request_failed' as const;
	}
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		throw 'request_failed' as const;
	}
	const u = codexUsageFromResponse(body, creds.accountId);
	if (!u) throw 'request_failed' as const;
	return u;
}

/** codex.rs poll_account: on 401/403 refresh via the CLI, re-read auth.json, try once more. */
export async function pollCodexAccount(codexHome: string, deps: PollDeps): Promise<PollResult> {
	const wrap = (e: unknown): PollResult => {
		if (e instanceof CodexAuthRequired) return { ok: false, error: 'auth_required' };
		if (e instanceof HttpStatus) return { ok: false, error: { http_status: e.status }, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) };
		if (typeof e === 'string') return { ok: false, error: e as PollErrorJson };
		return { ok: false, error: 'request_failed' };
	};
	const creds = readCodexCredentials(codexHome);
	if (!creds) return { ok: false, error: 'no_credentials' };
	try {
		return { ok: true, usage: await fetchCodexUsage(creds, deps) };
	} catch (e) {
		if (!(e instanceof CodexAuthRequired)) return wrap(e);
	}
	await deps.refreshCodex?.(codexHome);
	const again = readCodexCredentials(codexHome);
	if (!again) return { ok: false, error: 'token_expired' };
	try {
		return { ok: true, usage: await fetchCodexUsage(again, deps) };
	} catch (e) {
		return wrap(e);
	}
}

// ---------- scheduling ----------

export interface PollTarget {
	id: string;
	configDir: string;
	/** Default 'claude'. */
	provider?: 'claude' | 'codex';
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
	private inFlight = new Map<string, Promise<boolean>>();
	private stopped = false;

	constructor(
		private store: PollStore,
		private deps: PollDeps,
		private intervalS = 300,
		private maxStaggerMs = 15_000,
		private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
	) {}

	/**
	 * Poll one account now (after a login, or from a cycle); concurrent calls for one id share the run.
	 * Resolves true when a new reading was saved, false when the poll failed or was skipped.
	 */
	pollOne(t: PollTarget, force = false): Promise<boolean> {
		const existing = this.inFlight.get(t.id);
		if (existing) return existing;
		const now = this.deps.nowMs();
		if (!force && (this.cooldownUntil.get(t.id) ?? 0) > now) return Promise.resolve(false);
		const p = (async () => {
			try {
				const r = t.provider === 'codex' ? await pollCodexAccount(t.configDir, this.deps) : await pollAccount(t.configDir, this.deps);
				const at = this.deps.nowMs();
				this.applyBackoff(t.id, r, at);
				this.store.save(t.id, r, at);
				return r.ok;
			} catch (e) {
				console.error('[account-manager] poll failed:', (e as Error).message);
				return false;
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

	/**
	 * Leave an account alone until `untilMs`: it was read a moment ago by the previous run of the
	 * server, so reading it again at start-up adds nothing. An extra reading is sometimes answered
	 * with 429 (three were, about a minute after their previous reading, on a restart that read
	 * everything at once); that puts "rate limited" on the row and costs the account its next reading.
	 */
	hold(id: string, untilMs: number): void {
		if (untilMs > (this.cooldownUntil.get(id) ?? 0)) this.cooldownUntil.set(id, untilMs);
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

	start(now = true): void {
		if (this.timer || this.stopped) return;
		const tick = () => {
			if (!this.running)
				this.running = this.cycle()
					.catch((e) => console.error('[account-manager] poll cycle failed:', (e as Error).message))
					.finally(() => (this.running = null));
		};
		if (now) tick();
		this.timer = setInterval(tick, this.intervalS * 1000);
		this.timer.unref?.();
	}

	/** Settings changed the interval: the next cycle starts on the new rhythm (no restart needed). */
	setIntervalS(seconds: number): void {
		if (seconds === this.intervalS) return;
		this.intervalS = seconds;
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
		this.start(false);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
