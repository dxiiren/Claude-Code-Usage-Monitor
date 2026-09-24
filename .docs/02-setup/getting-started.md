# Getting started

## 1. Install (once per PC)

Either clone and run the setup:

```powershell
git clone https://github.com/dxiiren/Claude-Code-Usage-Monitor
cd Claude-Code-Usage-Monitor
powershell -ExecutionPolicy Bypass -File ./setup.ps1
```

or, with no Git, the one-liner (downloads to `%USERPROFILE%\claude-usage-monitor`):

```powershell
irm https://raw.githubusercontent.com/dxiiren/Claude-Code-Usage-Monitor/main/install.ps1 | iex
```

`setup.ps1` installs what is missing (Claude Code CLI, Node.js 22.13+, just), downloads the widget
release (SHA-256 checked) to `%LOCALAPPDATA%\Programs\ClaudeUsageMonitor`, builds the Account
Manager, makes both start with Windows, adds the **Claude Usage** and **Claude Accounts** shortcuts,
and verifies each piece. Flags: `-WidgetFromSource` (build with cargo), `-NoStartup`, `-NoShortcuts`.

Close and reopen PowerShell afterwards so PATH changes land.

## 2. Add your accounts

`just web` (or the **Claude Accounts** shortcut, or the widget's right-click → **Manage accounts**):

1. Type a short name (e.g. `work`) → **Start**. A fresh Edge window opens with the Claude sign-in
   page — no cookies, so your usual browser session cannot sign the wrong account in.
2. Sign in with that account and click **Authorize**; copy the code the page shows.
3. Paste it → **Connect**. The page shows which email got connected; if two accounts share an
   email it warns you — click **Re-login** on the wrong one.

The widget picks the change up within about 5 seconds.

## 3. Tune freshness (optional)

`just widget-poll 5` — fetch usage every 5 minutes (upstream default 15). Lower values risk the
usage endpoint's rate limit.

## 4. Follow a server instead (optional)

On the server's **Widget tokens** page create a token (shown once), then
`just remote https://your-server <token>`. `just remote-off` switches back to this PC's accounts.
