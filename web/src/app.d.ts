declare global {
	namespace App {
		interface Locals {
			/** Server mode: the signed-in dashboard user (set in hooks.server.ts). */
			user?: import('$lib/server/auth').SessionUser;
		}
	}
}
export {};
