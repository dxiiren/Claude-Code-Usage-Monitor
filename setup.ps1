#!/usr/bin/env pwsh

# Claude Code Usage Monitor -- Multi-Account Setup
#
# Installs the widget (this fork's build: reads accounts from the Account Manager) and the
# Account Manager web app (http://127.0.0.1:47291), makes both start with Windows, and adds
# shortcuts. Accounts are then added in the web page: type a name, sign in, paste the code.
# Works on a FRESH PC -- only prerequisites are PowerShell and winget.
# Safe to re-run (idempotent) -- skips what is already done.
#
# Usage: powershell -ExecutionPolicy Bypass -File ./setup.ps1
# Note: run from PowerShell, NOT cmd.exe.

param(
    # Build the widget from this repo (Rust + MSVC) instead of downloading the release exe.
    [switch]$WidgetFromSource,
    # Do not register "start with Windows".
    [switch]$NoStartup,
    # Do not create the Desktop / Start menu shortcuts.
    [switch]$NoShortcuts
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Test-Command($Name) {
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
    # Reload PATH from registry so newly installed tools are found in this session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Install-Winget($PackageId, $DisplayName) {
    Write-Host "[INSTALL] Installing $DisplayName via winget ($PackageId)..." -ForegroundColor Yellow
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & winget install --id $PackageId --exact --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Host
    $code = $LASTEXITCODE
    $ErrorActionPreference = $savedEAP
    Refresh-Path
    # winget returns 0 on fresh install, -1978335189 (0x8A15002B) when already installed -- both are fine
    return ($code -eq 0 -or $code -eq -1978335189)
}

Import-Module (Join-Path $PSScriptRoot 'kit\UsageKit.psm1') -Force -DisableNameChecking

Write-Host ""
Write-Host "Claude Code Usage Monitor -- Multi-Account Setup" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ---------- 0. Prerequisites check ----------
Refresh-Path
$hasWinget = Test-Command "winget"
if (-not $hasWinget) {
    Write-Host "[WARN] winget not found. Install App Installer from the Microsoft Store to enable it." -ForegroundColor Yellow
}

# ---------- 1. Claude Code CLI (the Account Manager logs accounts in through it) ----------
Refresh-Path
if (Test-Command "claude") {
    Write-Host "[OK] Claude Code already installed: $(& claude --version 2>&1 | Select-Object -First 1)" -ForegroundColor Green
} else {
    Write-Host "[INSTALL] Installing Claude Code (native installer)..." -ForegroundColor Yellow
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    $localBin = Join-Path $HOME '.local\bin'
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$localBin*") { [System.Environment]::SetEnvironmentVariable("Path", "$userPath;$localBin", "User") }
    Refresh-Path
    if (Test-Command "claude") {
        Write-Host "[OK] Claude Code installed: $(& claude --version 2>&1 | Select-Object -First 1)" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Claude Code installed but not on PATH. Close and reopen PowerShell, then re-run." -ForegroundColor Red
        exit 1
    }
}

# ---------- 2. Node.js (runs the Account Manager; needs node:sqlite, Node 22.13+) ----------
Refresh-Path
$nodeOk = $false
if (Test-Command "node") {
    $v = [version]((& node -v) -replace '^v', '')
    $nodeOk = ($v -ge [version]'22.13.0')
}
if ($nodeOk) {
    Write-Host "[OK] Node.js already installed: $(node -v)" -ForegroundColor Green
} elseif ($hasWinget -and (Install-Winget "OpenJS.NodeJS.LTS" "Node.js (LTS)")) {
    if (Test-Command "node") {
        Write-Host "[OK] Node.js installed: $(node -v)" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Node.js installed but not on PATH. Close and reopen PowerShell, then re-run." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[FAIL] Node.js 22.13+ missing. Install from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# ---------- 3. just (task runner for the everyday recipes) ----------
Refresh-Path
if (Test-Command "just") {
    Write-Host "[OK] just already installed: $(& just --version 2>&1 | Select-Object -First 1)" -ForegroundColor Green
} elseif ($hasWinget -and (Install-Winget "Casey.Just" "just")) {
    if (Test-Command "just") { Write-Host "[OK] just installed" -ForegroundColor Green }
    else { Write-Host "[WARN] just installed but not on PATH yet. Reopen PowerShell before using 'just'." -ForegroundColor Yellow }
} else {
    Write-Host "[WARN] just not installed -- everything works without it; recipes need it (https://just.systems)." -ForegroundColor Yellow
}

# ---------- 4. The widget (this fork's build) ----------
if ($WidgetFromSource) {
    Install-MonitorFromSource
} else {
    Install-MonitorRelease
}
$upstream = Get-UpstreamMonitorExe
if ($upstream) {
    Write-Host "[INFO] The upstream WinGet widget is also installed; it does not read your accounts." -ForegroundColor Cyan
    Write-Host "       Leaving it installed but not running. Remove it any time: winget uninstall CodeZeno.ClaudeCodeUsageMonitor" -ForegroundColor DarkGray
}
Install-CloseMenu

# ---------- 5. Account Manager web app ----------
Write-Host ""
Write-Host "Building the Account Manager..." -ForegroundColor Cyan
Stop-Manager
Install-ManagerApp

# ---------- 6. Start with Windows + shortcuts ----------
if ($NoStartup) { Write-Host "[INFO] Start with Windows skipped (-NoStartup)" -ForegroundColor Cyan } else { Enable-Startup }
if ($NoShortcuts) { Write-Host "[INFO] Shortcuts skipped (-NoShortcuts)" -ForegroundColor Cyan } else { New-Shortcuts }

# ---------- Final verification ----------
Write-Host ""
Write-Host "Verifying..." -ForegroundColor Cyan
$failed = 0
if (Start-Manager) { Write-Ok "Account Manager answers on http://127.0.0.1:47291" } else { Write-Fail "Account Manager did not start (try: just manager-start)"; $failed++ }
Stop-Monitor
Start-Monitor
Start-Sleep -Seconds 3
$proc = Get-Process claude-code-usage-monitor -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc -and $proc.Path -ieq (Get-MonitorExe)) { Write-Ok "Widget running: $($proc.Path)" } else { Write-Fail "Widget is not running from $(Get-MonitorExe)"; $failed++ }
$menu = Join-Path $env:APPDATA 'ClaudeCodeUsageMonitor\context-menus\dashboard-v2.json'
if ((Test-Path $menu) -and ((Get-Content $menu -Raw) -match '47291')) { Write-Ok "Widget menu has 'Manage accounts'" } else { Write-Warn "Widget menu has no 'Manage accounts' item yet" }

Write-Host ""
if ($failed -eq 0) { Write-Host "Setup complete!" -ForegroundColor Green } else { Write-Host "Setup finished with problems -- see [FAIL] lines above." -ForegroundColor Yellow }
Write-Host ""

# ---------- Next steps (manual) ----------
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1) Add your accounts: open http://127.0.0.1:47291  (or the 'Claude Accounts' shortcut)" -ForegroundColor Gray
Write-Host "     Type a name -> a clean sign-in window opens -> sign in -> paste the code. Done." -ForegroundColor Gray
Write-Host "  2) The widget card updates by itself within seconds. Right-click it -> Manage accounts." -ForegroundColor Gray
Write-Host "  3) See usage in the browser: http://127.0.0.1:47291/usage" -ForegroundColor Gray
Write-Host ""
if ($failed -ne 0) { exit 1 }
