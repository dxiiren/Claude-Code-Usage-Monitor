// settings.json writer + usage-cache reader, on an isolated APPDATA.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isolateHome } from './helpers';

const env = isolateHome();
let wf: typeof import('../../src/lib/server/widgetFiles');
let usage: typeof import('../../src/lib/server/usage');
const settingsFile = () => path.join(env.appDir, 'settings.json');

beforeAll(async () => {
	wf = await import('../../src/lib/server/widgetFiles');
	usage = await import('../../src/lib/server/usage');
	fs.mkdirSync(env.appDir, { recursive: true });
});

describe('settings.json writer', () => {
	it('keeps unrelated keys, replaces claude profiles, writes UTF-8 without BOM', () => {
		const before = {
			accounts: { codex: { profiles: [{ id: 'default' }], selected: 'default', used_ids: ['default'] }, claude: { profiles: [{ id: 'old' }], selected: 'old', used_ids: ['old'] } },
			poll_interval_ms: 900000,
			placement_override: { screen_x: 10 },
			custom_theme_enabled: false,
			show_claude_code: false
		};
		fs.writeFileSync(settingsFile(), '﻿' + JSON.stringify(before), 'utf8'); // existing file WITH a BOM
		const kv = { id: 'kv', name: 'KV', config_dir: path.join(env.home, '.claude-kv') };
		const ba = { id: 'ba', name: 'BA', config_dir: path.join(env.home, '.claude-ba') };
		wf.writeSettings([kv, ba]);

		const raw = fs.readFileSync(settingsFile());
		expect([raw[0], raw[1], raw[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
		const s = JSON.parse(raw.toString('utf8'));
		expect(s.poll_interval_ms).toBe(900000);
		expect(s.placement_override).toEqual({ screen_x: 10 });
		expect(s.accounts.codex).toEqual(before.accounts.codex);
		expect(s.accounts.claude.profiles).toEqual([
			{ config_dir: kv.config_dir, credentials_path: '', enabled: true, id: 'kv', name: 'KV' },
			{ config_dir: ba.config_dir, credentials_path: '', enabled: true, id: 'ba', name: 'BA' }
		]);
		expect(s.accounts.claude.selected).toBe('kv');
		expect(s.accounts.claude.used_ids).toEqual(['old', 'kv', 'ba']); // ids ever used are kept
		expect(s.active_theme_path).toBe(path.join(env.appDir, 'themes', 'multi-claude-accounts.json'));
		expect(s.custom_theme_enabled).toBe(true);
		expect(s.show_claude_code).toBe(true);
		expect(fs.existsSync(`${settingsFile()}.bak-manager`)).toBe(true);
	});

	it('zero accounts -> empty profiles, selected ""', () => {
		wf.writeSettings([]);
		const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
		expect(s.accounts.claude.profiles).toEqual([]);
		expect(s.accounts.claude.selected).toBe('');
	});

	it('writes the close menu next to the theme', () => {
		wf.writeTheme([], 'dark');
		const menu = JSON.parse(fs.readFileSync(path.join(env.appDir, 'context-menus', 'close-menu.json'), 'utf8'));
		expect(menu.id).toBe('close-menu');
	});
});

describe('usage-cache matching', () => {
	const row = (id: string) => ({
		id,
		name: id,
		config_dir: path.join(env.home, `.claude-${id}`),
		email: null,
		plan: null,
		enabled: 1,
		sort_order: 0,
		created_at: '',
		updated_at: ''
	});
	const win = (pct: number, at: number) => ({ available: true, percentage: pct, resets_at: { secs_since_epoch: at, nanos_since_epoch: 0 } });

	it('matches data.accounts[] by source_path = <config_dir>\\.credentials.json (case/slash-insensitive)', () => {
		const kv = row('kv');
		const ba = row('ba');
		fs.writeFileSync(
			path.join(env.appDir, 'usage-cache.json'),
			JSON.stringify({
				updated_unix: 1790000000,
				data: {
					accounts: [
						{ provider: 'codex', source_path: path.join(kv.config_dir, '.credentials.json'), usage: { session: win(99, 1) } },
						{ provider: 'claude', source_path: path.join(kv.config_dir, '.credentials.json').toUpperCase().replace(/\\/g, '/'), usage: { session: win(42.5, 1790001000), weekly: win(71, 1790500000) }, error: null },
						{ provider: 'claude', source_path: path.join(env.home, '.claude-other', '.credentials.json'), usage: { session: win(5, 1) } }
					]
				}
			})
		);
		const u = usage.readUsage([kv, ba]);
		expect(u.updatedUnix).toBe(1790000000);
		expect(u.byId.kv).toEqual({ session: { percentage: 42.5, resetsAt: 1790001000 }, weekly: { percentage: 71, resetsAt: 1790500000 }, pollError: null });
		expect(u.byId.ba).toBeNull();
	});

	it('missing or broken cache -> no usage, no throw', () => {
		fs.writeFileSync(path.join(env.appDir, 'usage-cache.json'), '{not json');
		expect(usage.readUsage([row('kv')])).toEqual({ updatedUnix: null, byId: { kv: null } });
		fs.rmSync(path.join(env.appDir, 'usage-cache.json'));
		expect(usage.readUsage([row('kv')]).byId.kv).toBeNull();
	});
});
