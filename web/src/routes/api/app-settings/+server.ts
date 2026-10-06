import { json } from '@sveltejs/kit';
import { UserError } from '$lib/server/db';
import { body, handle } from '$lib/server/api';
import { SERVER } from '$lib/server/paths';
import { getSettings, saveSettings } from '$lib/server/settings';

export const GET = () =>
	handle(() => {
		if (!SERVER) throw new UserError('Settings are only available on the server.', 404);
		return json({ settings: getSettings() });
	});

/** Saves the keys sent; anything left out keeps its value. */
export const POST = ({ request, locals }) =>
	handle(async () => {
		const b = await body(request);
		if (!Object.keys(b).length) throw new UserError('Nothing to change.');
		return json({ settings: saveSettings(b, !!locals.user?.screens.includes('users')) });
	});
