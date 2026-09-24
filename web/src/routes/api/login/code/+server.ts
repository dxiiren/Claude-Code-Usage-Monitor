import { json } from '@sveltejs/kit';
import { accountsWithEmail, getAccount, setAuth } from '$lib/server/db';
import { authStatus, submitCode } from '$lib/server/claude';
import { body, handle, markLoggedIn } from '$lib/server/api';
import { SERVER } from '$lib/server/paths';
import { clearError, pollAccountSoon } from '$lib/server/serverUsage';

/** Feed the pasted code to the waiting CLI, then read `claude auth status` for email + plan. */
export const POST = ({ request }) =>
	handle(async () => {
		const b = await body(request);
		const r = await submitCode(String(b.sessionId ?? ''), b.code);
		// A rejected code is a normal outcome, not an HTTP error.
		if (!r.ok) return json({ ok: false, error: r.message });
		const auth = await authStatus(r.configDir); // always fresh here, never the cache
		if (!auth.loggedIn || !auth.email) {
			return json(
				{ ok: false, error: 'Claude Code reported success, but `claude auth status` says this folder is not logged in. Try Re-login.' },
				{ status: 200 }
			);
		}
		if (getAccount(r.accountId)) setAuth(r.accountId, auth.email, auth.plan);
		markLoggedIn(r.accountId, r.configDir);
		if (SERVER) {
			// Fresh login: the old poll error no longer applies; fetch usage now instead of at the next cycle.
			clearError(r.accountId);
			const a = getAccount(r.accountId);
			// Usually well under a second; never hold the login response longer than 5 s for it.
			if (a) await Promise.race([pollAccountSoon(a), new Promise((r) => setTimeout(r, 5000))]);
		}
		const same = accountsWithEmail(auth.email, r.accountId).map((a) => a.name);
		return json({ ok: true, email: auth.email, plan: auth.plan, sameEmailAs: same });
	});
