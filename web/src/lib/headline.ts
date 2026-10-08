// The line on top of the Usage page: which account to use now, or why none can be named.
// Pure: every case is testable with a hand-made list of accounts and an explicit clock.
import { needsLogin, readingOver, windowFull } from './format';

interface Win {
	percentage: number;
	resetsAt: number | null;
}

/** The fields of a snapshot account the headline reads. */
export interface HeadAccount {
	id: string;
	name: string;
	provider: string;
	enabled: boolean;
	email: string | null;
	status: { state: string };
	usage: {
		session: Win | null;
		weekly: Win | null;
		models: (Win & { label: string; other?: boolean })[];
		extra: { remaining: number } | null;
	} | null;
}

export type Headline<A extends HeadAccount = HeadAccount> =
	/** an account under its limits, with a current reading */
	| { kind: 'best'; account: A }
	/** none is under its limits, but these keep working on paid extra usage */
	| { kind: 'extra'; accounts: A[] }
	/**
	 * no account with a current reading can be used. `unknown` counts the accounts nothing current is
	 * known about (old reading, login needed, never read): with any of those, "all" would be a guess.
	 */
	| { kind: 'blocked'; blocked: number; unknown: number; nextFree: number | null }
	/** there are numbers, but none of them describes now */
	| { kind: 'old' }
	/** nothing to go by, and why */
	| { kind: 'none'; why: 'hidden' | 'login' | 'failed' | 'unread' };

/** At a limit right now in either window (a window that has reset since no longer counts). */
export const atLimit = (a: HeadAccount, now: number) => windowFull(a.usage?.session, now) || windowFull(a.usage?.weekly, now);
/** Past its limit but still working, on paid extra usage that has not run out. */
export const onExtra = (a: HeadAccount, now: number) => atLimit(a, now) && !!a.usage?.extra && a.usage.extra.remaining > 0;
/** The limits next to the two windows that are used up right now. */
export const limitsOut = (a: HeadAccount, now: number) => (a.usage?.models ?? []).filter((m) => windowFull(m, now));

/** How full the account's tighter window is: the one that will stop it first. A window that has reset since is empty again. */
function tightness(a: HeadAccount, now: number): number {
	const used = (w: Win | null | undefined) => (!w || readingOver(w.percentage, w.resetsAt, now) ? 0 : w.percentage);
	return Math.max(used(a.usage?.session), used(a.usage?.weekly));
}

/**
 * The headline for one provider's accounts (Claude and Codex allowances are not interchangeable, so
 * each gets its own). `isOld` says whether an account's reading is too old to describe now. Hidden
 * accounts are left out: they are not on the widget, and the server does not read them.
 */
export function headline<A extends HeadAccount>(accounts: A[], now: number, isOld: (a: A) => boolean): Headline<A> {
	const shown = accounts.filter((a) => a.enabled);
	if (!shown.length) return { kind: 'none', why: 'hidden' };
	const usable = shown.filter((a) => a.email && !needsLogin(a.status.state));
	const read = usable.filter((a) => a.usage?.session || a.usage?.weekly);
	const current = read.filter((a) => !isOld(a));
	const free = current.filter((a) => !atLimit(a, now));
	if (free.length) {
		// one with every limit free comes first; then the one whose tighter window has most room
		free.sort((x, y) => Math.sign(limitsOut(x, now).length) - Math.sign(limitsOut(y, now).length) || tightness(x, now) - tightness(y, now));
		return { kind: 'best', account: free[0] };
	}
	const paid = current.filter((a) => onExtra(a, now));
	if (paid.length) return { kind: 'extra', accounts: paid };
	if (current.length) {
		let nextFree: number | null = null;
		for (const a of current) {
			const blockers = [a.usage?.session, a.usage?.weekly].filter((w) => windowFull(w, now) && w!.resetsAt);
			if (!blockers.length) continue;
			const freeAt = Math.max(...blockers.map((w) => w!.resetsAt!));
			if (nextFree === null || freeAt < nextFree) nextFree = freeAt;
		}
		return { kind: 'blocked', blocked: current.length, unknown: shown.length - current.length, nextFree };
	}
	if (read.length) return { kind: 'old' };
	if (!usable.length) return { kind: 'none', why: 'login' };
	return { kind: 'none', why: usable.some((a) => a.status.state === 'error') ? 'failed' : 'unread' };
}

/** One headline per provider that has accounts, Claude first. */
export function headlines<A extends HeadAccount>(accounts: A[], now: number, isOld: (a: A) => boolean): { provider: 'claude' | 'codex'; head: Headline<A> }[] {
	const out: { provider: 'claude' | 'codex'; head: Headline<A> }[] = [];
	for (const provider of ['claude', 'codex'] as const) {
		const group = accounts.filter((a) => (a.provider === 'codex' ? 'codex' : 'claude') === provider);
		if (group.length) out.push({ provider, head: headline(group, now, isOld) });
	}
	return out;
}
