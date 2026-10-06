import { redirect } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import { getSettings } from '$lib/server/settings';
import { homeFor } from '$lib/server/users';

export const load = ({ locals }) => {
	if (!SERVER || !locals.user) redirect(303, '/');
	return { mustChange: locals.user.mustChange, minPassword: getSettings().minPassword, home: homeFor(locals.user.screens), hasScreens: locals.user.screens.length > 0 };
};
