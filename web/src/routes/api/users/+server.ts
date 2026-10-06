import { json } from '@sveltejs/kit';
import { UserError } from '$lib/server/db';
import { body, handle } from '$lib/server/api';
import { SERVER } from '$lib/server/paths';
import { createUser, listUsers } from '$lib/server/users';

const serverOnly = () => {
	if (!SERVER) throw new UserError('Users exist only on the server.', 404);
};

export const GET = () =>
	handle(() => {
		serverOnly();
		return json({ users: listUsers() });
	});

/** Add a user with a temporary password; they choose their own at first sign-in. */
export const POST = ({ request }) =>
	handle(async () => {
		serverOnly();
		const b = await body(request);
		const user = await createUser(b.username, b.password, b.screens);
		return json({ user, users: listUsers() });
	});
