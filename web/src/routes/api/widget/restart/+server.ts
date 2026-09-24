import { json } from '@sveltejs/kit';
import { restartWidget } from '$lib/server/widget';
import { handle } from '$lib/server/api';

export const POST = () =>
	handle(async () => {
		const r = await restartWidget();
		return json({ ok: true, wasRunning: r.wasRunning });
	});
