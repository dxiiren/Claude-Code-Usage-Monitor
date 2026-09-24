import { error, json } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import { revokeToken } from '$lib/server/auth';

/** Revoke = delete the row; the widget using it gets 401 from its next request on. */
export const DELETE = ({ params }) => {
	if (!SERVER) error(404, 'Not found');
	if (!revokeToken(params.id)) return json({ error: 'That token no longer exists.' }, { status: 404 });
	return json({ ok: true });
};
