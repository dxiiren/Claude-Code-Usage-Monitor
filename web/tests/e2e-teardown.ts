// Playwright globalTeardown (both configs): remove this run's temp root. It runs BEFORE Playwright
// stops the web server, which still holds the SQLite file open, hence removeTreeLater.
import { removeTreeLater } from './tmp-cleanup';

export default function teardown() {
	removeTreeLater(process.env.ACCTMGR_E2E_ROOT);
	removeTreeLater(process.env.ACCTMGR_E2E_SERVER_ROOT);
}
