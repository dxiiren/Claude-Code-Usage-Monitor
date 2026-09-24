# TL;DR

- **What:** one place to see the 5-hour and weekly usage (with reset countdowns) of every Claude
  account you own — a Windows widget card, a web page, and optionally a server.
  → [project-overview](01-overview/project-overview.md)
- **Install on a PC:** `powershell -ExecutionPolicy Bypass -File ./setup.ps1`, reopen PowerShell,
  `just web`. Idempotent. → [getting-started](02-setup/getting-started.md)
- **Add an account:** type a name → **Start** → sign in in the fresh Edge window → **Authorize** →
  paste the code → **Connect**. The widget updates within seconds.
- **Codex account:** pick **Codex** first. On a PC the Edge sign-in finishes by itself; on a server,
  paste the `http://localhost:1455/auth/callback?...` address the browser ends on.
- **Where data lives:** SQLite `accounts.db` (names, emails, order; server also usage, sessions,
  hashed widget tokens) + one Claude config folder per account holding its login. Tokens are never
  shown, logged or committed.
- **Freshness:** server polls every `ACCTMGR_POLL_SECONDS` (120 recommended); PC widget every
  `just widget-poll <minutes>` (5 recommended); pages refresh every 15 s. Faster risks Anthropic
  rate limits.
- **Server:** `deploy/` → `cp .env.example .env`, set `ACCTMGR_ADMIN_PASSWORD` +
  `ACCTMGR_PUBLIC_ORIGIN`, `docker compose up -d --build`. Tunnel or HTTPS overlay optional.
  → [deployment](04-deployment/deployment.md)
- **Widget follows a server:** create a token on the server's **Widget tokens** page, then
  `just remote <url> <token>`.
- **Develop:** branch → change → `just test` (Rust + web unit + e2e local/server) → PR → CI green →
  merge. Releases: bump `Cargo.toml`, tag `vX.Y.Z`. → [workflow](03-development/workflow.md)
- **Every recipe:** `just --list` → [commands](05-reference/commands.md)
- **Something broke:** [common-issues](06-troubleshooting/common-issues.md)
