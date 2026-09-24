import { json } from '@sveltejs/kit';
import { UserError, getAccount, moveAccount, removeAccount, renameAccount, setEnabled } from '$lib/server/db';
import { activeSessionFor, cancelLogin, startLogin } from '$lib/server/claude';
import { authCache, body, handle } from '$lib/server/api';

/** One endpoint per account, `action` in the body: rename | enable | move | relogin | remove. */
export const POST = ({ request, params }) =>
	handle(async () => {
		const b = await body(request);
		const id = params.id;
		switch (b.action) {
			case 'rename':
				renameAccount(id, b.name);
				return json({ ok: true });
			case 'enable':
				setEnabled(id, !!b.enabled);
				return json({ ok: true });
			case 'move':
				if (b.direction !== 'up' && b.direction !== 'down') throw new UserError('direction must be up or down');
				moveAccount(id, b.direction);
				return json({ ok: true });
			case 'relogin': {
				const a = getAccount(id);
				if (!a) throw new UserError('That account no longer exists. Reload the page.', 404);
				const login = await startLogin(a.id, a.config_dir);
				return json({ account: { id: a.id, name: a.name }, login });
			}
			case 'remove': {
				const pending = activeSessionFor(id);
				if (pending) await cancelLogin(pending);
				const removed = removeAccount(id);
				authCache.invalidate(removed.folder);
				return json({ ok: true, ...removed });
			}
			default:
				throw new UserError('Unknown action.');
		}
	});
