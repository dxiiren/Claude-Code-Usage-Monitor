// Stand-in for the Claude Code CLI in e2e tests (CLAUDE_BIN points at fake-claude.cmd).
// Mimics the two commands the manager drives:
//   auth login --claudeai : hands a URL to $BROWSER, prompts, reads one line from stdin.
//       "good"            -> Login successful, email <folder-name>@example.com
//       "good:<email>"    -> Login successful as <email>
//       anything else     -> "Login failed: Request failed with status code 400" on stderr, exit 1
//   auth status           -> JSON like the real CLI (loggedIn, email, subscriptionType)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [cmd, sub] = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
if (!dir) {
	console.error('fake-claude: CLAUDE_CONFIG_DIR is required');
	process.exit(2);
}
const authFile = path.join(dir, 'fake-auth.json');

if (cmd === 'auth' && sub === 'status') {
	let j = { loggedIn: false };
	try {
		j = JSON.parse(fs.readFileSync(authFile, 'utf8'));
	} catch {
		/* logged out */
	}
	console.log(
		JSON.stringify({ loggedIn: !!j.loggedIn, authMethod: 'claude.ai', email: j.email, subscriptionType: j.plan }, null, 2)
	);
	process.exit(j.loggedIn ? 0 : 1);
}

if (cmd === '-p') {
	// Token refresh the way the widget/server trigger it (`claude -p .`): logs the call, and if the
	// test left <dir>/fake-refresh.json ({"accessToken": "..."}), rewrites .credentials.json with it
	// and a fresh expiry. Without that file the refresh "fails" (credentials stay expired).
	fs.appendFileSync(path.join(dir, 'refresh.log'), `${sub}\n`);
	try {
		const next = JSON.parse(fs.readFileSync(path.join(dir, 'fake-refresh.json'), 'utf8'));
		const creds = { claudeAiOauth: { accessToken: next.accessToken, expiresAt: Date.now() + 3600_000 } };
		fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(creds));
	} catch {
		/* refresh "failed" */
	}
	process.exit(0);
}

if (cmd === 'auth' && sub === 'login') {
	// Like the real CLI (2.1.x): BROWSER gets the localhost-callback URL, stdout shows the hosted
	// callback URL (the one that displays a code to paste).
	const base = `https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=${Date.now()}`;
	const local = `${base}&redirect_uri=${encodeURIComponent('http://localhost:45849/callback')}`;
	const manual = `${base}&redirect_uri=${encodeURIComponent('https://platform.claude.com/oauth/code/callback')}`;
	if (process.env.BROWSER) spawnSync(`"${process.env.BROWSER}" "${local}"`, { shell: true, stdio: 'ignore' });
	process.stdout.write(`Opening browser to sign in...\nIf the browser didn't open, visit: ${manual}\nPaste code here if prompted > `);
	const succeed = (email) => {
		fs.mkdirSync(dir, { recursive: true });
		// Same shape as the real CLI's file; the token is fake (tests' fake usage server keys on it).
		const creds = { claudeAiOauth: { accessToken: `fake-${email}`, expiresAt: Date.now() + 3600_000 } };
		fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(creds));
		fs.writeFileSync(authFile, JSON.stringify({ loggedIn: true, email, plan: 'max' }));
		console.log('\nLogin successful.');
		process.exit(0);
	};
	const defaultEmail = `${path.basename(dir).replace(/^\.claude-/, '')}@example.com`;
	// Accounts named "autologin...": the browser completed the localhost callback, so the real CLI
	// logs in and exits on its own before any code is pasted.
	if (/autologin/i.test(path.basename(dir))) setTimeout(() => succeed(defaultEmail), 800);
	const rl = readline.createInterface({ input: process.stdin });
	rl.once('line', (line) => {
		const code = line.trim();
		if (code.startsWith('good')) succeed(code.includes(':') ? code.slice(code.indexOf(':') + 1) : defaultEmail);
		console.error('Login failed: Request failed with status code 400');
		process.exit(1);
	});
} else {
	console.error(`fake-claude: unsupported command ${process.argv.slice(2).join(' ')}`);
	process.exit(2);
}
