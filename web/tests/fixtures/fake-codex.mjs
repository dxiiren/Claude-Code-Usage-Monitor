// Stand-in for the Codex CLI in tests (CODEX_BIN points at fake-codex.cmd / fake-codex.sh).
// Mimics what the manager drives, with the shapes measured on codex-cli 0.142.5:
//   login status  -> "Logged in using ChatGPT" (exit 0) / "Not logged in" (exit 1), from $CODEX_HOME/auth.json
//   app-server    -> line-delimited JSON-RPC on stdio:
//     initialize, account/login/start {type:"chatgpt"}, account/login/cancel, account/read {refreshToken}
//     account/login/start opens a REAL callback server on 127.0.0.1:1455 (like the CLI):
//       GET /auth/callback?state=<wrong>          -> 400 "State mismatch" (keeps waiting)
//       GET /auth/callback?code=good&state=<s>    -> auth.json for <folder-id>@example.com, 200, notify success
//       GET /auth/callback?code=good:<email>&...  -> same, as <email>
//       GET /auth/callback?code=noemail&...       -> auth.json whose id_token has no email
//       GET /auth/callback?code=<other>&...       -> 500, notify failure ("token exchange failed")
//     CODEX_HOME basename containing "autologin": completes by itself after 0.8 s (the isolated Edge
//     window reaching the callback on its own, as it does locally).
//     account/read {refreshToken:true}: logs "refresh" to refresh.log; if fake-refresh.json exists
//     ({"accessToken": "..."}) rewrites auth.json's access token with it.
//   Stdin closed -> exit 0 (as the real app-server does).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

// `-c key=value` config overrides come first (the manager passes cli_auth_credentials_store=file).
const raw = process.argv.slice(2);
const config = [];
while (raw[0] === '-c') config.push(raw.splice(0, 2)[1]);
const args = raw;
if (process.env.FAKE_CODEX_ARGS_LOG) fs.appendFileSync(process.env.FAKE_CODEX_ARGS_LOG, `${JSON.stringify({ config, args })}\n`);
const home = process.env.CODEX_HOME;
const PORT = 1455;

if (args[0] === '--version') {
	console.log('codex-cli 0.0.0-fake');
	process.exit(0);
}
if (!home) {
	console.error('fake-codex: CODEX_HOME is required');
	process.exit(2);
}
const authFile = path.join(home, 'auth.json');
const folderId = path.basename(home).replace(/^\.codex-/, '');

function readAuth() {
	try {
		return JSON.parse(fs.readFileSync(authFile, 'utf8'));
	} catch {
		return null;
	}
}

if (args[0] === 'login' && args[1] === 'status') {
	fs.mkdirSync(path.join(home, 'tmp'), { recursive: true }); // the real CLI creates it too
	const a = readAuth();
	if (a?.tokens?.access_token) {
		console.error('Logged in using ChatGPT');
		process.exit(0);
	}
	console.error('Not logged in');
	process.exit(1);
}

if (args[0] !== 'app-server') {
	console.error(`fake-codex: unsupported command ${args.join(' ')}`);
	process.exit(2);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.sig`;

function writeAuth(email) {
	fs.mkdirSync(home, { recursive: true });
	const who = email ?? `${folderId}@example.com`;
	const claims = { 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: `acct-${who}` } };
	if (email !== null) claims.email = who;
	fs.writeFileSync(
		authFile,
		JSON.stringify({
			auth_mode: 'chatgpt',
			OPENAI_API_KEY: null,
			// Fake tokens: the fake usage server keys on "fake-codex-<email>".
			tokens: { id_token: jwt(claims), access_token: `fake-codex-${who}`, refresh_token: 'fake-refresh', account_id: `acct-${who}` },
			last_refresh: new Date().toISOString()
		})
	);
}

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let login = null; // { id, state, server }

function finish(success, error) {
	if (!login) return;
	const { id, server } = login;
	login = null;
	server.close();
	server.closeAllConnections?.();
	send({ method: 'account/login/completed', params: { loginId: id, success, error } });
}

function startLogin(reqId) {
	const state = crypto.randomBytes(12).toString('base64url');
	const id = crypto.randomUUID();
	const server = http.createServer((req, res) => {
		const u = new URL(req.url, `http://localhost:${PORT}`);
		if (u.pathname !== '/auth/callback') {
			res.writeHead(404);
			return res.end('Not Found');
		}
		if (u.searchParams.get('state') !== state) {
			res.writeHead(400, { 'content-type': 'text/plain' });
			return res.end('State mismatch');
		}
		const code = u.searchParams.get('code') ?? '';
		if (code.startsWith('good') || code === 'noemail') {
			writeAuth(code === 'noemail' ? null : code.includes(':') ? code.slice(code.indexOf(':') + 1) : undefined);
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end('<p>Signed in to Codex. You can close this window.</p>');
			return finish(true, null);
		}
		res.writeHead(500, { 'content-type': 'text/plain' });
		res.end('Token exchange failed');
		finish(false, 'Login server error: token exchange failed');
	});
	server.on('error', (e) => send({ id: reqId, error: { code: -32000, message: `failed to start login server: ${e.message}` } }));
	server.listen(PORT, '127.0.0.1', () => {
		login = { id, state, server };
		const redirect = encodeURIComponent(`http://localhost:${PORT}/auth/callback`);
		const authUrl = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=fake&redirect_uri=${redirect}&scope=openid&state=${state}&originator=codex_cli_rs`;
		send({ id: reqId, result: { type: 'chatgpt', loginId: id, authUrl } });
		if (/autologin/i.test(path.basename(home)))
			setTimeout(() => {
				if (login?.id === id) {
					writeAuth(undefined);
					finish(true, null);
				}
			}, 800);
	});
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	const { id, method, params } = m;
	if (method === 'initialize') return send({ id, result: { userAgent: 'fake-codex/0.0.0', codexHome: home } });
	if (method === 'initialized') return;
	if (method === 'account/login/start') {
		if (params?.type !== 'chatgpt') return send({ id, error: { code: -32600, message: 'unsupported login type' } });
		if (login) finish(false, 'Login was not completed');
		return startLogin(id);
	}
	if (method === 'account/login/cancel') {
		const found = login && login.id === params?.loginId;
		if (found) finish(false, 'Login was not completed');
		return send({ id, result: { status: found ? 'canceled' : 'notFound' } });
	}
	if (method === 'account/read') {
		if (params?.refreshToken) {
			fs.appendFileSync(path.join(home, 'refresh.log'), 'refresh\n');
			try {
				const next = JSON.parse(fs.readFileSync(path.join(home, 'fake-refresh.json'), 'utf8'));
				const a = readAuth();
				if (a?.tokens) {
					a.tokens.access_token = next.accessToken;
					fs.writeFileSync(authFile, JSON.stringify(a));
				}
			} catch {
				/* refresh "failed": auth.json unchanged */
			}
		}
		const a = readAuth();
		return send({ id, result: { account: a ? { type: 'chatgpt', email: null, planType: 'plus' } : null, requiresOpenaiAuth: true } });
	}
	if (id !== undefined) send({ id, error: { code: -32601, message: `fake-codex: unsupported method ${method}` } });
});
process.stdin.on('end', () => {
	if (login) finish(false, 'Login was not completed');
	process.exit(0);
});
