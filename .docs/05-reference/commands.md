# Commands

`just` with no arguments lists every recipe. Recipes run in Windows PowerShell 5.1.

| Recipe | Group | What it does |
| --- | --- | --- |
| `just setup` | Setup | Full idempotent setup (`setup.ps1`) |
| `just web` | Account Manager | Open the page (starts the manager if needed) |
| `just usage` | Account Manager | Open the usage page |
| `just manager-start` / `manager-stop` | Account Manager | Start (hidden) / stop the local manager |
| `just manager-build` | Account Manager | `npm ci` + build `web/`, restart the manager |
| `just web-dev` | Account Manager | Dev server with hot reload |
| `just start` / `stop` / `restart` | Widget | Show / close / restart the widget |
| `just widget-poll <minutes>` | Widget | Usage fetch interval (1–120; 5 recommended) |
| `just remote <url> <token>` / `remote-off` | Widget | Follow a server's accounts / back to local |
| `just widget-update` | Widget | Install the latest release (SHA-256 checked) |
| `just widget-build` | Widget | Build from source with cargo and install |
| `just startup-on` / `startup-off` | Widget | Widget + manager start with Windows (or not) |
| `just docker-build` / `docker-run` | Server | Build the image / run it locally on :47391 |
| `just test` | Tests | `test-rust` + `test-web` |
| `just test-rust` / `test-web` | Tests | Rust unit tests / web unit + e2e (local + server) |
| `just guide` | Tools | Open the setup guide website |
| `just claudex` / `claudeo` / `claudeh` / `claudel` | Tools | Claude Code: Sonnet / Opus / Haiku / self-hosted |

Server-side operations (on the Docker host, in `deploy/`) are listed in
[deployment.md](../04-deployment/deployment.md).
