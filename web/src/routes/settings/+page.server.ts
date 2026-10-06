import { redirect } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import { getSettings } from '$lib/server/settings';

export const load = ({ locals }) => {
	if (!SERVER) redirect(303, '/');
	// the sign-in rules are shown only to those who may change them (users.ts: whoever manages users)
	return { settings: getSettings(), admin: !!locals.user?.screens.includes('users') };
};
