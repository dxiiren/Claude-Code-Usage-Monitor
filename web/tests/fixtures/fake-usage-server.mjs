// Stand-in for https://api.anthropic.com/api/oauth/usage in the server-mode e2e run
// (ACCTMGR_USAGE_URL points here). Tokens come from fake-claude.mjs: `fake-<email>`.
//   token containing "expired" -> 401
//   any other Bearer token     -> 200 with five_hour 12 % / seven_day 44 %
// Codex (ACCTMGR_CODEX_USAGE_URL points at /backend-api/wham/usage). Tokens come from fake-codex.mjs:
// `fake-codex-<email>`; the request must carry User-Agent codex-cli and ChatGPT-Account-Id.
//   token containing "expired" -> 401
//   any other Bearer token     -> 200, 5-hour window 7 % (primary) / weekly 33 % (secondary)
// GET /calls returns how many usage requests arrived (so tests can see the server polled);
// GET /codex-calls the same for the Codex endpoint.
import http from 'node:http';

const port = Number(process.env.FAKE_USAGE_PORT || 47393);
let calls = 0;
let codexCalls = 0;

http
	.createServer((req, res) => {
		if (req.url === '/calls') {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ calls }));
		}
		if (req.url === '/codex-calls') {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ calls: codexCalls }));
		}
		if (req.url === '/backend-api/wham/usage' && req.method === 'GET') {
			codexCalls++;
			const auth = req.headers.authorization ?? '';
			if (!auth.startsWith('Bearer ') || req.headers['user-agent'] !== 'codex-cli' || !req.headers['chatgpt-account-id']) {
				res.writeHead(400);
				return res.end('{}');
			}
			if (auth.includes('expired')) {
				res.writeHead(401, { 'content-type': 'application/json' });
				return res.end('{"detail":"token expired"}');
			}
			const at = (h) => Math.floor(Date.now() / 1000) + h * 3600;
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(
				JSON.stringify({
					plan_type: 'plus',
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_after_seconds: 7200, reset_at: at(2) },
						secondary_window: { used_percent: 33, limit_window_seconds: 604800, reset_after_seconds: 3 * 86400, reset_at: at(72) }
					},
					credits: null
				})
			);
		}
		if (req.url === '/api/oauth/usage' && req.method === 'GET') {
			calls++;
			const auth = req.headers.authorization ?? '';
			if (!auth.startsWith('Bearer ') || req.headers['anthropic-beta'] !== 'oauth-2025-04-20') {
				res.writeHead(400);
				return res.end('{}');
			}
			if (auth.includes('expired')) {
				res.writeHead(401, { 'content-type': 'application/json' });
				return res.end('{"error":"invalid token"}');
			}
			const inH = (h) => new Date(Date.now() + h * 3600_000).toISOString();
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(
				JSON.stringify({ five_hour: { utilization: 12, resets_at: inH(3) }, seven_day: { utilization: 44, resets_at: inH(60) } })
			);
		}
		res.writeHead(404);
		res.end();
	})
	.listen(port, '127.0.0.1', () => console.log(`fake usage server on ${port}`));
