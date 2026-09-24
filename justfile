# Claude Code Usage Monitor -- multi-account recipes

set shell := ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

kit := "Import-Module '" + justfile_directory() + "\\kit\\UsageKit.psm1' -Force -DisableNameChecking"

# List available recipes
default:
    @just --list

# ─── Guards ───────────────────────────────────────────────

# Claude Code -- installed by setup.ps1; every login/status call goes through it.
[private]
_require-claude:
    @if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Error "claude not found on PATH.`n  -> Run setup.ps1 first:  powershell -ExecutionPolicy Bypass -File ./setup.ps1"; exit 1 }

# ─── Setup ───────────────────────────────────────────────

# Full idempotent setup: install, log in missing accounts, theme, startup, verify.
setup:
    & '{{justfile_directory()}}\setup.ps1'

# Set the account list, e.g. `just accounts ba,kv,newgen,etl` (first = main ~/.claude login).
accounts names:
    {{kit}}; Set-UsageAccounts ('{{names}}' -split ','); Write-UsageTheme (Get-UsageAccounts); Stop-Monitor; Write-MonitorSettings (Get-UsageAccounts); Start-Monitor

# Log one account in (fresh isolated browser window, paste the code back).
login name: _require-claude
    {{kit}}; $a = Get-UsageAccounts | Where-Object Name -eq '{{name}}'; if (-not $a) { Write-Error "No account '{{name}}' in kit/accounts.json"; exit 1 }; if (-not (Invoke-AccountLogin $a)) { exit 1 }

# Show every account: login email, 5-hour and weekly usage with reset times.
status: _require-claude
    {{kit}}; Show-UsageStatus

# Restart the widget in diagnostic mode and prove every account returns live usage.
verify: _require-claude
    {{kit}}; if (-not (Test-UsageMonitor)) { exit 1 }

# Regenerate the widget card from kit/accounts.json (after renaming/adding accounts).
theme:
    {{kit}}; $a = Get-UsageAccounts; Stop-Monitor; Write-UsageTheme $a; Write-MonitorSettings $a; Start-Monitor

# ─── Widget lifecycle ────────────────────────────────────

# Show the widget.
start:
    {{kit}}; Start-Monitor

# Close the widget.
stop:
    {{kit}}; Stop-Monitor; Write-Host "Stopped"

# Close and reopen the widget.
restart:
    {{kit}}; Stop-Monitor; Start-Monitor

# Start the widget when Windows starts.
startup-on:
    {{kit}}; Enable-MonitorStartup

# Stop starting the widget with Windows.
startup-off:
    {{kit}}; Disable-MonitorStartup

# ─── Tools ───────────────────────────────────────────────

# Open Claude Code as one of your accounts, e.g. `just claude kv`.
claude name: _require-claude
    {{kit}}; $a = Get-UsageAccounts | Where-Object Name -eq '{{name}}'; if (-not $a) { Write-Error "No account '{{name}}'"; exit 1 }; if ($a.IsDefault) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:CLAUDE_CONFIG_DIR = $a.FullDir }; claude

# Open the setup guide website.
guide:
    Start-Process "https://dxiiren.github.io/Claude-Code-Usage-Monitor/"

# Launch Claude Code with all permissions — Sonnet (latest)
claudex:
    claude --dangerously-skip-permissions --model sonnet

# Launch Claude Code with all permissions — Opus (latest)
claudeo:
    claude --dangerously-skip-permissions --model opus

# Launch Claude Code with all permissions — Haiku (latest)
claudeh:
    claude --dangerously-skip-permissions --model haiku
