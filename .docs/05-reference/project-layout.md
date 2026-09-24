# Project layout

| Path | What lives there |
| --- | --- |
| `src/` | The widget (Rust). Fork additions: `accounts_db.rs` (reads `accounts.db`), `remote.rs` (server mode), `login_required` theme binding in `theme_engine.rs`, the "Manage accounts" menu item in `context_menu.rs` |
| `web/` | Account Manager (SvelteKit, Svelte 5, `node:sqlite`). `src/lib/server/` holds the DB, login drivers (`claude.ts`, `codex.ts`), status, poller (Claude + Codex), auth, widget API; `src/routes/` the pages and API |
| `web/tests/` | `unit/` (vitest), `e2e/` (local mode), `e2e-server/` (server mode), `fixtures/` (fake Claude CLI, fake Codex CLI with a real `127.0.0.1:1455` callback server, fake usage endpoints) |
| `web/Dockerfile` | Server image: Node 24, Claude Code CLI pinned by `CLAUDE_CODE_VERSION`, Codex CLI pinned by `CODEX_VERSION`, non-root, `/data` volume |
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
| `%APPDATA%\ClaudeCodeUsageMonitor\accounts.db` | Local account list (SQLite; `provider` column = `claude` / `codex`, `meta.schema` 2) |
| `%APPDATA%\ClaudeCodeUsageMonitor\settings.json` | Widget settings (poll interval, remote server, theme path) |
| `%USERPROFILE%\.claude-<id>\` | One Claude login per account (never `%USERPROFILE%\.claude`) |
| `%USERPROFILE%\.codex-<id>\` | One Codex login per account, `CODEX_HOME` with `auth.json` (never `%USERPROFILE%\.codex`) |
| `%LOCALAPPDATA%\Programs\ClaudeUsageMonitor\` | The installed widget |
