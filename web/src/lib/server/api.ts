import { json } from '@sveltejs/kit';
import { UserError, getCardTheme, getMeta, listAccounts } from './db';
import { LoginError, activeSessionFor } from './claude';
import { readUsage } from './usage';
import { findWidgetExe, widgetRunning } from './widget';

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

export function snapshot() {
	const accounts = listAccounts();
	const usage = readUsage(accounts);
	const meta = getMeta();
	return {
		revision: Number(meta.revision ?? 0),
		cardTheme: getCardTheme(),
		usageUpdatedUnix: usage.updatedUnix,
		widget: { installed: !!findWidgetExe(), running: widgetRunning() },
		accounts: accounts.map((a) => ({
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
			usage: usage.byId[a.id]
		}))
	};
}

export type Snapshot = ReturnType<typeof snapshot>;
