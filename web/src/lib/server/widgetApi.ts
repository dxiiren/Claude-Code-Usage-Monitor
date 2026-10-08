// GET /api/v1/widget -- exactly the JSON in docs/account-manager-contract.md ("what remote widgets read").
import { getCardTheme, getMeta, listAccounts } from './db';
import { verifyBearer } from './auth';
import { loginStatus, type AuthSnapshot } from './status';
import { readRows, staleAfterSeconds, storedUsage } from './serverUsage';
import type { WindowUsage } from './poller';

export interface WidgetAccount {
	id: string;
	name: string;
	/** Contract "Codex accounts": missing = claude (older servers). */
	provider: 'claude' | 'codex';
	email: string | null;
	plan: string | null;
	status: 'ok' | 'expired' | 'logged_out' | 'error';
	status_message: string;
	usage: {
		session: WindowUsage;
		weekly: WindowUsage;
		/** Paid extra usage in force past a spent window; left out when there is none. */
		credits?: { percentage: number; remaining: number; total: number };
		/** Limits next to the two windows (one model's own when `model`, else another allowance); left out when there are none. */
		limits?: { label: string; percentage: number; resets_at_unix: number | null; model: boolean }[];
	} | null;
}

export interface WidgetPayload {
	/** 2 = accounts carry `provider`; the widget then treats zero codex accounts as authoritative. */
	schema: 2;
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

/** Status lookup per account folder: the cached `claude auth status` / `codex login status`. */
export type AuthLookup = (configDir: string, provider: 'claude' | 'codex') => Promise<AuthSnapshot | null>;

/** Enabled accounts only, in sort_order. */
export async function widgetPayload(auth: AuthLookup, nowMs = Date.now()): Promise<WidgetPayload> {
	const meta = getMeta();
	const rows = readRows();
	const staleBefore = nowMs / 1000 - staleAfterSeconds();
	const accounts = listAccounts().filter((a) => a.enabled);
	const auths = await Promise.all(accounts.map((a) => auth(a.config_dir, a.provider)));
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
		let st = loginStatus({ pollError, auth: auths[i], everLoggedIn: !!a.email, provider: a.provider });
		const u = storedUsage(r);
		// No poll has failed, yet the numbers are old (the reader stopped): "error" makes the widget
		// mark the reading stale instead of showing it as current.
		if (st.state === 'ok' && u && r?.ok_unix && r.ok_unix < staleBefore)
			st = { state: 'error', message: 'No new reading for a while: the numbers shown are the last ones read.' };
		return {
			id: a.id,
			name: a.name,
			provider: a.provider === 'codex' ? 'codex' : 'claude',
			email: a.email,
			plan: a.plan,
			status: st.state,
			status_message: st.message,
			usage: u
				? {
						session: win(u.session),
						weekly: win(u.weekly),
						...(u.extra ? { credits: { percentage: u.extra.percentage, remaining: u.extra.remaining, total: u.extra.total } } : {}),
						...(u.models?.length
							? { limits: u.models.map((m) => ({ label: m.label, percentage: m.percentage, resets_at_unix: m.resets_at_unix ?? null, model: !m.other })) }
							: {})
					}
				: null
		};
	});
	return {
		schema: 2,
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
	auth: AuthLookup,
	nowMs = Date.now()
): Promise<{ status: number; body: unknown }> {
	if (!verifyBearer(authorization)) return { status: 401, body: { error: 'Missing or invalid API token.' } };
	return { status: 200, body: await widgetPayload(auth, nowMs) };
}
