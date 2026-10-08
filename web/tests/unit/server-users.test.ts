import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { isolateServer } from './helpers';

const env = isolateServer({ ACCTMGR_ADMIN_USER: 'Boss', ACCTMGR_TIMEZONE: 'Asia/Kuala_Lumpur', ACCTMGR_POLL_SECONDS: '45' });
type Users = typeof import('../../src/lib/server/users');
type Auth = typeof import('../../src/lib/server/auth');
type SettingsMod = typeof import('../../src/lib/server/settings');
type Usage = typeof import('../../src/lib/server/serverUsage');
type Db = typeof import('../../src/lib/server/db');
type ReportData = typeof import('../../src/lib/server/reportData');
let users: Users;
let auth: Auth;
let settings: SettingsMod;
let usage: Usage;
let db: Db;
let reportData: ReportData;

function rows<T>(sql: string): T[] {
	const d = new DatabaseSync(path.join(env.data, 'accounts.db'), { readOnly: true });
	try {
		return d.prepare(sql).all() as T[];
	} finally {
		d.close();
	}
}
const PW = 'correct horse battery';

beforeAll(async () => {
	db = await import('../../src/lib/server/db');
	db.initDb();
	auth = await import('../../src/lib/server/auth');
	users = await import('../../src/lib/server/users');
	settings = await import('../../src/lib/server/settings');
	usage = await import('../../src/lib/server/serverUsage');
	reportData = await import('../../src/lib/server/reportData');
});

describe('password hashing', () => {
	it('uses the full scrypt cost by default; a wrong password or a damaged hash never verifies', async () => {
		const h = await users.hashPassword(PW);
		expect(h).toMatch(/^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
		expect(await users.verifyPassword(PW, h)).toBe(true);
		expect(await users.verifyPassword(`${PW} `, h)).toBe(false);
		expect(await users.verifyPassword(PW, h.slice(0, -2))).toBe(false);
		expect(await users.verifyPassword(PW, 'not-a-hash')).toBe(false);
		expect(await users.verifyPassword(undefined, h)).toBe(false);
		// every case below hashes with a light cost: dozens of full-strength hashes starve a small CI runner
		users.setHashCostForTests(1024);
	});
});

describe('the first admin comes from the environment', () => {
	it('is created on first start with every screen, and can sign in', async () => {
		expect(await users.syncEnvAdmin()).toBe('created');
		const all = users.listUsers();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ username: 'boss', screens: [...users.SCREENS], mustChange: false });
		expect(await users.authenticate('Boss', PW)).toMatchObject({ username: 'boss' });
		expect(await users.authenticate(' BOSS ', PW)).not.toBeNull(); // name is case-insensitive
		expect(await users.authenticate('boss', 'Correct horse battery')).toBeNull(); // password is not
		expect(await users.authenticate('nobody', PW)).toBeNull();
		expect(await users.authenticate(undefined, undefined)).toBeNull();
	});
	it('a second start with the same environment changes nothing', async () => {
		const c = auth.createSession(users.listUsers()[0].id);
		expect(await users.syncEnvAdmin()).toBe('unchanged');
		expect(auth.validSession(c)).toBe(true);
	});
	it('stores a scrypt hash, never the password', () => {
		const stored = rows<{ pw_hash: string }>('SELECT pw_hash FROM users');
		expect(stored[0].pw_hash).toMatch(/^scrypt\$\d+\$8\$1\$/);
		expect(JSON.stringify(rows('SELECT * FROM users'))).not.toContain(PW);
	});
	it('a changed environment password resets that admin and signs everyone out', async () => {
		const boss = users.listUsers()[0];
		const c = auth.createSession(boss.id);
		expect(await users.syncEnvAdmin({ ...process.env, ACCTMGR_ADMIN_PASSWORD: 'a brand new password' })).toBe('reset');
		expect(auth.validSession(c)).toBe(false);
		expect(await users.authenticate('boss', PW)).toBeNull();
		expect(await users.authenticate('boss', 'a brand new password')).not.toBeNull();
		expect(await users.syncEnvAdmin()).toBe('reset'); // back to the test password for the cases below
	});
});

describe('users and their screens', () => {
	let bossId: string;
	beforeAll(() => {
		bossId = users.listUsers()[0].id;
	});
	it('a new user gets a temporary password, the chosen screens, and must change it', async () => {
		const u = await users.createUser(' Sarah ', 'temporary-pass-1', ['report', 'usage', 'report']);
		expect(u).toMatchObject({ username: 'sarah', screens: ['usage', 'report'], mustChange: true });
		await expect(users.createUser('sarah', 'temporary-pass-1', [])).rejects.toThrow(/already a user/);
		await expect(users.createUser('x', 'temporary-pass-1', [])).rejects.toThrow(/2 to 24 characters/);
		await expect(users.createUser('good.name', 'short', [])).rejects.toThrow(/at least 12 characters/);
		await expect(users.createUser('good.name', 'temporary-pass-1', ['everything'])).rejects.toThrow(/Unknown screen/);
	});
	it('changing your own password needs the current one, clears the must-change flag and keeps this browser signed in', async () => {
		const sarah = users.listUsers().find((u) => u.username === 'sarah')!;
		const here = auth.createSession(sarah.id);
		const elsewhere = auth.createSession(sarah.id);
		await expect(users.changeOwnPassword(sarah.id, 'wrong', 'my own password 1', here)).rejects.toThrow(/current password is not right/);
		await expect(users.changeOwnPassword(sarah.id, 'temporary-pass-1', 'temporary-pass-1', here)).rejects.toThrow(/different/);
		await users.changeOwnPassword(sarah.id, 'temporary-pass-1', 'my own password 1', here);
		expect(users.getUser(sarah.id)?.mustChange).toBe(false);
		expect(auth.validSession(here)).toBe(true);
		expect(auth.validSession(elsewhere)).toBe(false);
		expect(await users.authenticate('sarah', 'my own password 1')).not.toBeNull();
	});
	it('an admin reset gives a one-time password, signs the user out and forces a change', async () => {
		const sarah = users.listUsers().find((u) => u.username === 'sarah')!;
		const c = auth.createSession(sarah.id);
		const { password, user } = await users.resetPassword(sarah.id);
		expect(password).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
		expect(user.mustChange).toBe(true);
		expect(auth.validSession(c)).toBe(false);
		expect(await users.authenticate('sarah', 'my own password 1')).toBeNull();
		expect(await users.authenticate('sarah', password)).toMatchObject({ mustChange: true });
		expect(JSON.stringify(rows('SELECT * FROM users'))).not.toContain(password);
	});
	it('screens can be changed, but never so that nobody can manage users', async () => {
		const sarah = users.listUsers().find((u) => u.username === 'sarah')!;
		expect(users.setScreens(sarah.id, ['report'], bossId).screens).toEqual(['report']);
		expect(() => users.setScreens(bossId, ['usage'], bossId)).toThrow(/your own access to Users/);
		// even another admin cannot take Users away from the last admin
		expect(() => users.setScreens(bossId, ['usage'], sarah.id)).toThrow(/At least one user must keep/);
		users.setScreens(sarah.id, ['report', 'users'], bossId);
		expect(users.setScreens(bossId, ['usage'], sarah.id).screens).toEqual(['usage']);
		users.setScreens(bossId, [...users.SCREENS], sarah.id);
		users.setScreens(sarah.id, ['report'], bossId);
	});
	it('removal: not yourself, not the last admin; the removed user is signed out', async () => {
		const sarah = users.listUsers().find((u) => u.username === 'sarah')!;
		const c = auth.createSession(sarah.id);
		expect(() => users.removeUser(bossId, bossId)).toThrow(/cannot remove yourself/);
		expect(() => users.removeUser(bossId, sarah.id)).toThrow(/only user who can manage users/);
		users.removeUser(sarah.id, bossId);
		expect(auth.validSession(c)).toBe(false);
		expect(users.getUser(sarah.id)).toBeUndefined();
	});
	it('if no admin is left, the next start restores the environment admin', async () => {
		const d = new DatabaseSync(path.join(env.data, 'accounts.db'));
		d.prepare("UPDATE users SET screens = '[]'").run();
		d.close();
		expect(await users.syncEnvAdmin()).toBe('reset');
		expect(users.getUser(bossId)?.screens).toEqual([...users.SCREENS]);
	});
});

describe('which screen a request needs', () => {
	const need = (method: string, p: string) => users.screensFor(method, p);
	it('pages and their APIs map to one screen; unknown paths need Users', () => {
		expect(need('GET', '/')).toEqual(['accounts']);
		expect(need('POST', '/api/accounts')).toEqual(['accounts']);
		expect(need('POST', '/api/accounts/work')).toEqual(['accounts']);
		expect(need('POST', '/api/login/code')).toEqual(['accounts']);
		expect(need('POST', '/api/settings')).toEqual(['accounts']); // the desktop card theme
		expect(need('GET', '/usage')).toEqual(['usage']);
		expect(need('POST', '/api/usage/refresh')).toEqual(['usage', 'accounts']);
		expect(need('GET', '/report')).toEqual(['report']);
		expect(need('GET', '/api/report/days')).toEqual(['report']);
		expect(need('GET', '/tokens')).toEqual(['tokens']);
		expect(need('DELETE', '/api/tokens/abc')).toEqual(['tokens']);
		expect(need('GET', '/settings')).toEqual(['settings']);
		expect(need('POST', '/api/app-settings')).toEqual(['settings']);
		expect(need('GET', '/users')).toEqual(['users']);
		expect(need('POST', '/api/users/abc')).toEqual(['users']);
		expect(need('GET', '/something-new')).toEqual(['users']);
		expect(need('GET', '/api/accountsX')).toEqual(['users']);
	});
	it('reading the account list is open to Accounts and Usage; own-account pages to anyone signed in', () => {
		expect(need('GET', '/api/accounts')).toEqual(['accounts', 'usage']);
		expect(need('GET', '/account')).toEqual([]);
		expect(need('POST', '/api/account/password')).toEqual([]);
		expect(need('POST', '/logout')).toEqual([]);
	});
	it('home is the first screen the user has, in menu order', () => {
		expect(users.homeFor(['report', 'usage'])).toBe('/usage');
		expect(users.homeFor(['users'])).toBe('/users');
		expect(users.homeFor([])).toBe('/account');
	});
});

describe('settings', () => {
	it('defaults honour the old environment variables', () => {
		const s = settings.getSettings();
		expect(s.timezone).toBe('Asia/Kuala_Lumpur');
		expect(s.pollSeconds).toBe(45);
		expect(s.slots.map((x) => x.name)).toEqual(['Morning', 'Lunch', 'Afternoon', 'After hours']);
		expect(s.hourlyLabel).toBe('Hourly session');
		expect(s.weeklyLabel).toBe('Weekly session');
	});
	it('saves valid values, keeps them across a fresh read, and tells listeners', () => {
		const seen: number[] = [];
		settings.onSettingsChange((s) => seen.push(s.pollSeconds));
		const next = settings.saveSettings({ pollSeconds: 60, hourlyLabel: ' 5-hour block ', slots: [{ name: 'Day', from: 480, to: 1200 }] });
		expect(next).toMatchObject({ pollSeconds: 60, hourlyLabel: '5-hour block' });
		expect(seen).toEqual([60]);
		settings.resetSettingsCache();
		expect(settings.getSettings().slots).toEqual([{ name: 'Day', from: 480, to: 1200 }]);
	});
	it('refuses bad values with a message that names the setting, and saves nothing from that request', () => {
		expect(() => settings.saveSettings({ timezone: 'Mars/Olympus' })).toThrow(/Time zone/);
		expect(() => settings.saveSettings({ warnAt: 95, highAt: 90 })).toThrow(/amber level must be lower/);
		expect(() => settings.saveSettings({ slots: [{ name: 'a', from: 0, to: 600 }, { name: 'b', from: 300, to: 900 }] })).toThrow(/overlap/);
		expect(() => settings.saveSettings({ docTitle: 'New title', nonsense: 1 })).toThrow(/Unknown setting/);
		expect(settings.getSettings().docTitle).toBe('Claude Usage Report');
		expect(settings.getSettings().warnAt).toBe(70);
	});
	it('sign-in rules are refused unless the caller manages users; everything else still saves', () => {
		expect(() => settings.saveSettings({ minPassword: 8 }, false)).toThrow(/manages users/);
		expect(() => settings.saveSettings({ docTitle: 'x', loginTries: 20 }, false)).toThrow(/manages users/);
		expect(settings.getSettings()).toMatchObject({ minPassword: 12, loginTries: 5, docTitle: 'Claude Usage Report' });
		expect(settings.saveSettings({ reportView: 'table' }, false).reportView).toBe('table');
		expect(settings.saveSettings({ minPassword: 14 }, true).minPassword).toBe(14);
		settings.saveSettings({ minPassword: 12, reportView: 'both' });
	});
	it('a stored value that no longer validates falls back to the default', () => {
		const d = new DatabaseSync(path.join(env.data, 'accounts.db'));
		d.prepare("INSERT INTO app_settings (key, value) VALUES ('limitAt', '\"lots\"') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
		d.close();
		settings.resetSettingsCache();
		expect(settings.getSettings().limitAt).toBe(100);
	});
});

describe('reading history', () => {
	const kl = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+08:00`);
	const reading = (pct: number) => ({ ok: true as const, usage: { session: { available: true, percentage: pct, resets_at_unix: null }, weekly: { available: true, percentage: 5, resets_at_unix: null } } });
	let id: string;
	beforeAll(() => {
		settings.saveSettings({ slots: [{ name: 'Morning', from: 540, to: 780 }, { name: 'Rest', from: 780, to: 540 }] });
		id = db.createAccount('work').id;
	});
	it('every good poll is kept; a failed poll adds nothing', () => {
		usage.saveResult(id, reading(10), kl('2026-10-06', '09:05'));
		usage.saveResult(id, reading(40), kl('2026-10-06', '11:00'));
		usage.saveResult(id, { ok: false, error: 'network_error' }, kl('2026-10-06', '11:05'));
		usage.saveResult(id, reading(55), kl('2026-10-06', '15:00'));
		expect(rows<{ n: number }>('SELECT COUNT(*) AS n FROM usage_samples')[0].n).toBe(3);
		expect(usage.firstSampleUnix()).toBe(kl('2026-10-06', '09:05') / 1000);
	});
	it('a reading keeps how much paid extra usage was left, and nothing when none was in force', () => {
		const other = db.createAccount('paid').id;
		const full = (extra?: { percentage: number; remaining: number; total: number }) => ({
			ok: true as const,
			usage: { session: { available: true, percentage: 100, resets_at_unix: kl('2026-10-05', '14:00') / 1000 }, weekly: { available: true, percentage: 5, resets_at_unix: null }, ...(extra ? { extra } : {}) }
		});
		usage.saveResult(other, full({ percentage: 25, remaining: 37.5, total: 50 }), kl('2026-10-05', '10:00'));
		usage.saveResult(other, full({ percentage: 100, remaining: 0, total: 50 }), kl('2026-10-05', '11:00'));
		usage.saveResult(other, full(), kl('2026-10-05', '12:00'));
		expect(rows<{ extra_left: number | null }>(`SELECT extra_left FROM usage_samples WHERE account_id = '${other}' ORDER BY ts_unix`).map((r) => r.extra_left)).toEqual([37.5, 0, null]);
		const hit = reportData.loadReport('day', '2026-10-05', kl('2026-10-05', '16:00')).hits.find((h) => h.accountId === other);
		// on paid extra usage 10:00 to 11:00, then blocked until the reset at 14:00
		expect(hit).toMatchObject({ extra: 'part', blockedSeconds: 3 * 3600 });
		db.removeAccount(other);
		db.database().prepare('DELETE FROM usage_samples WHERE account_id = ?').run(other);
		db.database().prepare('DELETE FROM report_accounts WHERE account_id = ?').run(other);
	});
	it('Codex credits are measured against the balance kept with the last good reading, across a failed poll', () => {
		const other = db.createAccount('codex credits').id;
		const full = (balance: number) => ({
			ok: true as const,
			usage: {
				session: { available: false, percentage: 0, resets_at_unix: null },
				weekly: { available: true, percentage: 100, resets_at_unix: kl('2026-10-04', '14:00') / 1000 },
				credits: { account: 'acct-1', balance, baseline: balance, live: true, capped: false }
			}
		});
		const stored = () => JSON.parse(rows<{ usage_json: string }>(`SELECT usage_json FROM account_usage WHERE account_id = '${other}'`)[0].usage_json);
		usage.saveResult(other, full(500), kl('2026-10-04', '10:00'));
		expect(stored().extra).toBeUndefined();
		usage.saveResult(other, { ok: false, error: 'network_error' }, kl('2026-10-04', '10:30'));
		usage.saveResult(other, full(400), kl('2026-10-04', '11:00'));
		expect(stored()).toMatchObject({ extra: { percentage: 20, remaining: 16, total: 20 }, credits: { balance: 400, baseline: 500 } });
		expect(rows<{ extra_left: number | null }>(`SELECT extra_left FROM usage_samples WHERE account_id = '${other}' ORDER BY ts_unix`).map((r) => r.extra_left)).toEqual([null, 16]);
		db.removeAccount(other);
		db.database().prepare('DELETE FROM usage_samples WHERE account_id = ?').run(other);
		db.database().prepare('DELETE FROM report_accounts WHERE account_id = ?').run(other);
	});
	it('a reading whose saved per-model text is not what the server writes never breaks a report', () => {
		const other = db.createAccount('odd models').id;
		const at = kl('2026-10-03', '10:00') / 1000;
		const ins = db.database().prepare('INSERT INTO usage_samples (account_id, ts_unix, s_pct, w_pct, models_json) VALUES (?, ?, 10, 20, ?)');
		const texts = ['not json', '{"a":1}', '[null,5,"x",{"label":1,"pct":"x"},{"label":"Z"}]', '[{"label":"","pct":100,"reset":5}]', '[{"label":"Opus","pct":100,"reset":1e300}]', '[{"label":"Opus","pct":1e999,"reset":null}]', '[{"label":"  Opus ","pct":100,"reset":-4}]'];
		texts.forEach((t, i) => ins.run(other, at + i * 60, t));
		const kept = usage.samplesBetween(at, at + 3600).get(other)!.map((s) => s.models);
		// only a named model with a real level is kept; a reset that is no real moment is dropped, not the reading
		expect(kept).toEqual([null, null, null, null, [{ label: 'Opus', pct: 100, reset: null }], null, [{ label: 'Opus', pct: 100, reset: null }]]);
		const r = reportData.loadReport('day', '2026-10-03', kl('2026-10-03', '16:00'));
		expect(r.hits.filter((h) => h.accountId === other)).toMatchObject([{ model: 'Opus', until: null }]);
		db.removeAccount(other);
		db.database().prepare('DELETE FROM usage_samples WHERE account_id = ?').run(other);
		db.database().prepare('DELETE FROM report_accounts WHERE account_id = ?').run(other);
	});
	it('calendar dots mark exactly the days whose report has data, also where the day starts mid-hour', () => {
		const before = settings.getSettings();
		// Kolkata is UTC+5:30: a report day starting at 09:00 begins at 03:30 UTC, inside an hour
		settings.saveSettings({ timezone: 'Asia/Kolkata' });
		const other = db.createAccount('dots').id;
		const at = Date.parse('2026-11-06T08:40:00+05:30'); // 20 minutes before the 6th starts: still the 5th
		const onLine = Date.parse('2026-11-08T09:00:00+05:30'); // exactly on the line: belongs to the day that just ended
		usage.saveResult(other, reading(10), at);
		usage.saveResult(other, reading(12), onLine);
		expect(reportData.daysWithData('2026-11')).toEqual(['2026-11-05', '2026-11-07']);
		for (const [date, has] of [['2026-11-05', true], ['2026-11-06', false], ['2026-11-07', true], ['2026-11-08', false]] as const)
			expect(reportData.loadReport('day', date, onLine + 3_600_000).hasData, date).toBe(has);
		settings.saveSettings({ timezone: before.timezone });
		db.removeAccount(other);
		db.database().prepare('DELETE FROM usage_samples WHERE account_id = ?').run(other);
		db.database().prepare('DELETE FROM report_accounts WHERE account_id = ?').run(other);
	});
	it('the report cuts the kept readings into the configured slots', () => {
		const r = reportData.loadReport('day', '2026-10-06', kl('2026-10-06', '16:00'));
		expect(r.accounts).toMatchObject([{ name: 'work', slots: [30, 15], total: 45 }]);
		expect(r.today).toBe('2026-10-06');
		expect(r.firstDate).toBe('2026-10-06');
		expect(reportData.daysWithData('2026-10')).toEqual(['2026-10-06']);
		expect(() => reportData.loadReport('day', '2026-13-40')).toThrow(/not valid/);
	});
	it('history survives removing the account, under its last name', () => {
		db.removeAccount(id);
		const r = reportData.loadReport('day', '2026-10-06', kl('2026-10-06', '16:00'));
		expect(r.accounts).toMatchObject([{ name: 'work', current: false, total: 45 }]);
		// ...and an old account with nothing in the period is left out
		expect(reportData.loadReport('day', '2026-10-01', kl('2026-10-06', '16:00')).accounts).toEqual([]);
	});
	it('prunes readings older than the kept history; 0 keeps everything', () => {
		const now = kl('2026-10-06', '16:00') / 1000;
		expect(usage.pruneSamples(now, 0)).toBe(0);
		expect(usage.pruneSamples(now + 10 * 86_400, 5)).toBe(3);
		expect(usage.firstSampleUnix()).toBeNull();
	});
});
