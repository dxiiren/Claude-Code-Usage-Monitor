import { json } from '@sveltejs/kit';
import { UserError, getCardTheme, getMeta, listAccounts } from './db';
import { LoginError, activeSessionFor, authStatusOrNull } from './claude';
import { AuthStatusCache, loginStatus } from './status';
import { readUsage } from './usage';
import { findWidgetExe, widgetRunning } from './widget';
import { SERVER } from './paths';
import { readServerUsage } from './serverUsage';

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

/** When each account last completed a login in this server's lifetime (unix seconds). */
const loginAt = new Map<string, number>();

/** Call after a successful login: fresh auth status, and poll errors older than now no longer count. */
export function markLoggedIn(accountId: string, configDir: string): void {
	loginAt.set(accountId, Date.now() / 1000);
	authCache.invalidate(configDir);
}

export async function snapshot() {
	const accounts = listAccounts();
	// Server: the server's own poll results; local: the widget's usage-cache.json.
	const usage = SERVER ? readServerUsage(accounts) : readUsage(accounts);
	const meta = getMeta();
	const auths = await Promise.all(accounts.map((a) => authCache.get(a.config_dir)));
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
				configDir: a.config_dir,
				email: a.email,
				plan: a.plan,
				enabled: !!a.enabled,
				sortOrder: a.sort_order,
				loginPending: !!activeSessionFor(a.id),
				sameEmailAs: a.email
					? accounts
							.filter((o) => o.id !== a.id && o.email && o.email.toLowerCase() === a.email!.toLowerCase())
							.map((o) => o.name)
					: [],
				status: loginStatus({ pollError: stale ? null : u?.pollError, auth: auths[i], everLoggedIn: !!a.email }),
				usage: u ? { session: u.session, weekly: u.weekly } : null
			};
		})
	};
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
