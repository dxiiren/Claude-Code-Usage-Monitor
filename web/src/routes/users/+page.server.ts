import { redirect } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import { getSettings } from '$lib/server/settings';
import { SCREENS, SCREEN_LABELS, listUsers, temporaryPassword } from '$lib/server/users';

export const load = ({ locals }) => {
	if (!SERVER) redirect(303, '/');
	return {
		users: listUsers(),
		me: locals.user?.id ?? '',
		screens: SCREENS.map((id) => ({ id, label: SCREEN_LABELS[id] })),
		// a suggestion for the Add user form; the admin may type their own
		suggested: temporaryPassword(),
		minPassword: getSettings().minPassword
	};
};
