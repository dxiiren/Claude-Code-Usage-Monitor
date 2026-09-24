# Claude Code Usage Monitor -- multi-account recipes

set shell := ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]

kit := "Import-Module '" + justfile_directory() + "\\kit\\UsageKit.psm1' -Force -DisableNameChecking"

# List available recipes
default:
    @just --list

# ─── Guards ───────────────────────────────────────────────

# Node -- installed by setup.ps1; runs the Account Manager.
[private]
_require-node:
    @if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error "node not found on PATH.`n  -> Run setup.ps1 first:  powershell -ExecutionPolicy Bypass -File ./setup.ps1"; exit 1 }

# Cargo -- only for building the widget from source.
[private]
_require-cargo:
    @if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Write-Error "cargo not found on PATH.`n  -> Install Rust: https://rustup.rs (plus MSVC build tools)"; exit 1 }

# ─── Setup ───────────────────────────────────────────────

# Full idempotent setup: Claude Code, Node, widget, Account Manager, startup, shortcuts.
setup:
    & '{{justfile_directory()}}\setup.ps1'

# ─── Account Manager (web app) ───────────────────────────

# Open the Account Manager (add accounts, paste the code) -- starts it if needed.
web: _require-node
    {{kit}}; if (-not (Start-Manager)) { Write-Error "Account Manager did not start"; exit 1 }; Start-Process "http://127.0.0.1:47291/"

# Open the usage page in the browser.
usage: _require-node
    {{kit}}; if (-not (Start-Manager)) { Write-Error "Account Manager did not start"; exit 1 }; Start-Process "http://127.0.0.1:47291/usage"

# Start the Account Manager in the background (no window).
manager-start: _require-node
    {{kit}}; if (Start-Manager) { Write-Host "Running: http://127.0.0.1:47291" } else { Write-Error "did not start"; exit 1 }

# Stop the Account Manager.
manager-stop:
    {{kit}}; Stop-Manager; Write-Host "Stopped"

# Rebuild the Account Manager after changing web/ (npm ci + build), then restart it.
manager-build: _require-node
    {{kit}}; Stop-Manager; Install-ManagerApp; [void](Start-Manager)

# Run the Account Manager in dev mode (hot reload) on its dev port.
web-dev: _require-node
    Set-Location '{{justfile_directory()}}\web'; npm run dev

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

# Build the widget from source (cargo --release) and install it.
widget-build: _require-cargo
    {{kit}}; Install-MonitorFromSource; Start-Monitor

# Download the latest widget release from this fork and install it.
widget-update:
    {{kit}}; Install-MonitorRelease; Start-Monitor

# Point the widget at a server, e.g. `just remote https://claude.yanasharif.com <token>`
# (token: server page -> Widget tokens). Accounts then come from that server.
remote url token:
    {{kit}}; Set-RemoteServer '{{url}}' '{{token}}'

# Widget back to this PC's own accounts.
remote-off:
    {{kit}}; Set-RemoteServer '' ''

# Widget + Account Manager start with Windows.
startup-on:
    {{kit}}; Enable-Startup

# Stop both starting with Windows.
startup-off:
    {{kit}}; Disable-Startup

# ─── Tests ───────────────────────────────────────────────

# Every suite: Rust unit tests, web unit tests, web end-to-end tests.
# (Skips 2 window tests that fail identically on untouched upstream -- see .github/workflows/tests.yml.)
test: _require-cargo _require-node
    Set-Location '{{justfile_directory()}}'; cargo test --locked -- --skip detaching_a_child_never_exposes_parent_relative_coordinates_as_a_popup --skip docking_rebinds_layered_surface_only_when_parent_changes; if ($LASTEXITCODE -ne 0) { exit 1 }; Set-Location web; npm run test:all; if ($LASTEXITCODE -ne 0) { exit 1 }

# ─── Tools ───────────────────────────────────────────────

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
