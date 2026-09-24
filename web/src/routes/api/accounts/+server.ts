import { json } from '@sveltejs/kit';
import { createAccount } from '$lib/server/db';
import { LoginError, startLogin } from '$lib/server/claude';
import { body, handle, snapshot } from '$lib/server/api';

export const GET = () => handle(async () => json(await snapshot()));

/** Add account: create the row, then start the CLI login and open the isolated Edge window. */
export const POST = ({ request }) =>
	handle(async () => {
		const b = await body(request);
		const account = createAccount(b.name);
		try {
			const login = await startLogin(account.id, account.config_dir);
			return json({ account: { id: account.id, name: account.name }, login });
		} catch (e) {
			const msg = e instanceof LoginError ? e.message : (e as Error).message;
			return json({ account: { id: account.id, name: account.name }, error: msg }, { status: 502 });
		}
	});
