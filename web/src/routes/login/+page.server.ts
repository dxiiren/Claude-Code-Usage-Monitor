import { fail, redirect } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import {
	SESSION_TTL_S,
	checkCredentials,
	clientIp,
	cookieName,
	createSession,
	loginLimiter,
	secureCookies,
	validSession
} from '$lib/server/auth';

/** Only same-site paths: never `//evil.example` or an absolute URL. */
function safeNext(raw: string | null): string {
	return raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/';
}

export const load = ({ cookies, url }) => {
	if (!SERVER) redirect(303, '/');
	if (validSession(cookies.get(cookieName()))) redirect(303, safeNext(url.searchParams.get('next')));
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
		if (!checkCredentials(form.get('username'), form.get('password'))) {
			loginLimiter.fail(ip);
			console.warn(`[account-manager] failed sign-in ip=${ip} at=${new Date().toISOString()}`);
			return fail(400, { error: 'Wrong username or password.' });
		}
		loginLimiter.succeed(ip);
		cookies.set(cookieName(), createSession(), {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			secure: secureCookies(),
			maxAge: SESSION_TTL_S
		});
		redirect(303, safeNext(url.searchParams.get('next')));
	}
};
