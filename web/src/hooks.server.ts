import type { Handle, ServerInit } from '@sveltejs/kit';
import { initDb } from '$lib/server/db';
import { sweepStaleLogins } from '$lib/server/claude';
import { checkRequest } from '$lib/server/guard';
import { PORT } from '$lib/server/paths';

export const init: ServerInit = async () => {
	initDb();
	await sweepStaleLogins();
};

export const handle: Handle = async ({ event, resolve }) => {
	const g = checkRequest(
		event.request.method,
		event.request.headers.get('host'),
		event.request.headers.get('origin'),
		PORT,
		`${event.url.pathname}${event.url.search}`
	);
	if (g.action === 'redirect') return new Response(null, { status: 308, headers: { location: g.location } });
	if (g.action === 'deny') {
		if (g.reason === 'host') return new Response('Forbidden host', { status: 403 });
		return new Response(JSON.stringify({ error: 'Forbidden: missing or foreign Origin' }), {
			status: 403,
			headers: { 'content-type': 'application/json' }
		});
	}
	const response = await resolve(event);
	try {
		response.headers.set('x-frame-options', 'DENY');
		response.headers.set('referrer-policy', 'no-referrer');
		response.headers.set('cache-control', 'no-store');
	} catch {
		/* immutable headers */
	}
	return response;
};
