export type Level = 'ok' | 'warn' | 'high' | 'full' | 'none';

/**
 * Default thresholds are the widget's: green < 70, amber 70-89, red >= 90; 100 = blocked.
 * Server mode can move the amber and red levels in Settings.
 */
export function level(pct: number | null | undefined, warnAt = 70, highAt = 90): Level {
	if (pct === null || pct === undefined || Number.isNaN(pct)) return 'none';
	if (pct >= 100) return 'full';
	if (pct >= highAt) return 'high';
	if (pct >= warnAt) return 'warn';
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

/** Whole percent. Only a real 100 reads "100%": 99.6 is not a reached limit and must not look like one. */
export function pctText(pct: number | null | undefined): string {
	if (pct === null || pct === undefined) return '--';
	const whole = Math.round(pct);
	return `${pct < 100 ? Math.min(whole, 99) : whole}%`;
}

/** "4m", "3h 5m", "2d 4h": how long ago a moment (unix seconds) was. */
export function ago(unix: number, nowMs: number): string {
	const s = Math.max(0, Math.floor(nowMs / 1000 - unix));
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${Math.max(1, m)}m`;
}

/** True once a window's reset time has passed: the number read before it is of a window that is over. */
export function windowOver(resetsAt: number | null | undefined, nowMs: number): boolean {
	return !!resetsAt && resetsAt * 1000 <= nowMs;
}

/** A reading above zero whose window has reset since: the number describes a window that is over. */
export function readingOver(pct: number | null | undefined, resetsAt: number | null | undefined, nowMs: number): boolean {
	return pct !== null && pct !== undefined && pct > 0 && windowOver(resetsAt, nowMs);
}

interface Window {
	percentage: number;
	resetsAt: number | null;
}
/** At its limit right now: 100% or more in a window that has not reset yet. */
export function windowFull(w: Window | null | undefined, nowMs: number): boolean {
	return !!w && w.percentage >= 100 && !windowOver(w.resetsAt, nowMs);
}

/** What "Refresh now" did. `ok` = every account asked gave a new reading. */
export function refreshSummary(r: { refreshed: number; failed?: number; pending?: number; skipped: number }): { ok: boolean; text: string } {
	const failed = r.failed ?? 0;
	const pending = r.pending ?? 0;
	const n = (k: number) => `${k} ${k === 1 ? 'account' : 'accounts'}`;
	const parts: string[] = [];
	if (r.refreshed) parts.push(`Refreshed ${n(r.refreshed)}.`);
	if (failed) parts.push(`${n(failed)} could not be read: the reason is on ${failed === 1 ? 'its' : 'their'} row.`);
	if (pending) parts.push(`${n(pending)} still being read: the numbers change when that finishes.`);
	if (r.skipped) parts.push(r.refreshed || failed || pending ? `${r.skipped} skipped: the provider asked us to wait.` : 'Nothing refreshed: the provider asked us to wait before reading again.');
	if (!parts.length) parts.push('Nothing to refresh: no account is switched on.');
	return { ok: r.refreshed > 0 && !failed && !pending, text: parts.join(' ') };
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

/** GET JSON from our own API; throws Error(message) with the server's `error` on a non-2xx. */
export async function getJson<T>(url: string): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url);
	} catch {
		throw new Error('Cannot reach the server. Check your connection and try again.');
	}
	const out = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw Object.assign(new Error(out.error || `Request failed (${res.status})`), { data: out, status: res.status });
	return out;
}
