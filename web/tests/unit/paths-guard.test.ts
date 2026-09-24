import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkRequest } from '../../src/lib/server/guard';
import { isolateHome } from './helpers';

const env = isolateHome();
let isDeletableConfigDir: (d: string) => boolean;
let pathKey: (p: string) => string;

beforeAll(async () => {
	({ isDeletableConfigDir, pathKey } = await import('../../src/lib/server/paths'));
});

describe('Origin / Host guard', () => {
	const P = 47291;
	it('allows same-origin mutations and plain reads', () => {
		expect(checkRequest('POST', '127.0.0.1:47291', 'http://127.0.0.1:47291', P)).toEqual({ action: 'allow' });
		expect(checkRequest('GET', '127.0.0.1:47291', null, P)).toEqual({ action: 'allow' });
	});
	it('rejects a foreign or missing Origin on every mutating method', () => {
		for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(checkRequest(m, '127.0.0.1:47291', 'https://evil.example', P)).toEqual({ action: 'deny', reason: 'origin' });
			expect(checkRequest(m, '127.0.0.1:47291', null, P)).toEqual({ action: 'deny', reason: 'origin' });
			expect(checkRequest(m, '127.0.0.1:47291', 'http://localhost:47291', P)).toEqual({ action: 'deny', reason: 'origin' });
			expect(checkRequest(m, '127.0.0.1:47291', 'http://127.0.0.1:5173', P)).toEqual({ action: 'deny', reason: 'origin' });
		}
	});
	it('rejects a rebinding Host, redirects localhost reads to 127.0.0.1', () => {
		expect(checkRequest('GET', 'evil.example:47291', null, P)).toEqual({ action: 'deny', reason: 'host' });
		expect(checkRequest('POST', 'evil.example:47291', 'http://evil.example:47291', P)).toEqual({ action: 'deny', reason: 'host' });
		expect(checkRequest('GET', 'localhost:47291', null, P, '/usage?x=1')).toEqual({ action: 'redirect', location: 'http://127.0.0.1:47291/usage?x=1' });
		expect(checkRequest('POST', 'localhost:47291', 'http://localhost:47291', P)).toEqual({ action: 'deny', reason: 'host' });
	});
});

describe('folder deletion guard', () => {
	it('refuses %USERPROFILE%\\.claude itself', () => {
		expect(isDeletableConfigDir(path.join(env.home, '.claude'))).toBe(false);
		expect(isDeletableConfigDir(path.join(env.home, '.CLAUDE'))).toBe(false);
		expect(isDeletableConfigDir(path.join(env.home, '.claude') + path.sep)).toBe(false);
	});
	it('allows only a direct %USERPROFILE%\\.claude-<id> child', () => {
		expect(isDeletableConfigDir(path.join(env.home, '.claude-kv'))).toBe(true);
		expect(isDeletableConfigDir(path.join(env.home, '.claude-kv', 'sub'))).toBe(false);
		expect(isDeletableConfigDir(path.join(env.home, '.claude-kv', '..', '.claude'))).toBe(false);
		expect(isDeletableConfigDir(path.join(env.home, '.claude.json'))).toBe(false);
		expect(isDeletableConfigDir(path.join(env.home, '.claude-'))).toBe(false);
		expect(isDeletableConfigDir(path.join(env.home, 'Documents'))).toBe(false);
		expect(isDeletableConfigDir(path.join(env.root, '.claude-kv'))).toBe(false);
		expect(isDeletableConfigDir(path.join(env.home, '.claude-a b'))).toBe(false);
	});
	it('pathKey normalises case, slashes, trailing separator and the \\\\?\\ prefix', () => {
		expect(pathKey('\\\\?\\C:\\Users\\Me\\.claude-kv\\')).toBe(pathKey('c:/users/me/.claude-kv'));
	});
});
