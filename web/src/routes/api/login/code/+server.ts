import { json } from '@sveltejs/kit';
import { accountsWithEmail, getAccount, setAuth } from '$lib/server/db';
import { authStatus, submitCode } from '$lib/server/claude';
import { body, handle } from '$lib/server/api';

/** Feed the pasted code to the waiting CLI, then read `claude auth status` for email + plan. */
export const POST = ({ request }) =>
	handle(async () => {
		const b = await body(request);
		const r = await submitCode(String(b.sessionId ?? ''), b.code);
		// A rejected code is a normal outcome, not an HTTP error.
		if (!r.ok) return json({ ok: false, error: r.message });
		const auth = await authStatus(r.configDir);
		if (!auth.loggedIn || !auth.email) {
			return json(
				{ ok: false, error: 'Claude Code reported success, but `claude auth status` says this folder is not logged in. Try Re-login.' },
				{ status: 200 }
			);
		}
		if (getAccount(r.accountId)) setAuth(r.accountId, auth.email, auth.plan);
		const same = accountsWithEmail(auth.email, r.accountId).map((a) => a.name);
		return json({ ok: true, email: auth.email, plan: auth.plan, sameEmailAs: same });
	});
