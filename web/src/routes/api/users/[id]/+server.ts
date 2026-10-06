import { json } from '@sveltejs/kit';
import { UserError } from '$lib/server/db';
import { body, handle } from '$lib/server/api';
import { SERVER } from '$lib/server/paths';
import { listUsers, removeUser, resetPassword, setScreens } from '$lib/server/users';

/** `{ action: 'screens', screens }` | `{ action: 'reset' }` | `{ action: 'remove' }` */
export const POST = ({ request, params, locals }) =>
	handle(async () => {
		if (!SERVER || !locals.user) throw new UserError('Users exist only on the server.', 404);
		const b = await body(request);
		const me = locals.user.id;
		if (b.action === 'screens') {
			setScreens(params.id, b.screens, me);
			return json({ users: listUsers() });
		}
		if (b.action === 'reset') {
			if (params.id === me) throw new UserError('Change your own password from "Change password" instead.');
			const { password } = await resetPassword(params.id);
			// Shown to the admin once, to pass on; it is never stored or logged in readable form.
			return json({ users: listUsers(), password });
		}
		if (b.action === 'remove') {
			removeUser(params.id, me);
			return json({ users: listUsers() });
		}
		throw new UserError('Unknown action.');
	});
