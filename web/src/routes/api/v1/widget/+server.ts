import { error, json } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import { authCache } from '$lib/server/api';
import { handleWidgetRequest } from '$lib/server/widgetApi';

/** What remote widgets read (contract JSON). Bearer token only; no session, no cookie. */
export const GET = async ({ request }) => {
	if (!SERVER) error(404, 'Not found');
	const r = await handleWidgetRequest(request.headers.get('authorization'), (dir) => authCache.get(dir));
	return json(r.body, { status: r.status, headers: r.status === 401 ? { 'www-authenticate': 'Bearer' } : {} });
};
