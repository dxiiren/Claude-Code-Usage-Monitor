import { json } from '@sveltejs/kit';
import { CODEX_NO_EMAIL, UserError, getAccount, getCardTheme, getMeta, listAccounts, setAuth } from './db';
import { LoginError, activeSessionFor, authStatusOrNull, cancelLogin, startLogin } from './claude';
import { activeCodexSessionFor, cancelCodexLogin, codexAuthStatusOrNull, isCodexSession, onCodexLogin, startCodexLogin } from './codex';
import { AuthStatusCache, loginStatus } from './status';
import { readUsage } from './usage';
import { findWidgetExe, widgetRunning } from './widget';
import { SERVER } from './paths';
import { clearError, pollAccountSoon, readServerUsage } from './serverUsage';
import type { Provider } from './paths';

export async function body(request: Request): Promise<Record<string, unknown>> {
	try {
		const v = await request.json();
		return v && typeof v === 'object' ? v : {};
	} catch {
		return {};
	}
}

/** Maps expected errors to clean messages; never echoes internals beyond the message. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof UserError || e instanceof LoginError) return json({ error: e.message }, { status: e.status });
		console.error('[account-manager]', e);
		return json({ error: (e as Error).message || 'Unexpected error' }, { status: 500 });
	}
}

/** `claude auth status` per folder, at most once a minute per folder (page polls every 15 s). */
export const authCache = new AuthStatusCache(authStatusOrNull, 60_000);
/** `codex login status` (+ id_token email) per CODEX_HOME, same caching. */
export const codexAuthCache = new AuthStatusCache(codexAuthStatusOrNull, 60_000);

/** The right CLI's cached status for an account folder. */
export function authFor(configDir: string, provider: Provider = 'claude') {
	return (provider === 'codex' ? codexAuthCache : authCache).get(configDir);
}

/** Starts the right CLI's login for an account row. The result carries `provider`. */
export async function startLoginFor(a: { id: string; config_dir: string; provider: Provider }) {
	if (a.provider === 'codex') return startCodexLogin(a.id, a.config_dir);
	return { ...(await startLogin(a.id, a.config_dir)), provider: 'claude' as const };
}

/** Cancels a login session, whichever CLI runs it. */
export function cancelAnyLogin(sessionId: string): Promise<boolean> {
	return isCodexSession(sessionId) ? cancelCodexLogin(sessionId) : cancelLogin(sessionId);
}

/** Any waiting login for this account, whichever CLI runs it. */
export function pendingLoginFor(accountId: string): string | null {
	return activeSessionFor(accountId) ?? activeCodexSessionFor(accountId);
}

/** When each account last completed a login in this server's lifetime (unix seconds). */
const loginAt = new Map<string, number>();

/** Call after a successful login: fresh auth status, and poll errors older than now no longer count. */
export function markLoggedIn(accountId: string, configDir: string): void {
	loginAt.set(accountId, Date.now() / 1000);
	authCache.invalidate(configDir);
	codexAuthCache.invalidate(configDir);
}

// A Codex login completes inside the CLI (its localhost:1455 callback), not in a request of ours:
// the codex driver calls this when it does. Same steps as /api/login/code does for Claude.
onCodexLogin(async ({ accountId, configDir, email, plan }) => {
	if (getAccount(accountId)) setAuth(accountId, email ?? CODEX_NO_EMAIL, plan);
	markLoggedIn(accountId, configDir);
	if (SERVER) {
		clearError(accountId);
		const a = getAccount(accountId);
		if (a) await Promise.race([pollAccountSoon(a), new Promise((r) => setTimeout(r, 5000))]);
	}
});

export async function snapshot() {
	const accounts = listAccounts();
	// Server: the server's own poll results; local: the widget's usage-cache.json.
	const usage = SERVER ? readServerUsage(accounts) : readUsage(accounts);
	const meta = getMeta();
	const auths = await Promise.all(accounts.map((a) => authFor(a.config_dir, a.provider)));
	return {
		mode: SERVER ? ('server' as const) : ('local' as const),
		revision: Number(meta.revision ?? 0),
		cardTheme: getCardTheme(),
		usageUpdatedUnix: usage.updatedUnix,
		widget: SERVER ? { installed: false, running: false } : { installed: !!findWidgetExe(), running: widgetRunning() },
		accounts: accounts.map((a, i) => {
			const u = usage.byId[a.id];
			// A poll error from before the latest login is stale: the widget has not re-polled yet.
			// (Server mode clears the stored error on login instead.)
			const stale = !SERVER && (loginAt.get(a.id) ?? 0) > (usage.updatedUnix ?? 0);
			return {
				id: a.id,
				name: a.name,
				provider: a.provider,
				configDir: a.config_dir,
				email: a.email,
				plan: a.plan,
				enabled: !!a.enabled,
				sortOrder: a.sort_order,
				loginPending: !!pendingLoginFor(a.id),
				sameEmailAs: a.email && a.email !== CODEX_NO_EMAIL
					? accounts
							.filter((o) => o.id !== a.id && o.provider === a.provider && o.email && o.email.toLowerCase() === a.email!.toLowerCase())
							.map((o) => o.name)
					: [],
				status: loginStatus({ pollError: stale ? null : u?.pollError, auth: auths[i], everLoggedIn: !!a.email, provider: a.provider }),
				usage: u ? { session: u.session, weekly: u.weekly } : null
			};
		})
	};
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
