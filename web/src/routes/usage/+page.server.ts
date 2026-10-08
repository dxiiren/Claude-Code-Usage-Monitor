import { snapshotFor } from '$lib/server/api';

export const load = async ({ locals }) => ({ snap: await snapshotFor(locals.user) });
