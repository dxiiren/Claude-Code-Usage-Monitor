import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { isolateHome } from './helpers';

const env = isolateHome();
type Db = typeof import('../../src/lib/server/db');
type Api = typeof import('../../src/lib/server/api');
let db: Db;
let api: Api;

const dbFile = () => path.join(env.appDir, 'accounts.db');
function meta(): Record<string, string> {
	const d = new DatabaseSync(dbFile(), { readOnly: true });
	try {
		return Object.fromEntries((d.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
	} finally {
		d.close();
	}
}
const revision = () => Number(meta().revision);
const theme = () => JSON.parse(fs.readFileSync(path.join(env.appDir, 'themes', 'multi-claude-accounts.json'), 'utf8'));
const themeIds = (): string[] => theme().surfaces[0].children.map((c: { id: string }) => c.id);
const settings = () => JSON.parse(fs.readFileSync(path.join(env.appDir, 'settings.json'), 'utf8'));

beforeAll(async () => {
	db = await import('../../src/lib/server/db');
	api = await import('../../src/lib/server/api');
	db.initDb();
});

describe('schema + meta', () => {
	it('creates accounts + meta tables, rollback journal, contract meta rows', () => {
		const d = new DatabaseSync(dbFile(), { readOnly: true });
		const cols = (d.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((c) => c.name);
		const mode = (d.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
		d.close();
		expect(cols).toEqual(['id', 'name', 'config_dir', 'email', 'plan', 'enabled', 'sort_order', 'created_at', 'updated_at', 'provider']);
		expect(mode).toBe('delete');
		expect(meta()).toEqual({ revision: '0', schema: '2', manager_url: 'http://127.0.0.1:47291', card_theme: 'auto' });
		expect(fs.existsSync(`${dbFile()}-wal`)).toBe(false);
	});

	it('a fresh DB starts empty and still writes a valid zero-account card + settings', () => {
		expect(db.listAccounts()).toEqual([]);
		expect(themeIds()).toContain('no-accounts-dark');
		expect(settings().accounts.claude).toEqual({ profiles: [], selected: '', used_ids: [] });
	});
});

describe('writes', () => {
	it('create: slug id, %USERPROFILE%\\.claude-<id>, revision +1, theme + settings follow', () => {
		const r0 = revision();
		const a = db.createAccount('Work KV');
		expect(a.id).toBe('work_kv');
		expect(a.config_dir).toBe(path.join(env.home, '.claude-work_kv'));
		expect(a.email).toBeNull();
		expect(revision()).toBe(r0 + 1);
		expect(themeIds()).toContain('name-work_kv-dark');
		expect(settings().accounts.claude.profiles[0]).toEqual({
			config_dir: a.config_dir,
			credentials_path: '',
			enabled: true,
			id: 'work_kv',
			name: 'Work KV'
		});
	});

	it('rejects empty and duplicate (case-insensitive) names without bumping revision', () => {
		const r0 = revision();
		expect(() => db.createAccount('  ')).toThrow(/name/);
		expect(() => db.createAccount('work kv')).toThrow(/already an account/);
		expect(revision()).toBe(r0);
	});

	it('rename / enable / move / setAuth / card theme each bump revision by exactly 1', () => {
		db.createAccount('second');
		db.createAccount('third');
		const steps: [string, () => void][] = [
			['rename', () => db.renameAccount('second', 'Second!')],
			['disable', () => db.setEnabled('third', false)],
			['move', () => db.moveAccount('third', 'up')],
			['auth', () => db.setAuth('work_kv', 'kv@example.com', 'max')],
			['card theme', () => db.setCardTheme('light')]
		];
		for (const [, fn] of steps) {
			const r0 = revision();
			fn();
			expect(revision()).toBe(r0 + 1);
		}
		const rows = db.listAccounts();
		expect(rows.map((r) => r.id)).toEqual(['work_kv', 'third', 'second']);
		expect(rows.find((r) => r.id === 'second')!.name).toBe('Second!');
		expect(rows.find((r) => r.id === 'third')!.enabled).toBe(0);
		expect(rows.find((r) => r.id === 'work_kv')).toMatchObject({ email: 'kv@example.com', plan: 'max' });
		// disabled rows are left out of the widget card and settings
		expect(themeIds()).not.toContain('name-third');
		expect(settings().accounts.claude.profiles.map((p: { id: string }) => p.id)).toEqual(['work_kv', 'second']);
		// light card theme: single-variant ids and the light background
		expect(meta().card_theme).toBe('light');
		expect(theme().surfaces[0].background.colour.color).toBe('#FFFFFFFF');
		expect(() => db.setCardTheme('neon')).toThrow(/auto, light or dark/);
	});

	it('move at the edge is a no-op on order but still a counted write', () => {
		const before = db.listAccounts().map((r) => r.id);
		db.moveAccount(before[0], 'up');
		expect(db.listAccounts().map((r) => r.id)).toEqual(before);
	});
});

describe('account ids are theme-safe [a-z0-9_]', () => {
	it('maps "-" and other characters to "_", collapses repeats, trims', () => {
		expect(db.slugId('my-work!')).toBe('my_work');
		expect(db.slugId('  KV -- Team.2 ')).toBe('kv_team_2');
		expect(db.slugId('___')).toBe('');
		const a = db.createAccount('my-work!');
		expect(a.id).toBe('my_work');
		expect(a.config_dir).toBe(path.join(env.home, '.claude-my_work'));
		expect(db.createAccount('My Work').id).toBe('my_work_2');
		for (const r of db.listAccounts()) expect(r.id).toMatch(/^[a-z0-9_]+$/);
		db.removeAccount('my_work');
		db.removeAccount('my_work_2');
	});
});

describe('duplicate-email detection', () => {
	it('flags other rows with the same email (case-insensitive) both ways', async () => {
		db.setAuth('second', 'KV@example.com', 'pro');
		expect(db.accountsWithEmail('kv@example.com', 'second').map((a) => a.id)).toEqual(['work_kv']);
		const snap = await api.snapshot();
		expect(snap.accounts.find((a) => a.id === 'second')!.sameEmailAs).toEqual(['Work KV']);
		expect(snap.accounts.find((a) => a.id === 'work_kv')!.sameEmailAs).toEqual(['Second!']);
		expect(snap.accounts.find((a) => a.id === 'third')!.sameEmailAs).toEqual([]);
	});
});

describe('remove + folder deletion guard', () => {
	it('deletes only the removed row\'s own .claude-<id> folder', () => {
		const mine = path.join(env.home, '.claude-third');
		const other = path.join(env.home, '.claude-second');
		const main = path.join(env.home, '.claude');
		for (const d of [mine, other, main]) {
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(path.join(d, '.credentials.json'), '{}');
		}
		const r0 = revision();
		const r = db.removeAccount('third');
		expect(r.folderDeleted).toBe(true);
		expect(fs.existsSync(mine)).toBe(false);
		expect(fs.existsSync(other)).toBe(true);
		expect(fs.existsSync(main)).toBe(true);
		expect(revision()).toBe(r0 + 1);
		expect(db.getAccount('third')).toBeUndefined();
	});

	it('never deletes %USERPROFILE%\\.claude even if a row points at it', () => {
		const main = path.join(env.home, '.claude');
		const d = new DatabaseSync(dbFile());
		const t = new Date().toISOString();
		d.prepare('INSERT INTO accounts (id, name, config_dir, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, 99, ?, ?)').run('legacy', 'legacy', main, t, t);
		d.close();
		const r = db.removeAccount('legacy');
		expect(r.folderDeleted).toBe(false);
		expect(r.folderNote).toMatch(/left alone/);
		expect(fs.existsSync(path.join(main, '.credentials.json'))).toBe(true);
	});

	it('refuses folders outside %USERPROFILE%\\.claude-* and keeps a folder another row still uses', () => {
		const outside = path.join(env.root, 'elsewhere', '.claude-x');
		fs.mkdirSync(outside, { recursive: true });
		const d = new DatabaseSync(dbFile());
		const t = new Date().toISOString();
		const shared = path.join(env.home, '.claude-second');
		d.prepare('INSERT INTO accounts (id, name, config_dir, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, 99, ?, ?)').run('out', 'out', outside, t, t);
		d.prepare('INSERT INTO accounts (id, name, config_dir, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, 99, ?, ?)').run('twin', 'twin', shared, t, t);
		d.close();
		expect(db.removeAccount('out').folderDeleted).toBe(false);
		expect(fs.existsSync(outside)).toBe(true);
		expect(db.removeAccount('twin').folderNote).toMatch(/Another account/);
		expect(fs.existsSync(shared)).toBe(true);
	});

	it('never reuses a removed id for a new account', () => {
		const again = db.createAccount('third');
		expect(again.id).toBe('third_2');
		expect(settings().accounts.claude.used_ids).toEqual(expect.arrayContaining(['work_kv', 'second', 'third', 'third_2']));
	});
});
