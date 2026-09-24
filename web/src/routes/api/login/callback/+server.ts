import { json } from '@sveltejs/kit';
import { accountsWithEmail } from '$lib/server/db';
import { body, handle } from '$lib/server/api';
import { submitCodexCallback } from '$lib/server/codex';

/**
 * Codex: the user pastes the `http://localhost:1455/auth/callback?...` address their browser landed
 * on; it is validated strictly and replayed to the CLI's own 127.0.0.1:1455 callback server.
 */
export const POST = ({ request }) =>
	handle(async () => {
		const b = await body(request);
		const r = await submitCodexCallback(String(b.sessionId ?? ''), b.url);
		if (!r.ok) return json({ ok: false, error: r.message });
		const same = r.email ? accountsWithEmail(r.email, r.accountId).map((a) => a.name) : [];
		return json({ ok: true, email: r.email ?? 'ChatGPT account', plan: r.plan, sameEmailAs: same });
	});
