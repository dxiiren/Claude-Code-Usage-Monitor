// Everything the Settings screen can change (server mode). Values live in app_settings as JSON;
// a key that was never saved falls back to the built-in default, which itself honours the old
// environment variables (ACCTMGR_POLL_SECONDS, ACCTMGR_TIMEZONE / TZ, ACCTMGR_HISTORY_DAYS).
import { UserError, database } from './db';
import { SERVER } from './paths';
import { BRAND } from '../brand';
import { MAX_SLOTS, slotLength, slotsProblem, uncoveredMinutes, type Slot } from '../slots';

export { MAX_SLOTS, slotLength, slotsProblem, uncoveredMinutes };

const env = process.env;

export type { Slot } from '../slots';

export interface Settings {
	slots: Slot[];
	pollSeconds: number;
	/** 0 = keep forever */
	historyDays: number;
	timezone: string;
	hourlyLabel: string;
	weeklyLabel: string;
	warnAt: number;
	highAt: number;
	/** 0 = off */
	autoRefreshSeconds: number;
	refreshWaitSeconds: number;
	reportView: 'both' | 'graph' | 'table';
	reportPeriod: 'day' | 'week' | 'month';
	limitAt: number;
	idleBelow: number;
	docTitle: string;
	docCompany: string;
	docWebsite: string;
	docEmail: string;
	docFooter: string;
	docNotice: string;
	docFormat: 'docx' | 'pdf' | 'csv';
	docCover: boolean;
	docContents: boolean;
	docLogo: boolean;
	sessionDays: number;
	minPassword: number;
	loginTries: number;
	loginPauseMinutes: number;
	defaultTheme: 'auto' | 'light' | 'dark';
}

export const DEFAULT_SLOTS: Slot[] = [
	{ name: 'Morning', from: 9 * 60, to: 13 * 60 },
	{ name: 'Lunch', from: 13 * 60, to: 14 * 60 },
	{ name: 'Afternoon', from: 14 * 60, to: 18 * 60 },
	{ name: 'After hours', from: 18 * 60, to: 9 * 60 }
];

export function validTimezone(tz: unknown): tz is string {
	if (typeof tz !== 'string' || !tz) return false;
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export function defaults(e: NodeJS.ProcessEnv = env): Settings {
	const tz = [e.ACCTMGR_TIMEZONE, e.TZ].find(validTimezone) ?? 'UTC';
	const days = Number(e.ACCTMGR_HISTORY_DAYS);
	return {
		slots: DEFAULT_SLOTS.map((s) => ({ ...s })),
		pollSeconds: Math.max(30, Number(e.ACCTMGR_POLL_SECONDS) || 300),
		historyDays: Number.isFinite(days) && days >= 0 && e.ACCTMGR_HISTORY_DAYS ? Math.floor(days) : 400,
		timezone: tz,
		hourlyLabel: 'Hourly session',
		weeklyLabel: 'Weekly session',
		warnAt: 70,
		highAt: 90,
		autoRefreshSeconds: 15,
		refreshWaitSeconds: 30,
		reportView: 'both',
		reportPeriod: 'day',
		limitAt: 100,
		idleBelow: 1,
		docTitle: 'Claude Usage Report',
		docCompany: BRAND.company,
		docWebsite: BRAND.website,
		docEmail: BRAND.email,
		docFooter: BRAND.footer,
		docNotice: BRAND.notice,
		docFormat: 'docx',
		docCover: true,
		docContents: false,
		docLogo: true,
		sessionDays: 14,
		minPassword: 12,
		loginTries: 5,
		loginPauseMinutes: 15,
		defaultTheme: 'auto'
	};
}

type Check<T> = (v: unknown) => T;
const text =
	(max: number, allowEmpty = false, multiline = false): Check<string> =>
	(v) => {
		const s = typeof v === 'string' ? v.trim() : '';
		if ((!s && !allowEmpty) || s.length > max || (multiline ? /[\u0000-\u0008\u000b-\u001f]/ : /[\u0000-\u001f]/).test(s))
			throw new UserError(`Use ${max} plain characters or fewer${allowEmpty ? '' : ', and do not leave it empty'}.`);
		return s;
	};
const int =
	(min: number, max: number): Check<number> =>
	(v) => {
		const n = typeof v === 'number' ? v : Number(v);
		if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`Enter a whole number from ${min} to ${max}.`);
		return n;
	};
const oneOf =
	<T extends string | number>(...allowed: T[]): Check<T> =>
	(v) => {
		const hit = allowed.find((a) => a === v || String(a) === String(v));
		if (hit === undefined) throw new UserError(`Choose one of: ${allowed.join(', ')}.`);
		return hit;
	};
const bool: Check<boolean> = (v) => v === true || v === 'true' || v === 1;

const CHECKS: { [K in keyof Settings]: Check<Settings[K]> } = {
	slots: (v) => {
		const list = (Array.isArray(v) ? v : []).map((s) => ({
			name: typeof s?.name === 'string' ? s.name.trim() : '',
			from: Number(s?.from),
			to: Number(s?.to)
		}));
		const problem = slotsProblem(list);
		if (problem) throw new UserError(problem);
		return list;
	},
	pollSeconds: oneOf(30, 60, 120, 300, 600, 900, 1800),
	historyDays: int(0, 3650),
	timezone: (v) => {
		if (!validTimezone(v)) throw new UserError('That time zone is not recognised. Use a name like Asia/Kuala_Lumpur.');
		return v;
	},
	hourlyLabel: text(24),
	weeklyLabel: text(24),
	warnAt: int(1, 99),
	highAt: int(2, 100),
	autoRefreshSeconds: oneOf(0, 15, 30, 60),
	refreshWaitSeconds: oneOf(0, 30, 60, 300),
	reportView: oneOf('both', 'graph', 'table'),
	reportPeriod: oneOf('day', 'week', 'month'),
	limitAt: int(50, 100),
	idleBelow: int(0, 20),
	docTitle: text(60),
	docCompany: text(60, true),
	docWebsite: text(80, true),
	docEmail: text(80, true),
	docFooter: text(40, true),
	docNotice: text(1200, true, true),
	docFormat: oneOf('docx', 'pdf', 'csv'),
	docCover: bool,
	docContents: bool,
	docLogo: bool,
	sessionDays: oneOf(1, 7, 14, 30),
	minPassword: int(8, 64),
	loginTries: int(3, 20),
	loginPauseMinutes: oneOf(5, 15, 60),
	defaultTheme: oneOf('auto', 'light', 'dark')
};

/** Sign-in rules: only someone who manages users may change these, whatever screens they have. */
export const SECURITY_KEYS: (keyof Settings)[] = ['sessionDays', 'minPassword', 'loginTries', 'loginPauseMinutes'];

let cache: Settings | null = null;
const listeners: ((s: Settings) => void)[] = [];

/** Runs after every successful save (the poller uses it to pick up a new interval). */
export function onSettingsChange(fn: (s: Settings) => void): void {
	listeners.push(fn);
}

export function getSettings(): Settings {
	if (cache) return cache;
	const out = defaults() as unknown as Record<string, unknown>;
	if (SERVER) {
		const rows = database().prepare('SELECT key, value FROM app_settings').all() as unknown as { key: string; value: string }[];
		for (const r of rows) {
			if (!(r.key in CHECKS)) continue;
			try {
				// A stored value that no longer validates (older build, hand edit) falls back to the default.
				out[r.key] = (CHECKS as Record<string, Check<unknown>>)[r.key](JSON.parse(r.value));
			} catch {
				/* keep the default */
			}
		}
	}
	return (cache = out as unknown as Settings);
}

/**
 * Saves the given keys (unknown keys are refused); returns the full settings after the save.
 * `admin` = the caller manages users; without it the sign-in rules are refused.
 */
export function saveSettings(patch: Record<string, unknown>, admin = true): Settings {
	if (!SERVER) throw new UserError('Settings are only available on the server.', 404);
	if (!admin && Object.keys(patch).some((k) => SECURITY_KEYS.includes(k as keyof Settings)))
		throw new UserError('Only a user who manages users can change the sign-in rules.', 403);
	const clean: [string, unknown][] = [];
	for (const [k, v] of Object.entries(patch)) {
		if (!(k in CHECKS)) throw new UserError(`Unknown setting: ${k}`);
		try {
			clean.push([k, (CHECKS as Record<string, Check<unknown>>)[k](v)]);
		} catch (e) {
			if (e instanceof UserError) throw new UserError(`${LABELS[k as keyof Settings]}: ${e.message}`);
			throw e;
		}
	}
	const next = { ...getSettings(), ...Object.fromEntries(clean) } as Settings;
	if (next.warnAt >= next.highAt) throw new UserError('The amber level must be lower than the red level.');
	const d = database();
	d.exec('BEGIN IMMEDIATE');
	try {
		const up = d.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
		for (const [k, v] of clean) up.run(k, JSON.stringify(v));
		d.exec('COMMIT');
	} catch (e) {
		d.exec('ROLLBACK');
		throw e;
	}
	cache = next;
	for (const fn of listeners) fn(next);
	return next;
}

/** Tests only: forget the cached copy (a fresh data dir, or rows written directly). */
export function resetSettingsCache(): void {
	cache = null;
}

const LABELS: Record<keyof Settings, string> = {
	slots: 'Time slots',
	pollSeconds: 'Collect usage every',
	historyDays: 'Keep history for',
	timezone: 'Time zone',
	hourlyLabel: 'Name of the 5-hour window',
	weeklyLabel: 'Name of the 7-day window',
	warnAt: 'Turn amber at',
	highAt: 'Turn red at',
	autoRefreshSeconds: 'Usage page refreshes itself every',
	refreshWaitSeconds: 'Wait between manual refreshes',
	reportView: 'Open the report showing',
	reportPeriod: 'Default period',
	limitAt: 'Count as limit reached at',
	idleBelow: 'Mark an account not used below',
	docTitle: 'Report title',
	docCompany: 'Company name',
	docWebsite: 'Website',
	docEmail: 'Contact e-mail',
	docFooter: 'Footer text',
	docNotice: 'Notice on page 2',
	docFormat: 'Default download format',
	docCover: 'Include cover page',
	docContents: 'Include notice and contents page',
	docLogo: 'Show company logo',
	sessionDays: 'Stay signed in for',
	minPassword: 'Shortest password allowed',
	loginTries: 'Wrong passwords before a pause',
	loginPauseMinutes: 'Length of the pause',
	defaultTheme: 'Theme for new users'
};

/** The part every signed-in page needs (labels, colours, refresh timing). Nothing secret. */
export function uiSettings(s: Settings = getSettings()) {
	return {
		hourlyLabel: s.hourlyLabel,
		weeklyLabel: s.weeklyLabel,
		warnAt: s.warnAt,
		highAt: s.highAt,
		autoRefreshSeconds: s.autoRefreshSeconds,
		refreshWaitSeconds: s.refreshWaitSeconds,
		defaultTheme: s.defaultTheme
	};
}
export type UiSettings = ReturnType<typeof uiSettings>;
