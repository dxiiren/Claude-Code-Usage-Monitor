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

if (cmd === 'auth' && sub === 'login') {
	const url = `https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=${Date.now()}`;
	if (process.env.BROWSER) spawnSync(`"${process.env.BROWSER}" "${url}"`, { shell: true, stdio: 'ignore' });
	process.stdout.write('Opening browser to sign in...\nPaste code here if prompted > ');
	const rl = readline.createInterface({ input: process.stdin });
	rl.once('line', (line) => {
		const code = line.trim();
		if (code.startsWith('good')) {
			const email = code.includes(':') ? code.slice(code.indexOf(':') + 1) : `${path.basename(dir).replace(/^\.claude-/, '')}@example.com`;
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, '.credentials.json'), '{"fake":true}');
			fs.writeFileSync(authFile, JSON.stringify({ loggedIn: true, email, plan: 'max' }));
			console.log('\nLogin successful.');
			process.exit(0);
		}
		console.error('Login failed: Request failed with status code 400');
		process.exit(1);
	});
} else {
	console.error(`fake-claude: unsupported command ${process.argv.slice(2).join(' ')}`);
	process.exit(2);
}
