import { json } from '@sveltejs/kit';
import { body, cancelAnyLogin, handle } from '$lib/server/api';

/** Kill the waiting CLI + its Edge window, delete the temp profile (Claude or Codex session). */
export const POST = ({ request }) =>
	handle(async () => {
		const b = await body(request);
		const found = await cancelAnyLogin(String(b.sessionId ?? ''));
		return json({ ok: true, found });
	});
