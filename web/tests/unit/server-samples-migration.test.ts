import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { isolateServer } from './helpers';

const env = isolateServer();
const dbFile = path.join(env.data, 'accounts.db');
let db: typeof import('../../src/lib/server/db');
let usage: typeof import('../../src/lib/server/serverUsage');

// A reading history from before paid extra usage and per-model limits were kept: the table has neither column.
beforeAll(async () => {
	const d = new DatabaseSync(dbFile);
	d.exec(`
CREATE TABLE usage_samples (
  account_id    TEXT NOT NULL,
  ts_unix       INTEGER NOT NULL,
  s_pct         REAL,
  s_reset_unix  INTEGER,
  w_pct         REAL,
  w_reset_unix  INTEGER,
  PRIMARY KEY (account_id, ts_unix)
) WITHOUT ROWID;
CREATE INDEX usage_samples_ts ON usage_samples (ts_unix);
INSERT INTO usage_samples VALUES ('old', 1000, 100, 9000, 40, 90000);`);
	d.close();
	db = await import('../../src/lib/server/db');
	usage = await import('../../src/lib/server/serverUsage');
	db.initDb();
});

const columns = () => {
	const d = new DatabaseSync(dbFile, { readOnly: true });
	try {
		return (d.prepare('PRAGMA table_info(usage_samples)').all() as { name: string }[]).map((c) => c.name);
	} finally {
		d.close();
	}
};

describe('reading history from before paid extra usage and per-model limits were kept', () => {
	it('gets the new columns; the old readings stay, with nothing known about either', () => {
		expect(columns()).toEqual(['account_id', 'ts_unix', 's_pct', 's_reset_unix', 'w_pct', 'w_reset_unix', 'extra_left', 'models_json']);
		expect(usage.samplesBetween(0, 2000).get('old')).toEqual([{ ts: 1000, pct: 100, reset: 9000, weekPct: 40, weekReset: 90000, extraLeft: null, models: null }]);
	});
	it('new readings are saved next to them', () => {
		const id = db.createAccount('work').id;
		const full = { available: true, percentage: 100, resets_at_unix: 9000 };
		usage.saveResult(id, { ok: true, usage: { session: full, weekly: { ...full, percentage: 40 }, extra: { percentage: 20, remaining: 40, total: 50 }, models: [{ label: 'Opus', percentage: 100, resets_at_unix: 9000 }] } }, 2_000_000);
		expect(usage.samplesBetween(0, 3000).get(id)).toMatchObject([{ ts: 2000, pct: 100, extraLeft: 40, models: [{ label: 'Opus', pct: 100, reset: 9000 }] }]);
		expect(columns()).toHaveLength(8);
		// a reading that carried no such limit says so ("[]"), unlike the old rows, where nothing is known (NULL)
		usage.saveResult(id, { ok: true, usage: { session: full, weekly: { ...full, percentage: 40 } } }, 2_060_000);
		expect(usage.samplesBetween(2060, 2060).get(id)).toMatchObject([{ models: [] }]);
		expect(usage.samplesBetween(0, 1000).get('old')).toMatchObject([{ models: null }]);
	});
});
