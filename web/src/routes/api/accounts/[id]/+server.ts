import { json } from '@sveltejs/kit';
import { UserError, getAccount, moveAccount, removeAccount, renameAccount, setEnabled } from '$lib/server/db';
import { authCache, body, cancelAnyLogin, codexAuthCache, handle, pendingLoginFor, startLoginFor } from '$lib/server/api';

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
				const login = await startLoginFor(a);
				return json({ account: { id: a.id, name: a.name, provider: a.provider }, login });
			}
			case 'remove': {
				const pending = pendingLoginFor(id);
				if (pending) await cancelAnyLogin(pending);
				const removed = removeAccount(id);
				authCache.invalidate(removed.folder);
				codexAuthCache.invalidate(removed.folder);
				return json({ ok: true, ...removed });
			}
			default:
				throw new UserError('Unknown action.');
		}
	});
