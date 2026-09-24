import { error, json } from '@sveltejs/kit';
import { restartWidget } from '$lib/server/widget';
import { handle } from '$lib/server/api';
import { SERVER } from '$lib/server/paths';

export const POST = () => {
	if (SERVER) error(404, 'Not found'); // no desktop widget next to a server
	return handle(async () => {
		const r = await restartWidget();
		return json({ ok: true, wasRunning: r.wasRunning });
	});
};
