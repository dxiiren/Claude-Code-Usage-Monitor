import type { Handle, RequestEvent, ServerInit } from '@sveltejs/kit';
import { initDb } from '$lib/server/db';
import { sweepStaleLogins } from '$lib/server/claude';
import { checkRequest, checkServerRequest, type GuardResult } from '$lib/server/guard';
import { PORT, PUBLIC_ORIGIN, SERVER } from '$lib/server/paths';
import {
	WEAK_PASSWORD_LENGTH,
	clientIp,
	cookieName,
	loginLimiter,
	rotateSessionsIfPasswordChanged,
	serverConfigProblems,
	sessionSecret,
	validSession
} from '$lib/server/auth';
import { getPoller } from '$lib/server/serverUsage';

export const init: ServerInit = async () => {
	if (SERVER) {
		const problems = serverConfigProblems();
		if (problems.length) {
			for (const p of problems) console.error(`[account-manager] FATAL: ${p}`);
			process.exit(1);
		}
	}
	initDb();
	await sweepStaleLogins();
	if (SERVER) {
		sessionSecret();
		rotateSessionsIfPasswordChanged();
		getPoller().start();
		console.log(`[account-manager] server mode, public origin ${PUBLIC_ORIGIN}`);
		if ((process.env.ACCTMGR_ADMIN_PASSWORD ?? '').length < WEAK_PASSWORD_LENGTH)
			console.warn(
				`[account-manager] WARNING: ACCTMGR_ADMIN_PASSWORD is shorter than ${WEAK_PASSWORD_LENGTH} characters. Sign-in is rate limited, but a longer password is much safer on a public URL.`
			);
		if (process.env.ACCTMGR_TRUST_PROXY === '1')
			console.log('[account-manager] ACCTMGR_TRUST_PROXY=1: sign-in attempts are counted per CF-Connecting-IP.');
	}
};

/** Server mode: reachable without a session. Everything else needs the admin login. */
function isPublic(pathname: string): boolean {
	return (
		pathname === '/login' ||
		pathname === '/api/v1/widget' || // its own Bearer check
		pathname.startsWith('/_app/') ||
		pathname === '/favicon.svg' ||
		pathname === '/robots.txt'
	);
}

function denied(g: Extract<GuardResult, { action: 'deny' }>): Response {
	if (g.reason === 'host') return new Response('Forbidden host', { status: 403 });
	return new Response(JSON.stringify({ error: 'Forbidden: missing or foreign Origin' }), {
		status: 403,
		headers: { 'content-type': 'application/json' }
	});
}

function authGate(event: RequestEvent): Response | null {
	const p = event.url.pathname;
	if (isPublic(p)) return null;
	if (validSession(event.cookies.get(cookieName()))) return null;
	if (p.startsWith('/api/'))
		return new Response(JSON.stringify({ error: 'Not signed in.' }), { status: 401, headers: { 'content-type': 'application/json' } });
	const next = `${p}${event.url.search}`;
	return new Response(null, { status: 303, headers: { location: next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}` } });
}

export const handle: Handle = async ({ event, resolve }) => {
	// Liveness only: no auth, no data, any Host (the container HEALTHCHECK calls 127.0.0.1).
	if (SERVER && event.url.pathname === '/healthz')
		return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

	const host = event.request.headers.get('host');
	const origin = event.request.headers.get('origin');
	const g = SERVER
		? checkServerRequest(event.request.method, host, origin, PUBLIC_ORIGIN)
		: checkRequest(event.request.method, host, origin, PORT, `${event.url.pathname}${event.url.search}`);
	if (g.action === 'redirect') return new Response(null, { status: 308, headers: { location: g.location } });
	if (g.action === 'deny') return denied(g);

	if (SERVER) {
		// Locked-out sign-in from a script: a real 429 + Retry-After (SvelteKit would answer a non-HTML
		// action request with 200 + {type:"failure"}). Browsers fall through to the action, which
		// renders the page with status 429 and the same header.
		if (event.request.method === 'POST' && event.url.pathname === '/login' && !(event.request.headers.get('accept') ?? '').includes('text/html')) {
			const ip = clientIp(event.request.headers, event.getClientAddress);
			const wait = loginLimiter.retryAfter(ip);
			if (wait > 0) {
				console.warn(`[account-manager] sign-in blocked (rate limit) ip=${ip} at=${new Date().toISOString()} retry_after=${wait}s`);
				return new Response(JSON.stringify({ error: 'Too many attempts.' }), {
					status: 429,
					headers: { 'content-type': 'application/json', 'retry-after': String(wait) }
				});
			}
		}
		const blocked = authGate(event);
		if (blocked) return blocked;
	}

	const response = await resolve(event);
	try {
		response.headers.set('x-frame-options', 'DENY');
		// Server mode posts real <form>s (sign in / sign out). Under `no-referrer` browsers send
		// `Origin: null` on those, which the Origin checks must reject; `same-origin` still sends
		// no referrer to any other site.
		response.headers.set('referrer-policy', SERVER ? 'same-origin' : 'no-referrer');
		response.headers.set('cache-control', 'no-store');
		if (SERVER) response.headers.set('x-content-type-options', 'nosniff');
	} catch {
		/* immutable headers */
	}
	return response;
};
