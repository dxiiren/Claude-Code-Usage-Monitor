// GET /api/v1/widget -- exactly the JSON in docs/account-manager-contract.md ("what remote widgets read").
import { getCardTheme, getMeta, listAccounts } from './db';
import { verifyBearer } from './auth';
import { loginStatus, type AuthSnapshot } from './status';
import { readRows, storedUsage } from './serverUsage';
import type { WindowUsage } from './poller';

export interface WidgetAccount {
	id: string;
	name: string;
	email: string | null;
	plan: string | null;
	status: 'ok' | 'expired' | 'logged_out' | 'error';
	status_message: string;
	usage: { session: WindowUsage; weekly: WindowUsage } | null;
}

export interface WidgetPayload {
	schema: 1;
	revision: number;
	updated_unix: number;
	manager_url: string;
	card_theme: string;
	accounts: WidgetAccount[];
}

const win = (w: Partial<WindowUsage> | undefined): WindowUsage => ({
	available: !!w?.available,
	percentage: typeof w?.percentage === 'number' ? w.percentage : 0,
	resets_at_unix: typeof w?.resets_at_unix === 'number' ? w.resets_at_unix : null
});

/** Enabled accounts only, in sort_order. `auth` = the cached `claude auth status` per config dir. */
export async function widgetPayload(auth: (configDir: string) => Promise<AuthSnapshot | null>): Promise<WidgetPayload> {
	const meta = getMeta();
	const rows = readRows();
	const accounts = listAccounts().filter((a) => a.enabled);
	const auths = await Promise.all(accounts.map((a) => auth(a.config_dir)));
	let updated = 0;
	const out = accounts.map((a, i): WidgetAccount => {
		const r = rows.get(a.id);
		if (r?.polled_unix && r.polled_unix > updated) updated = r.polled_unix;
		let pollError: unknown = null;
		try {
			pollError = r?.error_json ? JSON.parse(r.error_json) : null;
		} catch {
			pollError = 'request_failed';
		}
		const st = loginStatus({ pollError, auth: auths[i], everLoggedIn: !!a.email });
		const u = storedUsage(r);
		return {
			id: a.id,
			name: a.name,
			email: a.email,
			plan: a.plan,
			status: st.state,
			status_message: st.message,
			usage: u ? { session: win(u.session), weekly: win(u.weekly) } : null
		};
	});
	return {
		schema: 1,
		revision: Number(meta.revision ?? 0),
		updated_unix: updated,
		manager_url: meta.manager_url ?? '',
		card_theme: getCardTheme(),
		accounts: out
	};
}

/** Bearer check + payload. 401 for a missing, unknown or revoked token. */
export async function handleWidgetRequest(
	authorization: string | null,
	auth: (configDir: string) => Promise<AuthSnapshot | null>
): Promise<{ status: number; body: unknown }> {
	if (!verifyBearer(authorization)) return { status: 401, body: { error: 'Missing or invalid API token.' } };
	return { status: 200, body: await widgetPayload(auth) };
}
