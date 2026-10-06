import { json } from '@sveltejs/kit';
import { UserError } from '$lib/server/db';
import { body, handle } from '$lib/server/api';
import { SERVER } from '$lib/server/paths';
import { cookieName } from '$lib/server/auth';
import { changeOwnPassword } from '$lib/server/users';

/** A signed-in user changes their own password (`{ current, next }`). */
export const POST = ({ request, locals, cookies }) =>
	handle(async () => {
		if (!SERVER || !locals.user) throw new UserError('There is no sign-in on this PC.', 404);
		const b = await body(request);
		await changeOwnPassword(locals.user.id, b.current, b.next, cookies.get(cookieName()));
		return json({ ok: true });
	});
