import { fail, redirect } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import { clientIp, cookieName, createSession, loginLimiter, safeNext, secureCookies, sessionTtlS, sessionUser } from '$lib/server/auth';
import { authenticate, homeFor } from '$lib/server/users';

export const load = ({ cookies, url }) => {
	if (!SERVER) redirect(303, '/');
	const user = sessionUser(cookies.get(cookieName()));
	if (user) redirect(303, safeNext(url.searchParams.get('next'), homeFor(user.screens)));
	return {};
};

export const actions = {
	default: async ({ request, cookies, url, getClientAddress, setHeaders }) => {
		if (!SERVER) redirect(303, '/');
		const ip = clientIp(request.headers, getClientAddress);
		const wait = loginLimiter.retryAfter(ip);
		if (wait > 0) {
			// Logged: address + time only. Never the username or password that was typed.
			console.warn(`[account-manager] sign-in blocked (rate limit) ip=${ip} at=${new Date().toISOString()} retry_after=${wait}s`);
			setHeaders({ 'retry-after': String(wait) });
			return fail(429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
		}
		const form = await request.formData();
		const user = await authenticate(form.get('username'), form.get('password'));
		if (!user) {
			loginLimiter.fail(ip);
			console.warn(`[account-manager] failed sign-in ip=${ip} at=${new Date().toISOString()}`);
			return fail(400, { error: 'Wrong username or password.' });
		}
		loginLimiter.succeed(ip);
		cookies.set(cookieName(), createSession(user.id), {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: secureCookies(),
			maxAge: sessionTtlS()
		});
		// A reset password must be replaced before anything else opens.
		redirect(303, user.mustChange ? '/account' : safeNext(url.searchParams.get('next'), homeFor(user.screens)));
	}
};
