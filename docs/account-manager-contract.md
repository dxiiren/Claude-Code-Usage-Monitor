# Account Manager contract (web app <-> widget)

The Account Manager web app (`web/`) owns the list of Claude accounts. The widget (Rust,
`src/`) reads that list. They share one SQLite file and nothing else.

## Database

Path: `%APPDATA%\ClaudeCodeUsageMonitor\accounts.db` (the widget's existing app-data folder).
Rollback journal (default), NOT WAL: the widget reads through Windows' `winsqlite3.dll`
read-only, and a read-only connection cannot recover a WAL file.

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,            -- slug: lowercase [a-z0-9_] (theme expressions reject '-'), stable, never reused for another person
  name        TEXT NOT NULL UNIQUE,        -- display label ("ba", "kv")
  config_dir  TEXT NOT NULL,               -- ABSOLUTE Windows path, e.g. C:\Users\me\.claude-ba
  email       TEXT,                        -- from `claude auth status` after login; NULL until logged in
  plan        TEXT,                        -- subscriptionType ("max", "pro"); NULL until logged in
  enabled     INTEGER NOT NULL DEFAULT 1,  -- 0 = hidden from the widget, login kept
  sort_order  INTEGER NOT NULL DEFAULT 0,  -- ascending = top of the card
  created_at  TEXT NOT NULL,               -- ISO-8601 UTC
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- meta rows the web app maintains:
--   revision     integer as text; +1 on EVERY write to accounts
--   manager_url  "http://127.0.0.1:47291"
--   schema       "1"
```

The web app creates the file and tables on first start. The widget never writes.

## Widget behaviour

1. If `accounts.db` exists and has a `meta.schema` row, the Claude provider's account
   profiles come from `SELECT id, name, config_dir FROM accounts WHERE enabled = 1 ORDER BY
   sort_order, name` -- each row maps to `AccountProfile { id, name, config_dir,
   credentials_path: "", enabled: true }`. The Claude profiles in `settings.json` are
   ignored while the DB is present. Zero enabled rows = zero Claude accounts (no fallback to
   `~\.claude`).
2. If the file is missing, unreadable or has no `meta.schema`: current behaviour, unchanged.
3. Every 5 s the widget reads `meta.revision`. On change: reload the profiles, reload the
   active theme file from disk, and force a usage poll, without restarting.
4. Built-in context menus (`dashboard-v2`, `classic-v1`) get a "Manage accounts" item that
   opens `meta.manager_url` (default `http://127.0.0.1:47291`).

## Web app responsibilities

- Serve on `127.0.0.1:47291` only. Reject mutating requests whose `Origin` is not that
  origin (a hostile web page must not be able to add/remove accounts via the browser).
- Log in by driving the official Claude Code CLI (`claude auth login --claudeai`), never by
  calling Anthropic OAuth endpoints itself. `BROWSER` points at a script that only records
  the URL; the URL opens in Edge with a fresh `--user-data-dir`; the user pastes the code in
  the page; the server writes it to the CLI's stdin. Then `claude auth status` (same
  `CLAUDE_CONFIG_DIR`) gives email + plan.
- New accounts get `config_dir = %USERPROFILE%\.claude-<id>`. Removing an account deletes its
  folder ONLY if it matches `%USERPROFILE%\.claude-*`; `%USERPROFILE%\.claude` is never
  deleted.
- After every write: bump `meta.revision`, regenerate the card theme
  (`%APPDATA%\ClaudeCodeUsageMonitor\themes\multi-claude-accounts.json`, same layout as
  `kit/UsageKit.psm1` `Write-UsageTheme`), and keep `settings.json` pointing at it.
- Usage numbers come from the widget's `usage-cache.json` (`data.accounts[]`, matched by
  `source_path` = `<config_dir>\.credentials.json`).

## Server mode (Docker) and the widget's remote mode

The same web app also runs as a Linux container on a server (`ACCTMGR_MODE=server`). Then the
server, not the PC, owns the logins and fetches usage; Windows widgets only read from it.

### Server responsibilities

- Data lives in one volume, `/data`: `accounts.db` (same schema as above) and one Claude
  config folder per account, `/data/accounts/<id>` (the CLI's `.credentials.json` lands there).
- Login: `claude auth login --claudeai` in the container with `CLAUDE_CONFIG_DIR` set and
  `BROWSER` pointed at a script that only records the URL. The page shows that URL as a link
  the user opens in THEIR browser (any device), then pastes the code; nothing opens a
  browser server-side. Never call Anthropic OAuth endpoints directly.
- Usage: the server polls each enabled account's usage itself, the same way the widget
  does (`src/poller/claude.rs`: endpoint, headers, token refresh by running the CLI when
  the access token is expired), every `ACCTMGR_POLL_SECONDS` (default 300), honouring 429 /
  Retry-After. Results are stored per account (last usage, last error, polled_at).
- Access control (the page is no longer loopback-only):
  - `ACCTMGR_ADMIN_USER` (default `Admin`, case-insensitive) + `ACCTMGR_ADMIN_PASSWORD`
    (required in server mode; refuse to start without it) protect
    every page and `/api/*` with a login form and an HttpOnly, SameSite=Strict session cookie
    (`Secure` when `ACCTMGR_PUBLIC_ORIGIN` is https). Login attempts are rate limited.
  - `ACCTMGR_PUBLIC_ORIGIN` (e.g. `https://claude.example.com`) replaces the
    127.0.0.1:47291 Origin/Host check.
  - `ACCTMGR_TRUST_PROXY=1` counts sign-in attempts per `CF-Connecting-IP` (only when the
    container is reachable solely through the Cloudflare tunnel); otherwise per socket address.
  - Widget API tokens: created in the UI (shown once), stored as SHA-256 hashes in table
    `api_tokens(id TEXT PK, name TEXT, token_hash TEXT UNIQUE, created_at TEXT, last_used_at TEXT)`,
    revocable. Only `GET /api/v1/widget` accepts them (`Authorization: Bearer <token>`).
- Tokens / credentials are never returned by any endpoint or written to logs.

### `GET /api/v1/widget` (Bearer token) -- what remote widgets read

```json
{
  "schema": 1,
  "revision": 12,
  "updated_unix": 1790240810,
  "manager_url": "https://claude.example.com",
  "card_theme": "auto",
  "accounts": [
    {
      "id": "ba", "name": "ba", "email": "x@y", "plan": "max",
      "status": "ok",                 // ok | expired | logged_out | error
      "status_message": "",
      "usage": {                      // null when never fetched
        "session": { "available": true, "percentage": 12.0, "resets_at_unix": 1790248799 },
        "weekly":  { "available": true, "percentage": 44.0, "resets_at_unix": 1790456399 }
      }
    }
  ]
}
```

Only enabled accounts, in `sort_order`. `401` for a missing/unknown/revoked token.

### Widget remote mode

`settings.json` keys `remote_server_url` + `remote_server_token` (both non-empty) switch the
Claude provider to remote mode: accounts, usage and login state come from `GET
/api/v1/widget` (no local credential files are read, no local CLI refresh), fetched on the
normal poll interval and additionally every 30 s when `revision` may have changed. The
"Manage accounts" menu item opens `manager_url`. Precedence: remote mode > `accounts.db` >
settings.json profiles. `login_required` is 1 when `status` is `expired` or `logged_out`. A
server that is unreachable keeps the last good data marked stale, like any poll failure.

## Codex accounts (provider column)

The manager also manages **OpenAI Codex** accounts (ChatGPT sign-in), shown on the widget the
same way as Claude accounts.

### Schema change (backward compatible)

`accounts` gains `provider TEXT NOT NULL DEFAULT 'claude'` (values `claude` | `codex`). The web
app adds the column with `ALTER TABLE` when missing and bumps `meta.schema` to `2`. Ids stay
unique across providers. Rows without the column (old DBs) are Claude.

- Codex config folder = `CODEX_HOME`: `%USERPROFILE%\.codex-<id>` locally,
  `/data/accounts/<id>` on a server; the CLI writes `auth.json` there. Never touch
  `%USERPROFILE%\.codex` (the user's own Codex install), exactly like `.claude`.

### Widget

- `accounts_db`: `WHERE enabled = 1` rows with `provider = 'codex'` become the **Codex**
  provider's profiles (`config_dir` = CODEX_HOME; credentials `auth.json`), replacing
  settings.json Codex profiles while the DB is present — same rules as Claude. Zero codex rows =
  zero Codex accounts only if the DB has schema >= 2; with schema 1 Codex keeps its current
  settings.json behaviour.
- `accounts.codex.<id>.login_required` works like Claude's.
- Remote mode: `GET /api/v1/widget` accounts gain `"provider": "claude" | "codex"` (missing =
  claude); codex accounts map to the Codex provider.

### Web app

- Add account: a provider choice (Claude / Codex). Codex login drives the official CLI in its
  app-server mode (`codex app-server`, JSON-RPC `account/login/start {type: "chatgpt"}`), because
  `codex login` ignores `BROWSER` on Windows and opens the default browser itself (which would sign
  in whatever ChatGPT account that browser already has). `CODEX_HOME` points at the account folder
  and every call passes `-c cli_auth_credentials_store=file` so the login lands in `auth.json`.
  The login server listens on `127.0.0.1:1455` and redirects to `http://localhost:1455/auth/callback`;
  one Codex login at a time (single port); `account/login/cancel` frees it.
  - **local mode**: open the returned URL in the isolated Edge profile; the callback completes by
    itself. A paste box still accepts the final `http://localhost:1455/auth/callback?...` URL.
  - **server mode**: the page shows the sign-in link for the user's own browser; after signing
    in, their browser lands on a `localhost:1455/...` page that fails to load -- the user copies
    that address and pastes it; the server replays it (HTTP GET) against its own
    `127.0.0.1:1455`. Accept only host localhost/127.0.0.1, port 1455, path `/auth/callback`;
    always replay to 127.0.0.1, never to the pasted host.
  - Token refresh uses the CLI (`account/read {refreshToken: true}`), never a model request.
- Status: `codex login status` (logged in / not) + the poller's errors, mapped to the same
  `ok | expired | logged_out | error` states. Email: from the id_token in `auth.json` if present
  (decode the JWT payload `email`; never log the token), else "ChatGPT account".
- Usage: local mode from the widget's `usage-cache.json` (`provider: "codex"` entries);
  server mode polls `https://chatgpt.com/backend-api/wham/usage` like `src/poller/codex.rs`
  (same headers, account-id header, window mapping to 5-hour/weekly, token refresh by invoking
  the CLI, 429/Retry-After). Never call OpenAI OAuth endpoints directly.
- Card theme: Codex rows labelled with a small "Codex" tag; bindings `accounts.codex.<id>.*`.
- Docker image: installs the Codex CLI (`@openai/codex`, pinned by `CODEX_VERSION` build arg).
