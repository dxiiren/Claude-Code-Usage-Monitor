# Project layout

| Path | What lives there |
| --- | --- |
| `src/` | The widget (Rust). Fork additions: `accounts_db.rs` (reads `accounts.db`), `remote.rs` (server mode), `login_required` theme binding in `theme_engine.rs`, the "Manage accounts" menu item in `context_menu.rs` |
| `web/` | Account Manager (SvelteKit, Svelte 5, `node:sqlite`). `src/lib/server/` holds the DB, login driver (`claude.ts`), status, poller, auth, widget API; `src/routes/` the pages and API |
| `web/tests/` | `unit/` (vitest), `e2e/` (local mode), `e2e-server/` (server mode), `fixtures/` (fake Claude CLI, fake usage endpoint) |
| `web/Dockerfile` | Server image: Node 24, Claude Code CLI pinned by `CLAUDE_CODE_VERSION`, non-root, `/data` volume |
| `deploy/` | `docker-compose.yml`, `docker-compose.tunnel.yml` (Cloudflare network), `docker-compose.tls.yml` + `nginx-tls.conf` (own certificate), `.env.example` |
| `kit/` | `UsageKit.psm1` (install/start/stop/remote/poll helpers), `manager.vbs` (hidden start), `close-menu.json` |
| `setup.ps1` / `install.ps1` | Machine setup / no-clone installer |
| `justfile` | Every recipe |
| `site/` | Setup guide page (published from the `gh-pages` branch) |
| `docs/` | `account-manager-contract.md` (the design contract), `upstream-README.md`, upstream updater/security notes |
| `.docs/` | This documentation |
| `.github/workflows/` | `tests.yml` (all suites + Docker), `release.yml` (tag → exe release), `dependency-security.yml` |

On a PC at runtime:

| Path | What |
| --- | --- |
| `%APPDATA%\ClaudeCodeUsageMonitor\accounts.db` | Local account list (SQLite) |
| `%APPDATA%\ClaudeCodeUsageMonitor\settings.json` | Widget settings (poll interval, remote server, theme path) |
| `%USERPROFILE%\.claude-<id>\` | One Claude login per account (never `%USERPROFILE%\.claude`) |
| `%LOCALAPPDATA%\Programs\ClaudeUsageMonitor\` | The installed widget |
