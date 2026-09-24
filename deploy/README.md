# Account Manager on a server (Docker)

The same Account Manager web app as on Windows, in **server mode**: the server owns the Claude
logins and polls every account's usage itself; Windows widgets read the result over HTTPS.
Contract: `docs/account-manager-contract.md`, "Server mode (Docker) and the widget's remote mode".

## Contents

1. [Start](#start)
2. [Configuration](#configuration)
3. [Behind a Cloudflare tunnel](#behind-a-cloudflare-tunnel)
4. [Adding an account](#adding-an-account)
5. [Connecting a widget](#connecting-a-widget)
6. [Data, backup and upgrades](#data-backup-and-upgrades)
7. [Security notes](#security-notes)

## Start

```sh
cd deploy
cp .env.example .env        # set ACCTMGR_ADMIN_PASSWORD and ACCTMGR_PUBLIC_ORIGIN
docker compose up -d --build
docker compose ps           # STATUS shows (healthy) after ~20 s
docker compose logs -f
```

The page is then on `http://127.0.0.1:47291` on the host (loopback only). Without
`ACCTMGR_ADMIN_PASSWORD` compose refuses to start, and the container itself exits with
`FATAL: ACCTMGR_ADMIN_PASSWORD is required in server mode`.

## Configuration

All settings live in `deploy/.env` (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ACCTMGR_ADMIN_USER` | `Admin` | sign-in username (case-insensitive) |
| `ACCTMGR_ADMIN_PASSWORD` | required | sign-in password; changing it signs everyone out |
| `ACCTMGR_PUBLIC_ORIGIN` | `http://127.0.0.1:47291` | the URL in the browser; drives the Host/Origin checks and the Secure cookie |
| `ACCTMGR_PUBLISH` | `127.0.0.1:47291` | host side of the port mapping |
| `ACCTMGR_TRUST_PROXY` | `0` | `1` = rate-limit sign-in per `CF-Connecting-IP` (only when reachable through the tunnel alone) |
| `ACCTMGR_POLL_SECONDS` | `300` | usage poll interval per account (minimum 30) |
| `ACCTMGR_SESSION_SECRET` | generated | session signing secret; generated once into `/data/session-secret` |
| `ACCTMGR_NETWORK` | none | external Docker network to join (tunnel overlay) |
| `CLAUDE_CODE_VERSION` | `2.1.273` | Claude Code CLI version baked into the image |
| `CODEX_VERSION` | `0.142.5` | Codex CLI (`@openai/codex`) version baked into the image |

## Behind a Cloudflare tunnel

1. Keep `ACCTMGR_PUBLISH=127.0.0.1:47291` so nothing but the tunnel reaches the app.
2. In `.env`, set `ACCTMGR_PUBLIC_ORIGIN=https://<your hostname>`, then
   `COMPOSE_FILE=docker-compose.yml:docker-compose.tunnel.yml` and `ACCTMGR_NETWORK=<cloudflared's network>`.
3. In the tunnel, route the public hostname to `http://claude-usage:47291`.
4. Set `ACCTMGR_TRUST_PROXY=1`, so each visitor's sign-in attempts count against their own address.
5. `docker compose up -d`.

The app refuses any request whose `Host` is not the public hostname (`403 Forbidden host`). If you
see that behind the tunnel, set the tunnel's `httpHostHeader` to the public hostname.

## Adding an account

Sign in, type a name, click **Start**. The server runs `claude auth login --claudeai` inside the
container and shows **Open sign-in page**. Open it in your own browser (a private window, so it does
not sign in as someone already signed in), sign in, click Authorize, copy the code, and paste it into
the page. The server never calls Anthropic OAuth endpoints itself; the CLI does the exchange and
keeps the login in `/data/accounts/<id>`.

Usage is polled right after the login, then every `ACCTMGR_POLL_SECONDS`, the same way the
widget polls (same endpoint and headers, token refresh by running the CLI, 429 / Retry-After
honoured).

### Codex (ChatGPT) accounts

Pick **Codex** before **Start**. The server asks the Codex CLI in the container for a ChatGPT sign-in
link (`codex app-server`, the CLI's own login server, with `CODEX_HOME=/data/accounts/<id>`) and
shows **Open sign-in page**. Open it in your own browser (a private window), sign in. Your browser
then lands on a `http://localhost:1455/auth/callback?...` page that does not load: that is expected,
because the CLI waiting for it runs inside the container. Copy that page's full address and paste it
into the manager. The server checks it (host `localhost` / `127.0.0.1`, port `1455`, path
`/auth/callback` only) and replays it to the CLI's own `127.0.0.1:1455` inside the container, which
finishes the login and writes `auth.json`. The server never calls OpenAI OAuth endpoints itself.

Status comes from `codex login status`; the email from the id_token in `auth.json`. Usage is polled
from `https://chatgpt.com/backend-api/wham/usage` like the widget (same headers incl.
`ChatGPT-Account-Id`, 5-hour / weekly windows by length, a rejected token refreshed by the CLI,
429 / Retry-After honoured). Only one Codex sign-in can wait at a time (the CLI has one callback
port); starting another cancels the first.

## Connecting a widget

Open **Widget tokens**, create a token (it is shown once), and put these in the widget's
`%APPDATA%\ClaudeCodeUsageMonitor\settings.json`:

```json
"remote_server_url": "https://<your hostname>",
"remote_server_token": "<the token>"
```

The widget reads `GET /api/v1/widget` with `Authorization: Bearer <token>`. **Revoke** stops a
token at once (`401`).

## Data, backup and upgrades

Everything is in the `claude-usage-data` volume (`/data`): `accounts.db`, `session-secret`, and one
config folder per account under `accounts/` (Claude: `CLAUDE_CONFIG_DIR`; Codex: `CODEX_HOME` with
`auth.json`). Back up the volume to keep the logins.

```sh
docker run --rm -v claude-usage_claude-usage-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/claude-usage-data.tgz -C /data .
```

Upgrade the CLIs: change `CLAUDE_CODE_VERSION` / `CODEX_VERSION`, then `docker compose up -d --build`.
The Claude CLI's own auto-updater is off in the image; the Codex CLI only updates when asked
(`codex update`), which nothing in the image runs.

## Security notes

- The container runs as the non-root `node` user; `/healthz` is the only page without sign-in and it
  returns just `ok`.
- Sign-in: 5 failures per 15 minutes per client address, then `429` with `Retry-After`; a global cap
  of 30 failures per 15 minutes covers many addresses. Failed attempts are logged with address and
  time only (`docker compose logs | grep "failed sign-in"`), never what was typed.
- Session cookie: `HttpOnly`, `SameSite=Strict`, and `Secure` (as `__Host-acctmgr_session`) when the
  public origin is https. Sessions and widget tokens are stored as SHA-256 hashes only.
- Tokens and Claude / Codex credentials are never returned by any endpoint or written to logs.
