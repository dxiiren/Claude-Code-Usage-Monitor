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

The e2e run uses port 47391, a temp home folder, and `tests/fixtures/fake-claude.cmd`. It never touches the
real `accounts.db`, `settings.json`, `.claude*` folders or Edge. Screenshots go to `test-results/screens/`
(or `SCREENSHOT_DIR`).
