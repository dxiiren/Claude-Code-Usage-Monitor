import { SERVER } from '$lib/server/paths';
import { defaults, uiSettings } from '$lib/server/settings';
import { SCREENS, SCREEN_LABELS, SCREEN_PATHS } from '$lib/server/users';

/** Local mode (the desktop companion) has no sign-in and only these two screens. */
const LOCAL_MENU = [
	{ id: 'accounts', label: SCREEN_LABELS.accounts, href: SCREEN_PATHS.accounts },
	{ id: 'usage', label: SCREEN_LABELS.usage, href: SCREEN_PATHS.usage }
];

export const load = ({ locals }) => {
	if (!SERVER) return { server: false, user: null, menu: LOCAL_MENU, ui: uiSettings(defaults()) };
	const user = locals.user;
	return {
		server: true,
		user: user ? { username: user.username, mustChange: user.mustChange } : null,
		// Only the screens this user may open; the server refuses the rest as well (hooks.server.ts).
		menu: user && !user.mustChange ? SCREENS.filter((sc) => user.screens.includes(sc)).map((sc) => ({ id: sc, label: SCREEN_LABELS[sc], href: SCREEN_PATHS[sc] })) : [],
		ui: uiSettings()
	};
};
