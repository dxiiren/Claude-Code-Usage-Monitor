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

## Tests

```powershell
npm test             # unit (vitest): theme, DB, settings, usage matching, guards, contrast
npm run test:e2e     # builds, then Playwright against a throwaway APPDATA/USERPROFILE + fake CLI
npm run test:all
```

The e2e run uses port 47391, a temp home folder, and `tests/fixtures/fake-claude.cmd`. It never touches the
real `accounts.db`, `settings.json`, `.claude*` folders or Edge. Screenshots go to `test-results/screens/`
(or `SCREENSHOT_DIR`).
