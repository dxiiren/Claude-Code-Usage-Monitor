import { json } from '@sveltejs/kit';
import { createAccount } from '$lib/server/db';
import { LoginError } from '$lib/server/claude';
import { body, handle, snapshotFor, startLoginFor } from '$lib/server/api';

/** The Usage screen reads this too: see snapshotFor for what a user without the Accounts screen is given. */
export const GET = ({ locals }) => handle(async () => json(await snapshotFor(locals.user)));

/** Add account: create the row (provider claude | codex), then start that CLI's login. */
export const POST = ({ request }) =>
	handle(async () => {
		const b = await body(request);
		const account = createAccount(b.name, b.provider);
		const summary = { id: account.id, name: account.name, provider: account.provider };
		try {
			const login = await startLoginFor(account);
			return json({ account: summary, login });
		} catch (e) {
			const msg = e instanceof LoginError ? e.message : (e as Error).message;
			return json({ account: summary, error: msg }, { status: 502 });
		}
	});
