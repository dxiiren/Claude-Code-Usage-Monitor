# Project overview

A fork of [CodeZeno/Claude-Code-Usage-Monitor](https://github.com/CodeZeno/Claude-Code-Usage-Monitor)
(a Windows widget for Claude Code usage) that adds multi-account management.

## The three pieces

1. **Widget** (`src/`, Rust, Windows) — a small card on the desktop: per account, a 5-hour and a
   weekly bar with reset countdown; turns red at 90%, shows "Expired · re-login" when a login
   lapses. It reads its account list from `accounts.db` (reloading within ~5 s of any change), or
   from a server in **remote mode**.
2. **Account Manager** (`web/`, SvelteKit + Node's built-in `node:sqlite`) — the page where you add,
   rename, reorder, enable, re-login and remove accounts, plus a **Usage** page. Runs in two modes:
   - **local** (`http://127.0.0.1:47291`, starts with Windows): logs accounts in through the
     Claude Code CLI on this PC and writes the widget's card theme and settings.
   - **server** (Docker, `ACCTMGR_MODE=server`): the server holds the logins, polls usage itself,
     and needs a username + password; widgets read it with API tokens.
3. **Kit** (`setup.ps1`, `install.ps1`, `kit/`, `justfile`) — install, start-with-Windows,
   shortcuts, updates, and every day-to-day command.

## How data flows

```mermaid
flowchart LR
  subgraph PC[Windows PC]
    AM[Account Manager<br/>local mode :47291] -- writes --> DB[(accounts.db)]
    AM -- claude auth login --> CLI[Claude Code CLI]
    CLI -- login files --> CFG[.claude-&lt;id&gt; folders]
    W[Widget] -- reads --> DB
    W -- reads token, fetches usage --> CFG
  end
  subgraph SRV[Server - Docker]
    SAM[Account Manager<br/>server mode] -- polls usage --> ANT[(Anthropic usage API)]
    SAM --> SDB[(accounts.db + /data/accounts)]
  end
  W -. remote mode: GET /api/v1/widget + token .-> SAM
  W -- local mode --> ANT
```

## Design contract

Database schema, the widget's DB rules, server responsibilities, `GET /api/v1/widget` and remote
mode are specified in [`docs/account-manager-contract.md`](../../docs/account-manager-contract.md).
Change the contract first, then both sides.

## Deliberate limits

- Logins always go through the official Claude Code CLI; nothing here calls Anthropic's OAuth
  endpoints directly. Usage comes from the same endpoint the upstream widget uses.
- One Claude login per config folder; a login made on one server is independent of another.
