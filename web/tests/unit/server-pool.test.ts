import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregateLedger, poolHome, poolResponse, readPool } from '../../src/lib/server/pool';

const NOW = new Date('2026-10-23T12:00:00');
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const FIXTURE = [
	line({ ts: '2026-10-23T09:00:00', task_id: 't1', mode: 'run', provider: 'codex', model: 'gpt', category: 'code', tokens_in: 1000, tokens_out: 200, tokens_thinking: 50, wall_s: 30, gate: 'pass', cost_usd: 0.5, exit: 0 }),
	line({ ts: '2026-10-23T10:00:00', task_id: 't2', mode: 'ask', provider: 'ollama', category: 'code', tokens_in: 10, tokens_out: 20, wall_s: 5.5, gate: 'fail', exit: 1, error: 'boom' }),
	line({ ts: '2026-10-20T10:00:00', task_id: 't3', provider: 'codex', category: 'docs', tokens_in: 100, gate: null }),
	line({ ts: '2026-09-01T10:00:00', task_id: 'old', provider: 'codex', category: 'docs', tokens_in: 999999 }),
	'',
	'   ',
	'{not json',
	'[1,2]',
	'null',
	line({ task_id: 'no-ts', tokens_in: 5 }),
	line({ ts: 'garbage', tokens_in: 5 }),
	line({ ts: '2026-10-23T11:00:00', task_id: 't4', provider: 'codex', tokens_in: 'x', wall_s: null })
].join('\n');

describe('aggregateLedger', () => {
	const r = aggregateLedger(FIXTURE, NOW);
	it('skips blank, malformed, non-object and timestamp-less lines', () => {
		expect(r.last7d.total.tasks).toBe(4); // t1 t2 t3 t4
		expect(r.today.total.tasks).toBe(3); // t1 t2 t4
	});
	it('sums tokens, time, cost and gate pass % for today', () => {
		expect(r.today.total).toMatchObject({ tokensIn: 1010, tokensOut: 220, tokensThinking: 50, wallSeconds: 35.5, costUsd: 0.5, gateRuns: 2, gatePass: 1, gatePassPct: 50 });
	});
	it('groups per provider and per category; null gate % when no gate ran', () => {
		expect(r.last7d.byProvider.codex.tasks).toBe(3);
		expect(r.last7d.byProvider.ollama.tasks).toBe(1);
		expect(r.last7d.byCategory.code.tasks).toBe(2);
		expect(r.last7d.byCategory.docs.gatePassPct).toBeNull();
		expect(r.last7d.byCategory.uncategorised.tasks).toBe(1);
	});
	it('keeps the 7 day window and lists recent tasks newest first', () => {
		expect(r.last7d.total.tokensIn).toBe(1110);
		expect(r.recent.map((x) => x.taskId)).toEqual(['t4', 't2', 't1', 't3', 'old']);
	});
	it('caps recent at 10 and never carries prompt text', () => {
		const many = Array.from({ length: 25 }, (_, i) => line({ ts: `2026-10-23T0${i % 10}:00:00`, task_id: `m${i}`, prompt: 'SECRET' })).join('\n');
		const m = aggregateLedger(many, NOW);
		expect(m.recent).toHaveLength(10);
		expect(JSON.stringify(m)).not.toContain('SECRET');
	});
	it('empty text gives zero totals', () => {
		const e = aggregateLedger('', NOW);
		expect(e.today.total.tasks).toBe(0);
		expect(e.recent).toEqual([]);
	});
});

describe('readPool and GET /api/pool', () => {
	let dir: string;
	const saved = process.env.LLM_POOL_HOME;
	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-test-'));
		process.env.LLM_POOL_HOME = dir;
	});
	afterAll(() => {
		if (saved === undefined) delete process.env.LLM_POOL_HOME;
		else process.env.LLM_POOL_HOME = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('LLM_POOL_HOME overrides the folder', () => expect(poolHome()).toBe(dir));
	it('missing ledger: hasLedger false, not off', () => {
		const s = readPool(NOW);
		expect(s).toMatchObject({ hasLedger: false, off: false });
		expect(s.recent).toEqual([]);
	});
	it('reads the ledger and the OFF flag', () => {
		fs.writeFileSync(path.join(dir, 'ledger.jsonl'), FIXTURE);
		fs.writeFileSync(path.join(dir, 'OFF'), '');
		const s = readPool(NOW);
		expect(s.hasLedger).toBe(true);
		expect(s.off).toBe(true);
		expect(s.today.total.tasks).toBe(3);
	});
	it('the route handler returns JSON', async () => {
		const res = poolResponse(false);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.hasLedger).toBe(true);
		expect(body.off).toBe(true);
		expect(Array.isArray(body.recent)).toBe(true);
	});
	it('server mode answers 404 and never reads the ledger', () => {
		let thrown: { status?: number } | undefined;
		try {
			poolResponse(true);
		} catch (e) {
			thrown = e as { status?: number };
		}
		expect(thrown?.status).toBe(404);
	});
});
