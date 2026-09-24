// Request guard: 127.0.0.1 only (Host check vs DNS rebinding) + exact Origin on every mutating request.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export type GuardResult =
	| { action: 'allow' }
	| { action: 'redirect'; location: string }
	| { action: 'deny'; reason: 'host' | 'origin' };

export function checkRequest(
	method: string,
	host: string | null,
	origin: string | null,
	port: number,
	pathAndQuery = '/'
): GuardResult {
	const canonicalHost = `127.0.0.1:${port}`;
	const canonicalOrigin = `http://${canonicalHost}`;
	const h = (host ?? '').toLowerCase();
	const safe = SAFE.has(method.toUpperCase());
	if (h === `localhost:${port}` && safe) return { action: 'redirect', location: `${canonicalOrigin}${pathAndQuery}` };
	if (h !== canonicalHost) return { action: 'deny', reason: 'host' };
	if (!safe && origin !== canonicalOrigin) return { action: 'deny', reason: 'origin' };
	return { action: 'allow' };
}

/**
 * Server mode: the page is reachable from outside, so every page/API also needs a session
 * (see auth.ts). This guard keeps the Host (DNS rebinding) and Origin (CSRF) checks, against
 * ACCTMGR_PUBLIC_ORIGIN instead of 127.0.0.1:47291. No localhost redirect.
 */
export function checkServerRequest(method: string, host: string | null, origin: string | null, publicOrigin: string): GuardResult {
	const want = new URL(publicOrigin);
	const h = (host ?? '').toLowerCase();
	const hosts = new Set([want.host.toLowerCase()]);
	// A default port may or may not be spelled out in Host.
	if (!want.port) hosts.add(`${want.hostname.toLowerCase()}:${want.protocol === 'https:' ? 443 : 80}`);
	if (!hosts.has(h)) return { action: 'deny', reason: 'host' };
	if (!SAFE.has(method.toUpperCase()) && origin !== want.origin) return { action: 'deny', reason: 'origin' };
	return { action: 'allow' };
}
