# Claude Code Usage Monitor (multi-account)

See the 5-hour and weekly usage of every Claude account you own in one place: a Windows desktop
widget, a web Account Manager where adding an account is "sign in, paste the code", and an
optional Docker server so any PC's widget can follow the same accounts.

> **New developer? Start with [`.docs/tldr.md`](.docs/tldr.md)** — every doc summarised on one
> page. The full guide lives in [`.docs/`](.docs/README.md). A fork of
> [CodeZeno/Claude-Code-Usage-Monitor](https://github.com/CodeZeno/Claude-Code-Usage-Monitor);
> the upstream widget guide is kept in [`docs/upstream-README.md`](docs/upstream-README.md).

## Prerequisites

| Tool | Version | Installed by |
| --- | --- | --- |
| PowerShell + winget | Windows 10/11 stock | — (the only true prerequisites) |
| Claude Code CLI | latest | `setup.ps1` (the Account Manager logs accounts in through it) |
| Node.js | 22.13+ (uses `node:sqlite`) | `setup.ps1` |
| just | any recent | `setup.ps1` |
| Rust + MSVC build tools | 1.95 (`rust-toolchain.toml`) | manual — only to build the widget from source |
| Docker | 24+ with compose v2 | manual — only on a server |

## Quick start

```powershell
# 1. One-time machine setup (idempotent — safe to re-run)
powershell -ExecutionPolicy Bypass -File ./setup.ps1

# 2. Close and reopen PowerShell so PATH updates land

# 3. Add your accounts: type a name, sign in in the fresh window, paste the code
just web
```

No clone? One line does all of it:
`irm https://raw.githubusercontent.com/dxiiren/Claude-Code-Usage-Monitor/main/install.ps1 | iex`

The Account Manager is now at **http://127.0.0.1:47291** (usage page: `/usage`) and the widget
card is on the desktop. Both start with Windows; stop them with `just manager-stop` / `just stop`.

## Commands

Run `just` with no arguments to list every recipe. The ones you'll use daily:

| Command | What it does |
| --- | --- |
| `just web` | Open the Account Manager (starts it if needed) |
| `just usage` | Open the usage page |
| `just start` / `just stop` / `just restart` | Show, close or restart the widget |
| `just widget-poll 5` | Fetch usage every 5 minutes (default 15) |
| `just remote <url> <token>` | Make the widget follow a server's accounts (`just remote-off` to undo) |
| `just widget-update` | Install the latest widget release (checksum-verified) |
| `just test` | Every suite: Rust, web unit, web e2e (local + server mode) |
| `just docker-build` / `just docker-run` | Build and try the server image locally |
| `just claudex` | Launch Claude Code (Sonnet, all permissions) |
| `just claudel` | Launch Claude Code on the self-hosted model (needs `claude-local`: `/setup-claude-local`) |

## Troubleshooting

### "The Claude Code login already stopped: Login successful"

Fixed in the current kit (the page used a sign-in link that finished the login behind its back).
Update with `git pull` then `just manager-build`, and **Re-login** that account.

### An account shows the same email as another

The browser was already signed in to another account. Click **Re-login** on the wrong one; the
sign-in window is always a fresh, cookie-free Edge profile.

### `just widget-update` says "SHA-256 mismatch"

Update the kit (`git pull`): older kits could not hash under Windows PowerShell 5.1 started by `just`
from PowerShell 7 and reported that as a mismatch.

### Server page says "Forbidden host", or the browser shows ERR_SSL_PROTOCOL_ERROR

Open the exact address in `ACCTMGR_PUBLIC_ORIGIN` (scheme, host and port). IP addresses are
refused by design, and `http://` vs `https://` must match how the server is deployed.

More in [`.docs/06-troubleshooting/common-issues.md`](.docs/06-troubleshooting/common-issues.md).

## Project layout

```
Claude-Code-Usage-Monitor/
├── src/                 # the widget (Rust, Windows): reads accounts.db or a server
├── web/                 # Account Manager (SvelteKit + node:sqlite), local + server mode
│   └── Dockerfile       # server image (Claude Code CLI inside)
├── deploy/              # docker compose + Cloudflare tunnel / HTTPS overlays, .env.example
├── kit/                 # PowerShell helpers used by setup.ps1 and the justfile
├── site/                # setup guide (GitHub Pages, gh-pages branch)
├── docs/                # design contract, upstream README, updater + security notes
├── .docs/               # project documentation (start at tldr.md)
├── setup.ps1            # idempotent machine setup
├── install.ps1          # no-clone one-liner installer
└── justfile             # every recipe
```

## License

MIT — see [LICENSE](LICENSE). The widget is © Code Zeno Pty Ltd (upstream); the multi-account
additions follow the same license.
