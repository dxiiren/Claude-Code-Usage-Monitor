import { error, json } from '@sveltejs/kit';
import { SERVER } from '$lib/server/paths';
import { createToken, listTokens } from '$lib/server/auth';
import { body, handle } from '$lib/server/api';

/** Widget API tokens (server mode). The token itself is returned once, by POST, and never again. */
export const GET = () => {
	if (!SERVER) error(404, 'Not found');
	return json({ tokens: listTokens() });
};

export const POST = ({ request }) => {
	if (!SERVER) error(404, 'Not found');
	return handle(async () => {
		const b = await body(request);
		return json(createToken(b.name));
	});
};
