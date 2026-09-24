// Drives the official Codex CLI for ChatGPT sign-in (docs/account-manager-contract.md, "Codex
// accounts"). We never call OpenAI OAuth endpoints: the CLI runs the whole exchange and its own
// callback server on 127.0.0.1:1455; we only (1) ask it for the authorize URL, (2) open that URL in
// an isolated Edge window (local) or show it as a link (server), (3) optionally replay the pasted
// `http://localhost:1455/auth/callback?...` address to the CLI's own callback server, (4) read
// `codex login status` + the id_token email from auth.json.
//
// Why `codex app-server` and not `codex login`: measured on codex-cli 0.142.5 (Windows), `codex
// login` IGNORES the BROWSER variable and opens the user's DEFAULT browser, which is usually signed
// in to ChatGPT already -- the login then completes by itself as whoever is signed in there. The
// app-server's `account/login/start {type:"chatgpt"}` starts the same CLI login server
// (localhost:1455/auth/callback) with open_browser=false and returns the URL instead.
import { execFile, execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { IS_WINDOWS, SERVER } from './paths';
import { LoginError, TMP_PREFIX, findEdge, killEdgeMatching, killTree, removeDir } from './claude';

const env = process.env;
const INIT_WAIT_MS = 30_000;
const SESSION_TTL_MS = 15 * 60_000;
/** A finished session stays readable this long, so a polling page sees the outcome. */
const FINISHED_TTL_MS = 5 * 60_000;
const CALLBACK_WAIT_MS = 30_000;
/** How often a waiting login checks whether the CLI has written new credentials to auth.json. */
const AUTH_WATCH_MS = 1000;

/** The CLI's fixed callback address (contract: host localhost/127.0.0.1, port 1455, path /auth/callback). */
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = '/auth/callback';

// ---------- CLI discovery ----------

let codexExe: string | null = null;
export function findCodex(): string {
	if (codexExe) return codexExe;
	// CODEX_BIN: explicit CLI path (tests point this at a fake CLI).
	const override = env.CODEX_BIN;
	if (override) {
		if (fs.existsSync(override)) return (codexExe = override);
		throw new Error(`CODEX_BIN points at ${override}, which does not exist.`);
	}
	if (!IS_WINDOWS) {
		for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
			const p = path.join(dir, 'codex');
			try {
				fs.accessSync(p, fs.constants.X_OK);
				return (codexExe = p);
			} catch {
				/* not here */
			}
		}
		throw new Error('The Codex CLI (codex) was not found on PATH. Install @openai/codex, or set CODEX_BIN.');
	}
	try {
		const hits = execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true })
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean);
		const pick = hits.find((h) => /\.exe$/i.test(h)) ?? hits.find((h) => /\.(cmd|bat)$/i.test(h));
		if (pick) return (codexExe = pick);
	} catch {
		/* not on PATH */
	}
	throw new Error('The Codex CLI (codex) was not found on PATH. Install it (npm i -g @openai/codex), or set CODEX_BIN.');
}

const isCmd = (exe: string) => /\.(cmd|bat)$/i.test(exe);

/**
 * Keep the login in CODEX_HOME/auth.json, never the OS keyring (the CLI's `auto` may pick one):
 * the widget and the server poller read that file. Passed on every CLI call.
 */
export const STORE_ARGS = ['-c', 'cli_auth_credentials_store=file'];

function spawnCodex(args: string[], codexHome: string, opts: SpawnOptions = {}): ChildProcess {
	const exe = findCodex();
	const o: SpawnOptions = { env: { ...env, CODEX_HOME: codexHome }, stdio: 'pipe', windowsHide: true, ...opts };
	args = [...STORE_ARGS, ...args];
	if (isCmd(exe)) return spawn('cmd.exe', ['/d', '/s', '/c', `"${exe}" ${args.join(' ')}`], { ...o, windowsVerbatimArguments: true });
	return spawn(exe, args, o);
}

// ---------- auth.json (never logged, never returned) ----------

export interface CodexAuthInfo {
	accessToken: string;
	accountId: string | null;
	email: string | null;
	plan: string | null;
}

/** Decodes a JWT's payload (no verification: it is our own CLI's file, read only for display). */
export function jwtPayload(token: unknown): Record<string, unknown> | null {
	if (typeof token !== 'string') return null;
	const part = token.split('.')[1];
	if (!part) return null;
	try {
		const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
		return v && typeof v === 'object' ? v : null;
	} catch {
		return null;
	}
}

/** codex.rs read_codex_credentials_at: tokens.access_token (non-blank) + account_id; email/plan from the id_token. */
export function readCodexAuth(codexHome: string): CodexAuthInfo | null {
	let j: { tokens?: Record<string, unknown> };
	try {
		j = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8').trimStart());
	} catch {
		return null;
	}
	const t = j?.tokens;
	const access = t?.access_token;
	if (typeof access !== 'string' || !access.trim()) return null;
	const claims = jwtPayload(t?.id_token);
	const auth = (claims?.['https://api.openai.com/auth'] ?? null) as Record<string, unknown> | null;
	return {
		accessToken: access,
		accountId: typeof t?.account_id === 'string' && t.account_id ? t.account_id : null,
		email: typeof claims?.email === 'string' && claims.email ? claims.email : null,
		plan: typeof auth?.chatgpt_plan_type === 'string' && auth.chatgpt_plan_type ? auth.chatgpt_plan_type : null
	};
}

// ---------- status ----------

export interface CodexAuthStatus {
	loggedIn: boolean;
	email: string | null;
	plan: string | null;
}

/**
 * `codex login status` (exit 0 "Logged in using ChatGPT" / exit 1 "Not logged in"), plus the email
 * and plan from auth.json's id_token. null = the CLI could not answer (missing, crashed, timeout).
 */
export function codexAuthStatusOrNull(codexHome: string): Promise<CodexAuthStatus | null> {
	return new Promise((resolve) => {
		let exe: string;
		try {
			exe = findCodex();
		} catch {
			return resolve(null);
		}
		execFile(
			isCmd(exe) ? 'cmd.exe' : exe,
			isCmd(exe) ? ['/d', '/c', exe, ...STORE_ARGS, 'login', 'status'] : [...STORE_ARGS, 'login', 'status'],
			{ env: { ...env, CODEX_HOME: codexHome }, timeout: 30_000, windowsHide: true, encoding: 'utf8' },
			(err, stdout, stderr) => {
				const out = `${stdout}\n${stderr}`;
				const code = (err as { code?: unknown } | null)?.code;
				let loggedIn: boolean;
				if (!err && /logged in/i.test(out) && !/not logged in/i.test(out)) loggedIn = true;
				else if (/not logged in/i.test(out) || (typeof code === 'number' && code === 1)) loggedIn = false;
				else return resolve(null);
				const info = loggedIn ? readCodexAuth(codexHome) : null;
				resolve({ loggedIn, email: info?.email ?? null, plan: info?.plan ?? null });
			}
		);
	});
}

// ---------- app-server JSON-RPC client ----------

type Notify = (method: string, params: Record<string, unknown>) => void;

/** Line-delimited JSON-RPC over the CLI's stdio (`codex app-server`, the protocol the IDE extension uses). */
export class AppServer {
	readonly proc: ChildProcess;
	private next = 0;
	private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	exited = false;
	stderr = '';

	constructor(codexHome: string, onNotify: Notify = () => undefined) {
		this.proc = spawnCodex(['app-server'], codexHome);
		const fail = (why: string) => {
			this.exited = true;
			for (const w of this.waiting.values()) w.reject(new Error(why));
			this.waiting.clear();
		};
		this.proc.on('exit', () => fail('The Codex CLI stopped.'));
		this.proc.on('error', (e) => fail(e.message));
		this.proc.stdin!.on('error', () => undefined);
		this.proc.stderr!.setEncoding('utf8').on('data', (d: string) => {
			this.stderr = (this.stderr + d).slice(-16_384);
		});
		readline.createInterface({ input: this.proc.stdout! }).on('line', (line) => {
			let m: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };
			try {
				m = JSON.parse(line);
			} catch {
				return; // not protocol output
			}
			if (typeof m.id === 'number' && this.waiting.has(m.id) && !m.method) {
				const w = this.waiting.get(m.id)!;
				this.waiting.delete(m.id);
				if (m.error) w.reject(new Error(typeof m.error.message === 'string' ? m.error.message : 'Codex returned an error.'));
				else w.resolve(m.result);
			} else if (typeof m.method === 'string') {
				onNotify(m.method, (m.params ?? {}) as Record<string, unknown>);
			}
		});
	}

	request<T>(method: string, params: unknown, timeoutMs = INIT_WAIT_MS): Promise<T> {
		if (this.exited) return Promise.reject(new Error('The Codex CLI stopped.'));
		const id = ++this.next;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(id);
				reject(new Error(`Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`));
			}, timeoutMs);
			this.waiting.set(id, {
				resolve: (v) => (clearTimeout(timer), resolve(v as T)),
				reject: (e) => (clearTimeout(timer), reject(e))
			});
			this.proc.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	async initialize(): Promise<void> {
		await this.request('initialize', { clientInfo: { name: 'claude_account_manager', title: 'Account Manager', version: '1' }, capabilities: null });
		this.proc.stdin!.write(`${JSON.stringify({ method: 'initialized' })}\n`);
	}

	/** Closing stdin ends the app-server; kill the tree if it lingers. */
	async close(graceMs = 2000): Promise<void> {
		try {
			this.proc.stdin!.end();
		} catch {
			/* already closed */
		}
		const deadline = Date.now() + graceMs;
		while (!this.exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (!this.exited) killTree(this.proc.pid);
	}
}

// ---------- login sessions (in memory only) ----------

export type CodexLoginState = 'waiting' | 'finishing' | 'done' | 'failed' | 'cancelled';

interface Session {
	id: string;
	accountId: string;
	configDir: string;
	client: AppServer;
	loginId: string;
	url: string;
	work: string;
	profileDir: string;
	edgeOpened: boolean;
	state: CodexLoginState;
	error: string;
	email: string | null;
	plan: string | null;
	timer: NodeJS.Timeout;
	cleaned: boolean;
	/** sha256 of auth.json when the login started (null = none): a different file means the CLI signed in. */
	authBefore: string | null;
	watch: NodeJS.Timeout | null;
	watching: boolean;
}

const sessions = new Map<string, Session>();

export interface CodexLoginDone {
	accountId: string;
	configDir: string;
	email: string | null;
	plan: string | null;
}
type DoneHandler = (d: CodexLoginDone) => Promise<void> | void;
let doneHandler: DoneHandler = () => undefined;
/** Registered by api.ts: store email/plan, forget cached status, poll usage (server). */
export function onCodexLogin(fn: DoneHandler): void {
	doneHandler = fn;
}

export function isCodexSession(sessionId: string): boolean {
	return sessions.has(sessionId);
}

export function activeCodexSessionFor(accountId: string): string | null {
	for (const s of sessions.values()) if (s.accountId === accountId && (s.state === 'waiting' || s.state === 'finishing')) return s.id;
	return null;
}

async function cleanup(s: Session): Promise<void> {
	if (s.cleaned) return;
	s.cleaned = true;
	clearTimeout(s.timer);
	if (s.watch) clearInterval(s.watch);
	await s.client.close();
	if (!SERVER) {
		await killEdgeMatching(s.profileDir);
		await new Promise((r) => setTimeout(r, 800));
	}
	await removeDir(s.work);
	// Keep the outcome readable for the polling page, then forget it.
	setTimeout(() => sessions.delete(s.id), FINISHED_TTL_MS).unref?.();
}

async function completed(s: Session, success: boolean, error: string | null): Promise<void> {
	if (s.state !== 'waiting') return; // cancelled, or already handled
	if (!success) {
		s.state = 'failed';
		s.error = `The Codex sign-in did not finish${error ? `: ${error.replace(/^Login server error:\s*/i, '')}` : ''}.`;
		await cleanup(s);
		return;
	}
	s.state = 'finishing';
	try {
		const st = await codexAuthStatusOrNull(s.configDir);
		if (!st?.loggedIn) throw new Error('Codex reported success, but `codex login status` says this folder is not logged in. Try Re-login.');
		s.email = st.email;
		s.plan = st.plan;
		await doneHandler({ accountId: s.accountId, configDir: s.configDir, email: st.email, plan: st.plan });
		s.state = 'done';
	} catch (e) {
		s.state = 'failed';
		s.error = (e as Error).message;
	}
	await cleanup(s);
}

function authFileHash(configDir: string): string | null {
	try {
		return crypto.createHash('sha256').update(fs.readFileSync(path.join(configDir, 'auth.json'))).digest('hex');
	} catch {
		return null;
	}
}

/**
 * Fallback for a CLI that signs in without sending `account/login/completed` (seen live: the
 * server-mode replay wrote auth.json, yet no notification arrived and the page timed out). New
 * credentials in auth.json that `codex login status` accepts mean the sign-in finished.
 */
async function checkAuthWritten(s: Session): Promise<void> {
	if (s.state !== 'waiting' || s.watching) return;
	const now = authFileHash(s.configDir);
	if (!now || now === s.authBefore) return;
	s.watching = true;
	try {
		const st = await codexAuthStatusOrNull(s.configDir);
		if (st?.loggedIn) {
			console.log(`[codex] ${s.accountId}: auth.json written without a login/completed notification; treating the sign-in as done`);
			await completed(s, true, null);
		}
	} finally {
		s.watching = false;
	}
}

export interface CodexStartResult {
	sessionId: string;
	url: string;
	edgeOpened: boolean;
	provider: 'codex';
}

export async function startCodexLogin(accountId: string, configDir: string): Promise<CodexStartResult> {
	// One CLI callback server per machine (port 1455): a second login would make the CLI cancel the
	// first. So any other waiting Codex login is cancelled here, whichever account it was for.
	for (const s of [...sessions.values()]) if (s.state === 'waiting') await cancelCodexLogin(s.id);

	fs.mkdirSync(configDir, { recursive: true });
	const authBefore = authFileHash(configDir);
	const id = crypto.randomUUID();
	const work = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}codex-`));
	let sessionRef: Session | null = null;
	const early: [boolean, string | null][] = [];
	const client = new AppServer(configDir, (method, params) => {
		// Method names only (params can carry account details): shows what this CLI version sends.
		console.log(`[codex] ${accountId}: app-server notification ${method}`);
		if (method !== 'account/login/completed') return;
		const ok = params.success === true;
		const err = typeof params.error === 'string' ? params.error : null;
		if (!sessionRef) early.push([ok, err]);
		else if (params.loginId === sessionRef.loginId || params.loginId == null) void completed(sessionRef, ok, err);
	});
	let loginId = '';
	let url = '';
	try {
		await client.initialize();
		const r = await client.request<{ type?: string; loginId?: unknown; authUrl?: unknown }>('account/login/start', { type: 'chatgpt' });
		loginId = typeof r?.loginId === 'string' ? r.loginId : '';
		url = typeof r?.authUrl === 'string' ? r.authUrl : '';
		if (!loginId || !/^https:\/\/[^\s"<>]+$/.test(url)) throw new Error('Codex did not return a sign-in link.');
	} catch (e) {
		const why = (e as Error).message;
		await client.close(500);
		await removeDir(work);
		throw new LoginError(`Could not start the Codex login: ${why}`, 502);
	}
	const s: Session = {
		id,
		accountId,
		configDir,
		client,
		loginId,
		url,
		work,
		profileDir: path.join(work, 'edge-profile'),
		edgeOpened: false,
		state: 'waiting',
		error: '',
		email: null,
		plan: null,
		timer: setTimeout(() => void cancelCodexLogin(id), SESSION_TTL_MS),
		cleaned: false,
		authBefore,
		watch: null,
		watching: false
	};
	s.watch = setInterval(() => void checkAuthWritten(s), AUTH_WATCH_MS);
	s.watch.unref?.();
	sessions.set(id, s);
	sessionRef = s;
	for (const [ok, err] of early) void completed(s, ok, err);
	client.proc.on('exit', () => {
		if (s.state === 'waiting') {
			s.state = 'failed';
			s.error = 'The Codex CLI stopped before the sign-in finished. Click Re-login to try again.';
			void cleanup(s);
		}
	});

	const edge = findEdge();
	if (edge) {
		// Fresh --user-data-dir: no cookies, no ChatGPT session shared with the user's own browser.
		// The redirect to localhost:1455 lands on the CLI's own server, so this completes by itself.
		const child = spawn(edge, [`--user-data-dir=${s.profileDir}`, '--no-first-run', '--inprivate', url], {
			detached: true,
			stdio: 'ignore',
			windowsHide: false
		});
		child.on('error', () => (s.edgeOpened = false));
		child.unref();
		s.edgeOpened = true;
	}
	return { sessionId: id, url, edgeOpened: s.edgeOpened, provider: 'codex' };
}

export interface CodexSessionStatus {
	state: CodexLoginState;
	error: string;
	email: string | null;
	plan: string | null;
	accountId: string;
}

export function codexSessionStatus(sessionId: string): CodexSessionStatus | null {
	const s = sessions.get(sessionId);
	if (!s) return null;
	return { state: s.state, error: s.error, email: s.email, plan: s.plan, accountId: s.accountId };
}

/**
 * The pasted address must be the CLI's own callback: http, host localhost or 127.0.0.1, port 1455,
 * path /auth/callback, with a state and a code (or an OAuth error). Returns the query to replay.
 * The replay target is ALWAYS our own constant http://127.0.0.1:1455 -- never the pasted host.
 */
export function callbackQuery(raw: unknown): string {
	const text = typeof raw === 'string' ? raw.trim() : '';
	const bad = () =>
		new LoginError('Paste the full address from the browser, starting with http://localhost:1455/auth/callback?');
	if (!text) throw bad();
	if (text.length > 8192 || /[\s\u0000-\u001f]/.test(text)) throw bad();
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		throw bad();
	}
	const hostOk = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
	if (u.protocol !== 'http:' || !hostOk || u.port !== String(CALLBACK_PORT) || u.pathname !== CALLBACK_PATH || u.username || u.password)
		throw bad();
	if (!u.searchParams.get('state') || !(u.searchParams.get('code') || u.searchParams.get('error'))) throw bad();
	return u.search;
}

export interface CodexCallbackResult {
	ok: boolean;
	message: string;
	email: string | null;
	plan: string | null;
	accountId: string;
}

async function waitSettled(s: Session, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while ((s.state === 'waiting' || s.state === 'finishing') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
}

function resultOf(s: Session): CodexCallbackResult {
	if (s.state === 'done') return { ok: true, message: 'Login successful', email: s.email, plan: s.plan, accountId: s.accountId };
	return { ok: false, message: s.error || 'The Codex sign-in did not finish.', email: null, plan: null, accountId: s.accountId };
}

/** Server mode (and local fallback): replay the pasted callback address to the waiting CLI. */
export async function submitCodexCallback(sessionId: string, rawUrl: unknown, fetchImpl: typeof fetch = fetch): Promise<CodexCallbackResult> {
	const s = sessions.get(sessionId);
	if (!s)
		throw new LoginError(
			'This login session no longer exists (it expired, was cancelled, or the manager restarted). Click Re-login to start again.',
			410
		);
	// Already finished by itself (local: the Edge window reached the CLI first): report that outcome.
	if (s.state === 'done' || s.state === 'failed' || s.state === 'finishing') {
		await waitSettled(s, CALLBACK_WAIT_MS);
		return resultOf(s);
	}
	if (s.state !== 'waiting') throw new LoginError('This login was cancelled. Click Re-login to start again.', 410);
	const query = callbackQuery(rawUrl);
	let status = 0;
	let body = '';
	try {
		const res = await fetchImpl(`http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}${query}`, {
			method: 'GET',
			redirect: 'manual',
			signal: AbortSignal.timeout(20_000)
		});
		status = res.status;
		body = (await res.text().catch(() => '')).slice(0, 300);
	} catch {
		// The CLI may already have finished and closed its server: the notification decides below.
	}
	// An error page can be the CLI's final answer (e.g. the token exchange failed): its
	// login/completed notification follows a moment later, so give it that moment.
	if (status >= 400) await waitSettled(s, 1500);
	if (status >= 400 && s.state === 'waiting') {
		// e.g. 400 "State mismatch": an address from an older or different sign-in. The CLI keeps waiting.
		const why = /state mismatch/i.test(body)
			? 'That address belongs to a different or older sign-in. Use the link above, sign in, and paste the new address.'
			: `The Codex CLI refused that address (HTTP ${status}).`;
		return { ok: false, message: why, email: null, plan: null, accountId: s.accountId };
	}
	await waitSettled(s, CALLBACK_WAIT_MS);
	if (s.state === 'waiting') return { ok: false, message: 'Codex did not finish within 30 seconds. Paste the address again, or click Re-login.', email: null, plan: null, accountId: s.accountId };
	return resultOf(s);
}

export async function cancelCodexLogin(sessionId: string): Promise<boolean> {
	const s = sessions.get(sessionId);
	if (!s) return false;
	if (s.state === 'waiting' || s.state === 'finishing') {
		s.state = 'cancelled';
		// Frees port 1455 (the CLI answers "canceled" and closes its server), then the process ends.
		await s.client.request('account/login/cancel', { loginId: s.loginId }, 5000).catch(() => undefined);
	}
	await cleanup(s);
	sessions.delete(sessionId);
	return true;
}

// ---------- token refresh (server poller) ----------

/**
 * The widget refreshes a rejected Codex token by running the CLI (codex.rs cli_refresh_codex_token)
 * and never calls the OAuth endpoint itself. We do the same through the CLI's own
 * `account/read {refreshToken: true}` (a token refresh, no model request). Killed after 30 s.
 */
export async function refreshCodexTokenViaCli(codexHome: string, timeoutMs = 30_000): Promise<void> {
	let client: AppServer;
	try {
		client = new AppServer(codexHome);
	} catch {
		return;
	}
	try {
		await client.initialize();
		await client.request('account/read', { refreshToken: true }, timeoutMs);
	} catch {
		/* refresh failed: the caller re-reads auth.json and reports token_expired / auth_required */
	} finally {
		await client.close(1000);
	}
}
