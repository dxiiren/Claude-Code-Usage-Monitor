export type Level = 'ok' | 'warn' | 'high' | 'full' | 'none';

/** Same thresholds as the widget: green < 70, amber 70-89, red >= 90; 100 = blocked. */
export function level(pct: number | null | undefined): Level {
	if (pct === null || pct === undefined || Number.isNaN(pct)) return 'none';
	if (pct >= 100) return 'full';
	if (pct >= 90) return 'high';
	if (pct >= 70) return 'warn';
	return 'ok';
}

/** Port of kit Format-Reset, with seconds under an hour so a ticking countdown moves. */
export function resetsIn(unix: number | null | undefined, nowMs: number, withSeconds = false): string {
	if (!unix) return '-';
	const s = Math.floor(unix - nowMs / 1000);
	if (s <= 0) return 'now';
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (withSeconds) return `${m}m ${String(sec).padStart(2, '0')}s`;
	return `${m}m`;
}

export function pctText(pct: number | null | undefined): string {
	return pct === null || pct === undefined ? '--' : `${Math.round(pct)}%`;
}

/** POST JSON to our own API; throws Error(message) on a non-2xx with the server's `error`. */
export async function post<T = Record<string, unknown>>(url: string, data: unknown = {}): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
	} catch {
		throw new Error('Cannot reach the Account Manager server. Is it still running?');
	}
	const out = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw Object.assign(new Error(out.error || `Request failed (${res.status})`), { data: out, status: res.status });
	return out;
}

/** Login states that need the user to sign in again (mirrors needsLogin in server/status.ts). */
export function needsLogin(state: string): boolean {
	return state === 'expired' || state === 'logged_out';
}
