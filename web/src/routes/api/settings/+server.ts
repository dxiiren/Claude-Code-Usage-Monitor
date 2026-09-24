import { json } from '@sveltejs/kit';
import { UserError, setCardTheme } from '$lib/server/db';
import { body, handle } from '$lib/server/api';

/** Manager settings. Currently: the desktop card theme (meta.card_theme = auto | light | dark). */
export const POST = ({ request }) =>
	handle(async () => {
		const b = await body(request);
		if (b.cardTheme === undefined) throw new UserError('Nothing to change.');
		setCardTheme(b.cardTheme);
		return json({ ok: true, cardTheme: b.cardTheme });
	});
