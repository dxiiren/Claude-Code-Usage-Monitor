import { json } from '@sveltejs/kit';
import { UserError } from '$lib/server/db';
import { handle, snapshot } from '$lib/server/api';
import { SERVER } from '$lib/server/paths';
import { refreshNow } from '$lib/server/serverUsage';

/** "Refresh now": read usage straight away for every enabled account. */
export const POST = () =>
	handle(async () => {
		if (!SERVER) throw new UserError('The desktop widget reads usage on this PC; refresh it from the widget.', 404);
		try {
			const result = await refreshNow();
			return json({ ...result, snap: await snapshot() });
		} catch (e) {
			const wait = (e as { retryAfter?: number }).retryAfter;
			if (e instanceof UserError && wait)
				return json({ error: e.message, retryAfter: wait }, { status: 429, headers: { 'retry-after': String(wait) } });
			throw e;
		}
	});
