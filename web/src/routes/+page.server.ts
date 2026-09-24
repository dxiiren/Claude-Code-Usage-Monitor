import { snapshot } from '$lib/server/api';

export const load = () => ({ snap: snapshot() });
