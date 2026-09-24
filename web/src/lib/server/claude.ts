// Drives the official Claude Code CLI. Port of kit/UsageKit.psm1 Invoke-AccountLogin /
// Get-AccountAuth. We never call Anthropic OAuth endpoints: the CLI does the whole exchange,
// we only (1) catch the login URL via BROWSER, (2) open it in an isolated Edge window,
// (3) feed the pasted code to the CLI's stdin, (4) read `claude auth status`.
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IS_WINDOWS, SERVER } from './paths';

const env = process.env;
/** Our own temp prefix (the PowerShell kit uses a different one), so the startup sweep only touches ours. */
const TMP_PREFIX = 'claude-acctmgr-login-';
const URL_WAIT_MS = 30_000;
const CODE_WAIT_MS = 60_000;
const SESSION_TTL_MS = 15 * 60_000;

// ---------- CLI + Edge discovery ----------

let claudeExe: string | null = null;
export function findClaude(): string {
	if (claudeExe) return claudeExe;
	// CLAUDE_BIN / CLAUDE_EXE: explicit CLI path (tests point this at a fake CLI).
	const override = env.CLAUDE_BIN || env.CLAUDE_EXE;
	if (override) {
		if (fs.existsSync(override)) return (claudeExe = override);
		throw new Error(`CLAUDE_BIN points at ${override}, which does not exist.`);
	}
	if (!IS_WINDOWS) {
		// Linux (the server image): scan PATH, no shell involved.
		for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
			const p = path.join(dir, 'claude');
			try {
				fs.accessSync(p, fs.constants.X_OK);
				return (claudeExe = p);
			} catch {
				/* not here */
			}
		}
		throw new Error('Claude Code (claude) was not found on PATH. Install it, or set CLAUDE_BIN.');
	}
	try {
		const hits = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true })
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
		const pick = hits.find((h) => /\.exe$/i.test(h)) ?? hits.find((h) => /\.(cmd|bat)$/i.test(h));
		if (pick) return (claudeExe = pick);
	} catch {
		/* not on PATH */
	}
	const guess = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
	if (fs.existsSync(guess)) return (claudeExe = guess);
	throw new Error('Claude Code (claude) was not found on PATH. Install it, or set CLAUDE_EXE.');
}

function spawnClaude(args: string[], extraEnv: Record<string, string>): ChildProcess {
	const exe = findClaude();
	const opts: SpawnOptions = { env: { ...env, ...extraEnv }, stdio: 'pipe', windowsHide: true };
	if (/\.(cmd|bat)$/i.test(exe)) {
		return spawn('cmd.exe', ['/d', '/s', '/c', `"${exe}" ${args.join(' ')}`], { ...opts, windowsVerbatimArguments: true });
	}
	return spawn(exe, args, opts);
}

export function findEdge(): string | null {
	if (SERVER) return null; // the user opens the link in their own browser
	// EDGE_EXE: explicit msedge.exe path, or "none" to never open a window (tests).
	if (env.EDGE_EXE) return env.EDGE_EXE.toLowerCase() === 'none' ? null : env.EDGE_EXE;
	const candidates = [
		env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)']!, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
		env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
		env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
	].filter(Boolean) as string[];
	return candidates.find((p) => fs.existsSync(p)) ?? null;
}

// ---------- auth status ----------

export interface AuthStatus {
	loggedIn: boolean;
	email: string | null;
	plan: string | null;
}

/** Like authStatus, but null when the CLI could not answer (missing, crashed, unparseable output). */
export async function authStatusOrNull(configDir: string): Promise<AuthStatus | null> {
	const r = await authStatusRaw(configDir);
	return r;
}

export async function authStatus(configDir: string): Promise<AuthStatus> {
	return (await authStatusRaw(configDir)) ?? { loggedIn: false, email: null, plan: null };
}

function authStatusRaw(configDir: string): Promise<AuthStatus | null> {
	return new Promise((resolve) => {
		let exe: string;
		try {
			exe = findClaude();
		} catch {
			return resolve(null);
		}
		const isCmd = /\.(cmd|bat)$/i.test(exe);
		execFile(
			isCmd ? 'cmd.exe' : exe,
			isCmd ? ['/d', '/c', exe, 'auth', 'status'] : ['auth', 'status'],
			{ env: { ...env, CLAUDE_CONFIG_DIR: configDir }, timeout: 30_000, windowsHide: true, encoding: 'utf8' },
			(_err, stdout) => {
				// `auth status` exits non-zero when logged out but still prints JSON.
				try {
					const s = String(stdout);
					const j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
					resolve({
						loggedIn: !!j.loggedIn,
						email: typeof j.email === 'string' ? j.email : null,
						plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : null
					});
				} catch {
					resolve(null);
				}
			}
		);
	});
}

// ---------- process cleanup ----------

function killTree(pid: number | undefined): void {
	if (!pid) return;
	if (!IS_WINDOWS) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
		return;
	}
	try {
		execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
	} catch {
		/* already gone */
	}
}

/** Kill every msedge.exe whose command line contains `match` (the throwaway profile dir). */
function killEdgeMatching(match: string): Promise<void> {
	if (SERVER || !IS_WINDOWS) return Promise.resolve(); // no Edge is ever opened there
	return new Promise((resolve) => {
		execFile(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				"Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" -ErrorAction SilentlyContinue | " +
					'Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($env:ACCTMGR_KILL_MATCH, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ' +
					'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
			],
			{ env: { ...env, ACCTMGR_KILL_MATCH: match }, windowsHide: true, timeout: 20_000 },
			() => resolve()
		);
	});
}

async function removeDir(dir: string): Promise<void> {
	for (let i = 0; i < 5; i++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			if (!fs.existsSync(dir)) return;
		} catch {
			/* Edge may still hold a file for a moment */
		}
		await new Promise((r) => setTimeout(r, 400));
	}
}

/** Startup: close Edge windows / temp dirs left by a login that was running when the server stopped. */
export async function sweepStaleLogins(): Promise<void> {
	const tmp = os.tmpdir();
	let stale: string[] = [];
	try {
		stale = fs.readdirSync(tmp).filter((n) => n.startsWith(TMP_PREFIX));
	} catch {
		return;
	}
	if (stale.length === 0) return;
	if (!SERVER) {
		await killEdgeMatching(TMP_PREFIX);
		await new Promise((r) => setTimeout(r, 800));
	}
	for (const n of stale) await removeDir(path.join(tmp, n));
}

// ---------- login sessions (in memory only) ----------

export type LoginState = 'waiting' | 'submitting' | 'done' | 'failed' | 'cancelled';

interface Session {
	id: string;
	accountId: string;
	configDir: string;
	proc: ChildProcess;
	work: string;
	profileDir: string;
	url: string;
	edgeOpened: boolean;
	stdout: string;
	stderr: string;
	exited: boolean;
	state: LoginState;
	timer: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();

export class LoginError extends Error {
	constructor(
		message: string,
		public status = 400
	) {
		super(message);
	}
}

export function activeSessionFor(accountId: string): string | null {
	for (const s of sessions.values()) if (s.accountId === accountId && s.state === 'waiting') return s.id;
	return null;
}

async function cleanup(s: Session): Promise<void> {
	clearTimeout(s.timer);
	if (!s.exited) killTree(s.proc.pid);
	if (!SERVER) {
		await killEdgeMatching(s.profileDir);
		await new Promise((r) => setTimeout(r, 800));
	}
	await removeDir(s.work);
	sessions.delete(s.id);
}

function cap(buf: string, add: string): string {
	const out = buf + add;
	return out.length > 65_536 ? out.slice(-65_536) : out;
}

export interface StartResult {
	sessionId: string;
	url: string;
	edgeOpened: boolean;
}

export async function startLogin(accountId: string, configDir: string): Promise<StartResult> {
	const existing = activeSessionFor(accountId);
	if (existing) await cancelLogin(existing);

	fs.mkdirSync(configDir, { recursive: true });
	const id = crypto.randomUUID();
	const work = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
	const urlFile = path.join(work, 'url.txt');
	// BROWSER only records the URL: the CLI must never open the default (signed-in) browser,
	// and on a server there is no browser at all.
	const browser = path.join(work, IS_WINDOWS ? 'browser.cmd' : 'browser.sh');
	if (IS_WINDOWS) fs.writeFileSync(browser, `@echo %* > "${urlFile}"\r\n`, { encoding: 'latin1' });
	else fs.writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$*" > "$ACCTMGR_URL_FILE"\n`, { mode: 0o700 });

	const proc = spawnClaude(['auth', 'login', '--claudeai'], {
		BROWSER: browser,
		CLAUDE_CONFIG_DIR: configDir,
		ACCTMGR_URL_FILE: urlFile // read by browser.sh (no path quoting inside the script)
	});
	const s: Session = {
		id,
		accountId,
		configDir,
		proc,
		work,
		profileDir: path.join(work, 'edge-profile'),
		url: '',
		edgeOpened: false,
		stdout: '',
		stderr: '',
		exited: false,
		state: 'waiting',
		timer: setTimeout(() => void cancelLogin(id), SESSION_TTL_MS)
	};
	sessions.set(id, s);
	proc.stdout!.setEncoding('utf8').on('data', (d: string) => (s.stdout = cap(s.stdout, d)));
	proc.stderr!.setEncoding('utf8').on('data', (d: string) => (s.stderr = cap(s.stderr, d)));
	proc.on('exit', () => (s.exited = true));
	proc.on('error', (e) => {
		s.exited = true;
		s.stderr = cap(s.stderr, `\n${e.message}`);
	});
	proc.stdin!.on('error', () => {
		/* CLI exited before we wrote: reported via exit state */
	});

	const deadline = Date.now() + URL_WAIT_MS;
	let url = '';
	if (SERVER) {
		// The URL the CLI hands to BROWSER redirects to http://localhost:<port>/callback: that only
		// works in a browser on THIS machine. The one it prints ("If the browser didn't open, visit:")
		// uses the hosted callback page that shows a code to paste, which works from any device.
		let browserUrl = '';
		let browserSeenAt = 0;
		while (Date.now() < deadline && !url) {
			await new Promise((r) => setTimeout(r, 250));
			const printed = (s.stdout.match(/https:\/\/\S+/g) ?? []).find((u) => !isLocalCallback(u));
			if (printed) url = printed;
			else if (!browserUrl && fs.existsSync(urlFile)) {
				browserUrl = fs.readFileSync(urlFile, 'latin1').replace(/"/g, '').trim();
				browserSeenAt = Date.now();
			}
			// A CLI that never prints a link: use BROWSER's, unless it is a localhost callback.
			if (!url && browserUrl && !isLocalCallback(browserUrl) && Date.now() - browserSeenAt > 3000) url = browserUrl;
			if (!url && s.exited) break;
		}
	} else {
		while (Date.now() < deadline && !url) {
			await new Promise((r) => setTimeout(r, 250));
			if (fs.existsSync(urlFile)) url = fs.readFileSync(urlFile, 'latin1').replace(/"/g, '').trim();
			if (!url) url = s.stdout.match(/https:\/\/\S+/)?.[0] ?? '';
			if (!url && s.exited) break;
		}
	}
	if (!/^https:\/\/[^\s"<>]+$/.test(url)) {
		const why = failureReason(s) || 'Claude Code never produced a login link.';
		s.state = 'failed';
		await cleanup(s);
		throw new LoginError(`Could not start the login: ${why}`, 502);
	}
	s.url = url;

	const edge = findEdge();
	if (edge) {
		// Fresh --user-data-dir: no cookies, no shared InPrivate session with anything else.
		const child = spawn(edge, [`--user-data-dir=${s.profileDir}`, '--no-first-run', '--inprivate', url], {
			detached: true,
			stdio: 'ignore',
			windowsHide: false
		});
		child.on('error', () => (s.edgeOpened = false));
		child.unref();
		s.edgeOpened = true;
	}
	return { sessionId: id, url, edgeOpened: s.edgeOpened };
}

/** True for an OAuth URL whose redirect_uri is a loopback callback (unusable from another device). */
export function isLocalCallback(url: string): boolean {
	try {
		const r = new URL(url).searchParams.get('redirect_uri');
		if (!r) return false;
		const h = new URL(r).hostname;
		return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
	} catch {
		return false;
	}
}

/** Last meaningful CLI lines, without links or prompts. Never includes tokens (the CLI prints none). */
function failureReason(s: Session): string {
	const lines = `${s.stderr}\n${s.stdout}`
		// strip ANSI escape codes
		.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
		.split(/\r?\n/)
		.map((l) => l.replace(/Paste code here if prompted >\s*/g, '').trim())
		.filter((l) => l && !/https:\/\/|Opening browser|Browser didn't open|use the url below/i.test(l));
	return lines.slice(-2).join(' ');
}

export interface SubmitResult {
	ok: boolean;
	message: string;
	accountId: string;
	configDir: string;
}

export async function submitCode(sessionId: string, rawCode: unknown): Promise<SubmitResult> {
	const s = sessions.get(sessionId);
	if (!s)
		throw new LoginError(
			'This login session no longer exists (it expired, was cancelled, or the manager restarted). Click Re-login to start again.',
			410
		);
	if (s.state !== 'waiting') throw new LoginError('This login is already being processed.', 409);
	const code = typeof rawCode === 'string' ? rawCode.trim() : '';
	if (!code) throw new LoginError('Paste the code shown after you click Authorize.');
	if (code.length > 4000 || /[\r\n]/.test(code)) throw new LoginError('That does not look like an authentication code.');
	if (s.exited) {
		const why = failureReason(s);
		s.state = 'failed';
		await cleanup(s);
		throw new LoginError(`The Claude Code login already stopped${why ? `: ${why}` : ''}. Click Re-login to try again.`, 410);
	}

	s.state = 'submitting';
	s.proc.stdin!.write(`${code}\r\n`);
	const deadline = Date.now() + CODE_WAIT_MS;
	while (!s.exited && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250));
		if (/Login successful/i.test(s.stdout)) {
			// give it a moment to finish writing credentials and exit on its own
			const grace = Date.now() + 5000;
			while (!s.exited && Date.now() < grace) await new Promise((r) => setTimeout(r, 200));
			break;
		}
	}
	const ok = /Login successful/i.test(s.stdout);
	const timedOut = !s.exited && !ok;
	const why = failureReason(s);
	s.state = ok ? 'done' : 'failed';
	await cleanup(s);
	if (ok) return { ok, message: 'Login successful', accountId: s.accountId, configDir: s.configDir };
	return {
		ok,
		message: timedOut
			? 'Claude Code did not finish within 60 seconds. Click Re-login to try again.'
			: `Login failed: ${why.replace(/^Login failed:\s*/i, '') || 'the code was rejected or expired'}`,
		accountId: s.accountId,
		configDir: s.configDir
	};
}

export async function cancelLogin(sessionId: string): Promise<boolean> {
	const s = sessions.get(sessionId);
	if (!s) return false;
	s.state = 'cancelled';
	await cleanup(s);
	return true;
}

// ---------- token refresh (server poller) ----------

/**
 * Port of the widget's cli_refresh_windows_token (src/poller/claude.rs): run `claude -p .` with
 * CLAUDE_CONFIG_DIR set and let the CLI refresh its own token. We never call the OAuth token
 * endpoint ourselves. Output is discarded (never logged); killed after 30 s like the widget.
 */
export function refreshTokenViaCli(configDir: string, timeoutMs = 30_000): Promise<void> {
	return new Promise((resolve) => {
		let exe: string;
		try {
			exe = findClaude();
		} catch {
			return resolve();
		}
		const childEnv: NodeJS.ProcessEnv = { ...env, CLAUDE_CONFIG_DIR: configDir };
		delete childEnv.CLAUDECODE;
		delete childEnv.CLAUDE_CODE_ENTRYPOINT;
		const isCmd = /\.(cmd|bat)$/i.test(exe);
		let child: ChildProcess;
		try {
			child = isCmd
				? spawn('cmd.exe', ['/d', '/s', '/c', `"${exe}" -p .`], {
						env: childEnv,
						stdio: 'ignore',
						windowsHide: true,
						windowsVerbatimArguments: true
					})
				: spawn(exe, ['-p', '.'], { env: childEnv, stdio: 'ignore', windowsHide: true });
		} catch {
			return resolve();
		}
		const timer = setTimeout(() => killTree(child.pid), timeoutMs);
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		child.on('exit', done);
		child.on('error', done);
	});
}
