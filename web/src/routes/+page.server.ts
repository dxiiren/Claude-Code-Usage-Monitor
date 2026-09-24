import { snapshot } from '$lib/server/api';

export const load = async () => ({ snap: await snapshot() });
