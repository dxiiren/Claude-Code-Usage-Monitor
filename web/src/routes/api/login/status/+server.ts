import { json } from '@sveltejs/kit';
import { accountsWithEmail } from '$lib/server/db';
import { handle } from '$lib/server/api';
import { codexSessionStatus } from '$lib/server/codex';

/**
 * Codex login progress. The CLI completes the sign-in on its own localhost:1455 callback (local: the
 * isolated Edge window reaches it), so the page polls this instead of submitting a code.
 */
export const GET = ({ url }) =>
	handle(() => {
		const s = codexSessionStatus(url.searchParams.get('sessionId') ?? '');
		if (!s) return json({ state: 'gone', error: 'This login session no longer exists. Click Re-login to start again.' }, { status: 410 });
		const sameEmailAs = s.state === 'done' && s.email ? accountsWithEmail(s.email, s.accountId).map((a) => a.name) : [];
		return json({ state: s.state, error: s.error, email: s.email ?? (s.state === 'done' ? 'ChatGPT account' : null), plan: s.plan, sameEmailAs });
	});
