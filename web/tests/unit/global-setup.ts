// One parent temp folder per `vitest run`: every isolateHome()/isolateServer() folder is created
// inside it (workers inherit ACCTMGR_TEST_TMP), and it is removed once all workers have exited
// (a worker can still hold its accounts.db open during teardown: removeTreeLater).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTreeLater, sweepStale } from '../tmp-cleanup';

export default function setup() {
	sweepStale('acctmgr-unit-');
	sweepStale('acctmgr-srv-');
	const run = fs.mkdtempSync(path.join(os.tmpdir(), 'acctmgr-unit-run-'));
	process.env.ACCTMGR_TEST_TMP = run;
	return () => removeTreeLater(run);
}
