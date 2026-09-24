import { error } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import { cookieName, destroySession, secureCookies } from '$lib/server/auth';

/** Ends this browser's session (server side too, so a copied cookie stops working). */
export const POST = ({ cookies }) => {
	if (!SERVER) error(404, 'Not found');
	destroySession(cookies.get(cookieName()));
	cookies.delete(cookieName(), { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies() });
	return new Response(null, { status: 303, headers: { location: '/login' } });
};
