import { redirect } from '@sveltejs/kit';
import { SERVER, PUBLIC_ORIGIN } from '$lib/server/paths';
import { listTokens } from '$lib/server/auth';

export const load = () => {
	if (!SERVER) redirect(303, '/');
	return { tokens: listTokens(), origin: PUBLIC_ORIGIN };
};
