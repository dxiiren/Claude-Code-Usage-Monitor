# Account Manager (web)

A small local web app that owns the list of Claude accounts shown by the usage widget.
It follows `docs/account-manager-contract.md`: it writes `%APPDATA%\ClaudeCodeUsageMonitor\accounts.db`
and regenerates the card theme and `settings.json` after every change. The widget reads those files.

## Run

```powershell
npm install
npm run build
npm start            # http://127.0.0.1:47291 (binds 127.0.0.1 only)
```

`npm run dev` runs the Vite dev server on the same address.

## Pages

- `/` (Accounts): add, log in, re-login, rename, reorder, show or hide on the widget, and remove. Also has
  the desktop card theme (Auto / Light / Dark, stored in `meta.card_theme`) and **Restart widget**.
- `/usage`: every account's 5-hour and weekly usage on one card, with a "Best to use now" pick.
  It refreshes every 15 s.

`/` stays the manager because the widget's "Manage accounts" menu opens `meta.manager_url`.

## Adding an account

Type a name and click **Start**. The server runs `claude auth login --claudeai` with `BROWSER` pointed at a
script that only records the URL. It then opens that URL in a throwaway Edge profile
(`--user-data-dir`, `--inprivate`). Sign in, click Authorize, and paste the code. The server gives the code
to the CLI, then reads `claude auth status` to get the email and plan. If another account already has that
email, the page warns you. This usually means the browser was already signed in. The app never calls
Anthropic OAuth endpoints itself, and it never reads, logs or returns credentials.

**Remove** deletes the account's `%USERPROFILE%\.claude-<id>` folder. `%USERPROFILE%\.claude` is never deleted.

Account ids use only `[a-z0-9_]` (for example `my-work!` becomes `my_work`), because the widget's theme expressions
read `accounts.claude.<id>.…` and would parse a `-` as minus. Ids are never reused.

## Codex accounts

Pick **Codex** before **Start** (contract: "Codex accounts (provider column)"). The row gets
`provider = 'codex'` and the folder `%USERPROFILE%\.codex-<id>` (server: `/data/accounts/<id>`), used as
`CODEX_HOME`. `%USERPROFILE%\.codex` (your own Codex install) is never used or deleted.

The login drives the official Codex CLI through `codex app-server` (JSON-RPC on stdio):
`account/login/start {type: "chatgpt"}` starts the CLI's own login server on `127.0.0.1:1455` and returns
the authorize URL, whose redirect is `http://localhost:1455/auth/callback`. Plain `codex login` is not used:
measured on codex-cli 0.142.5 (Windows), it ignores `BROWSER` and opens the default browser, which is often
already signed in to ChatGPT as someone else. Every CLI call passes `-c cli_auth_credentials_store=file`, so
the login lands in `auth.json` (which the widget and the server poller read), never the OS keyring.

- **Local:** the URL opens in the throwaway Edge profile; the redirect reaches the CLI by itself and the page
  (polling `GET /api/login/status`) shows the result. Nothing to paste. The fallback box accepts the
  `http://localhost:1455/auth/callback?...` address if the browser ended there instead.
- **Server:** the page shows the link for your own browser. It ends on a `localhost:1455` page that does not
  load; paste that address. `POST /api/login/callback` accepts only host `localhost` / `127.0.0.1`, port
  `1455`, path `/auth/callback` with a `state` and a `code` (or `error`), and replays the query to
  `http://127.0.0.1:1455` (never the pasted host).
- One Codex sign-in waits at a time (one callback port); starting another cancels the first. **Cancel**
  sends `account/login/cancel`, closes the CLI and the Edge window, and frees the port.

Email and plan come from the `id_token` payload in `auth.json` (`email`, `chatgpt_plan_type`), else
"ChatGPT account"; login state from `codex login status`. Usage: local mode reads the widget's
`usage-cache.json` entries with `provider: "codex"` and `source_path` `<folder>\auth.json`; server mode polls
`https://chatgpt.com/backend-api/wham/usage` like `src/poller/codex.rs` (Bearer, `User-Agent: codex-cli`,
`ChatGPT-Account-Id`, windows mapped by length to 5-hour / weekly, a 401/403 refreshed through the CLI's
`account/read {refreshToken: true}` then retried once, 429 / Retry-After honoured).

The card theme binds Codex rows to `accounts.codex.<id>.*` and adds a small "Codex" tag under the name.
`settings.json` keeps only the Claude profiles; `show_codex` is switched on when an enabled Codex account
exists (the widget polls the DB's Codex accounts only then). `meta.schema` is `2`, and `GET /api/v1/widget`
sends `"schema": 2` with a `provider` per account.

## Login status

Each account's status comes from two sources: the widget's last poll error in `usage-cache.json`, and
`claude auth status` for that folder (cached for 60 s).

- `ok`: the login works.
- `expired`: `token_expired`, `auth_required`, or HTTP 401/403 from Claude.
- `logged_out`: `no_credentials`, or the CLI says the folder is not logged in.
- `error`: a temporary problem (network error, request failed, unexpected response, other HTTP codes).
  The page shows the message but does not ask you to log in again.

`expired` and `logged_out` accounts get a red badge and a **Re-login** button on both pages. The Usage page lists
them at the top and leaves them out of "Best to use now". On the desktop card they show "Expired · re-login" in place
of their bars (`accounts.claude.<id>.login_required`).

## Safety

- Every non-GET request must carry `Origin: http://127.0.0.1:47291`, or the server returns 403.
  A `Host` that is not `127.0.0.1:47291` is also rejected, which blocks DNS rebinding.
- The DB uses a rollback journal, not WAL, because the widget opens it read-only.

## Environment overrides

| Variable | Purpose |
|---|---|
| `PORT` | listen port (default 47291) |
| `CLAUDE_BIN` / `CLAUDE_EXE` | path to the Claude Code CLI (default: `claude` on PATH) |
| `CODEX_BIN` | path to the Codex CLI (default: `codex` on PATH; tests point it at `tests/fixtures/fake-codex.*`) |
| `ACCTMGR_CODEX_USAGE_URL` | server mode, tests only: the Codex usage endpoint (default `https://chatgpt.com/backend-api/wham/usage`) |
| `EDGE_EXE` | path to `msedge.exe`, or `none` to never open a window |
| `WIDGET_EXE` | path to `claude-code-usage-monitor.exe` (default: the WinGet package) |

## Server mode (Docker)

`ACCTMGR_MODE=server` runs the same app on a Linux server: it owns the logins (`/data/accounts/<id>`), polls
every account's usage itself (a port of the widget's `src/poller/claude.rs`), and serves `GET /api/v1/widget`
to remote widgets. Every page and API needs the admin sign-in (`ACCTMGR_ADMIN_USER` / `ACCTMGR_ADMIN_PASSWORD`);
widgets use tokens from the **Widget tokens** page. Login shows an **Open sign-in page** link for your own
browser (no Edge, no widget files, no `settings.json`). Build and run it with `deploy/` (see `deploy/README.md`).

Server-mode code: `src/lib/server/auth.ts` (sign-in, sessions, rate limit, tokens), `poller.ts` +
`serverUsage.ts` (usage polling), `widgetApi.ts` (`/api/v1/widget`), `guard.ts` `checkServerRequest`.

## Tests

```powershell
npm test             # unit (vitest): theme, DB, settings, usage matching, guards, contrast
npm run test:e2e     # builds, then Playwright against a throwaway APPDATA/USERPROFILE + fake CLI
npm run test:e2e:server  # server mode: built server via start.js, temp /data, fake CLI + fake usage endpoint
npm run test:all
```

The server-mode e2e (`playwright.server.config.ts`, `tests/e2e-server/`) uses ports 47392 (app) and 47393 (fake usage
endpoint, via `ACCTMGR_USAGE_URL`).

The e2e run uses port 47391, a temp home folder, `tests/fixtures/fake-claude.cmd` and `fake-codex.cmd`. It never
touches the real `accounts.db`, `settings.json`, `.claude*` / `.codex*` folders, the real CLIs or Edge. The fake
Codex CLI binds the real callback port 1455 during its login tests, so do not run the suites in parallel. Screenshots go to `test-results/screens/`
(or `SCREENSHOT_DIR`).
