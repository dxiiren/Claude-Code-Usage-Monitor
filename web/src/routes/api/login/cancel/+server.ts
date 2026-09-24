import { json } from '@sveltejs/kit';
import { cancelLogin } from '$lib/server/claude';
import { body, handle } from '$lib/server/api';

/** Kill the waiting CLI + its Edge window, delete the temp profile. */
export const POST = ({ request }) =>
	handle(async () => {
		const b = await body(request);
		const found = await cancelLogin(String(b.sessionId ?? ''));
		return json({ ok: true, found });
	});
