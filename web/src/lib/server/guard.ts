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
