# Account Manager contract (web app <-> widget)

The Account Manager web app (`web/`) owns the list of Claude accounts. The widget (Rust,
`src/`) reads that list. They share one SQLite file and nothing else.

## Database

Path: `%APPDATA%\ClaudeCodeUsageMonitor\accounts.db` (the widget's existing app-data folder).
Rollback journal (default), NOT WAL: the widget reads through Windows' `winsqlite3.dll`
read-only, and a read-only connection cannot recover a WAL file.

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,            -- slug: lowercase [a-z0-9_-], stable, never reused for another person
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
