// Stand-in for https://api.anthropic.com/api/oauth/usage in the server-mode e2e run
// (ACCTMGR_USAGE_URL points here). Tokens come from fake-claude.mjs: `fake-<email>`.
//   token containing "expired" -> 401
//   any other Bearer token     -> 200 with five_hour 12 % / seven_day 44 %
// GET /calls returns how many usage requests arrived (so tests can see the server polled).
import http from 'node:http';

const port = Number(process.env.FAKE_USAGE_PORT || 47393);
let calls = 0;

http
	.createServer((req, res) => {
		if (req.url === '/calls') {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ calls }));
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
