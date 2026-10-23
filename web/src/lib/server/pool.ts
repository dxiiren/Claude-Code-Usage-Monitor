import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { error, json } from '@sveltejs/kit';
import { SERVER } from './paths';

/**
 * Read-only view of the local LLM pool ledger (%LOCALAPPDATA%\llm-pool\ledger.jsonl, override
 * LLM_POOL_HOME). One JSON object per line. The ledger holds no prompts and none are ever added here.
 * Missing file, blank lines, malformed lines and missing fields are all tolerated.
 */

export type Totals = {
	tasks: number;
	tokensIn: number;
	tokensOut: number;
	tokensThinking: number;
	gateRuns: number;
	gatePass: number;
	/** null when no task in the window had a gate result. */
	gatePassPct: number | null;
	wallSeconds: number;
	costUsd: number;
};

export type Window = { total: Totals; byProvider: Record<string, Totals>; byCategory: Record<string, Totals> };

export type RecentTask = {
	ts: string | null;
	taskId: string | null;
	mode: string | null;
	provider: string | null;
	model: string | null;
	category: string | null;
	gate: string | null;
	tokensIn: number;
	tokensOut: number;
	wallSeconds: number;
	exit: number | null;
	error: string | null;
};

export type PoolSnapshot = {
	/** false when there is no ledger file yet. */
	hasLedger: boolean;
	/** The kill-switch flag file exists. */
	off: boolean;
	generatedAt: string;
	today: Window;
	last7d: Window;
	recent: RecentTask[];
};

export function poolHome(): string {
	const o = (process.env.LLM_POOL_HOME ?? '').trim();
	if (o) return o;
	const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
	return path.join(base, 'llm-pool');
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export const emptyTotals = (): Totals => ({
	tasks: 0, tokensIn: 0, tokensOut: 0, tokensThinking: 0, gateRuns: 0, gatePass: 0, gatePassPct: null, wallSeconds: 0, costUsd: 0
});
const emptyWindow = (): Window => ({ total: emptyTotals(), byProvider: {}, byCategory: {} });

function add(t: Totals, e: Record<string, unknown>) {
	t.tasks += 1;
	t.tokensIn += num(e.tokens_in);
	t.tokensOut += num(e.tokens_out);
	t.tokensThinking += num(e.tokens_thinking);
	t.wallSeconds += num(e.wall_s);
	t.costUsd += num(e.cost_usd);
	if (e.gate === 'pass' || e.gate === 'fail') {
		t.gateRuns += 1;
		if (e.gate === 'pass') t.gatePass += 1;
	}
}

function addTo(w: Window, e: Record<string, unknown>) {
	const p = str(e.provider) ?? 'unknown';
	const c = str(e.category) ?? 'uncategorised';
	add(w.total, e);
	add((w.byProvider[p] ??= emptyTotals()), e);
	add((w.byCategory[c] ??= emptyTotals()), e);
}

function finish(w: Window) {
	for (const t of [w.total, ...Object.values(w.byProvider), ...Object.values(w.byCategory)]) {
		t.gatePassPct = t.gateRuns ? Math.round((t.gatePass / t.gateRuns) * 1000) / 10 : null;
		t.wallSeconds = Math.round(t.wallSeconds * 10) / 10;
		t.costUsd = Math.round(t.costUsd * 1e6) / 1e6;
	}
}

/** Pure aggregation over ledger text; `now` is injectable for tests. */
export function aggregateLedger(text: string, now: Date = new Date()): Omit<PoolSnapshot, 'hasLedger' | 'off'> {
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const weekAgo = now.getTime() - 7 * 24 * 3600 * 1000;
	const today = emptyWindow();
	const last7d = emptyWindow();
	const rows: { at: number; e: Record<string, unknown> }[] = [];
	for (const line of text.split(/\r?\n/)) {
		const s = line.trim();
		if (!s) continue;
		let e: unknown;
		try {
			e = JSON.parse(s);
		} catch {
			continue;
		}
		if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
		const o = e as Record<string, unknown>;
		const at = typeof o.ts === 'string' ? Date.parse(o.ts) : NaN;
		if (Number.isNaN(at)) continue;
		rows.push({ at, e: o });
		if (at >= weekAgo && at <= now.getTime() + 60_000) addTo(last7d, o);
		if (at >= startOfToday && at <= now.getTime() + 60_000) addTo(today, o);
	}
	finish(today);
	finish(last7d);
	rows.sort((a, b) => b.at - a.at);
	const recent: RecentTask[] = rows.slice(0, 10).map(({ e }) => ({
		ts: str(e.ts),
		taskId: str(e.task_id),
		mode: str(e.mode),
		provider: str(e.provider),
		model: str(e.model),
		category: str(e.category),
		gate: str(e.gate),
		tokensIn: num(e.tokens_in),
		tokensOut: num(e.tokens_out),
		wallSeconds: num(e.wall_s),
		exit: typeof e.exit === 'number' ? e.exit : null,
		error: str(e.error)
	}));
	return { generatedAt: now.toISOString(), today, last7d, recent };
}

export function readPool(now: Date = new Date()): PoolSnapshot {
	const home = poolHome();
	const off = fs.existsSync(path.join(home, 'OFF'));
	let text = '';
	let hasLedger = false;
	try {
		text = fs.readFileSync(path.join(home, 'ledger.jsonl'), 'utf8');
		hasLedger = true;
	} catch {
		/* no ledger yet */
	}
	return { hasLedger, off, ...aggregateLedger(text, now) };
}

/** The GET /api/pool response (kept here so a unit test can call it without the $lib alias). */
export const poolResponse = (server: boolean = SERVER): Response => {
	// The ledger is a file on the laptop: server mode must never expose it (and never reads it).
	if (server) error(404, 'Not found');
	return json(readPool(), { headers: { 'cache-control': 'no-store' } });
};
