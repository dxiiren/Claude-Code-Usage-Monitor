#!/usr/bin/env pwsh

# Claude Code Usage Monitor -- Multi-Account Setup
#
# One widget, every Claude account: 5-hour and weekly usage with reset countdowns.
# Works on a FRESH PC -- only prerequisites are PowerShell and winget.
# Safe to re-run (idempotent) -- skips what is already done, logs in only the accounts
# that are not logged in yet.
#
# Usage:  powershell -ExecutionPolicy Bypass -File ./setup.ps1
#         powershell -ExecutionPolicy Bypass -File ./setup.ps1 -Accounts ba,kv,newgen,etl
# Note: run from PowerShell, NOT cmd.exe.

param(
    # Account names, first = your main login (~/.claude). Saved to kit/accounts.json.
    [string[]]$Accounts,
    # Skip the login step (just refresh widget config).
    [switch]$SkipLogin,
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

# ---------- 1. Claude Code CLI ----------
Refresh-Path
if (Test-Command "claude") {
    $claudeVer = & claude --version 2>&1 | Select-Object -First 1
    Write-Host "[OK] Claude Code already installed: $claudeVer" -ForegroundColor Green
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

# ---------- 2. Claude Code Usage Monitor (the widget) ----------
if (Get-MonitorExe) {
    Write-Host "[OK] Usage Monitor already installed: $(Get-MonitorExe)" -ForegroundColor Green
} elseif ($hasWinget) {
    if (-not (Install-Winget "CodeZeno.ClaudeCodeUsageMonitor" "Claude Code Usage Monitor")) {
        Write-Host "[FAIL] Usage Monitor install failed via winget" -ForegroundColor Red
        exit 1
    }
    if (-not (Get-MonitorExe)) {
        Write-Host "[FAIL] Usage Monitor installed but its exe was not found. Re-run setup." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Usage Monitor installed: $(Get-MonitorExe)" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Usage Monitor missing and winget unavailable. Get it from https://github.com/CodeZeno/Claude-Code-Usage-Monitor/releases" -ForegroundColor Red
    exit 1
}

# ---------- 3. just (task runner for the everyday recipes) ----------
Refresh-Path
if (Test-Command "just") {
    Write-Host "[OK] just already installed: $(& just --version 2>&1 | Select-Object -First 1)" -ForegroundColor Green
} elseif ($hasWinget -and (Install-Winget "Casey.Just" "just")) {
    if (Test-Command "just") {
        Write-Host "[OK] just installed: $(& just --version 2>&1 | Select-Object -First 1)" -ForegroundColor Green
    } else {
        Write-Host "[WARN] just installed but not on PATH yet. Close and reopen PowerShell before using 'just'." -ForegroundColor Yellow
    }
} else {
    Write-Host "[WARN] just not installed -- the widget still works; recipes need it (https://just.systems)." -ForegroundColor Yellow
}

# The widget writes its settings.json on first launch -- let it, before we edit it.
if (-not (Test-Path (Join-Path $env:APPDATA 'ClaudeCodeUsageMonitor\settings.json'))) {
    Write-Host "[INFO] First launch of the widget to create its settings..." -ForegroundColor Cyan
    Start-Monitor
    for ($i = 0; $i -lt 20 -and -not (Test-Path (Join-Path $env:APPDATA 'ClaudeCodeUsageMonitor\settings.json')); $i++) { Start-Sleep -Milliseconds 500 }
}

# ---------- 4. Accounts ----------
Write-Host ""
Write-Host "Accounts..." -ForegroundColor Cyan
if ($Accounts) {
    Set-UsageAccounts (@($Accounts) | ForEach-Object { $_ -split ',' })
} else {
    Initialize-AccountsFile
}
$acctList = Get-UsageAccounts
foreach ($a in $acctList) { Write-Host "  - $($a.Name)  ->  $($a.Dir)" -ForegroundColor Gray }

# ---------- 5. Log in each account (only the ones not logged in yet) ----------
Write-Host ""
Write-Host "Logins..." -ForegroundColor Cyan
$notLoggedIn = @()
foreach ($a in $acctList) {
    $auth = Get-AccountAuth $a
    if ($auth.LoggedIn) {
        Write-Host "[OK] $($a.Name) logged in as $($auth.Email) ($($auth.Plan))" -ForegroundColor Green
    } elseif ($SkipLogin) {
        Write-Host "[WARN] $($a.Name) is not logged in (skipped: -SkipLogin). Later: just login $($a.Name)" -ForegroundColor Yellow
        $notLoggedIn += $a.Name
    } else {
        if (-not (Invoke-AccountLogin $a)) { $notLoggedIn += $a.Name }
    }
}

# ---------- 6. Widget theme + settings ----------
Write-Host ""
Write-Host "Configuring the widget..." -ForegroundColor Cyan
Stop-Monitor
Write-UsageTheme $acctList
Write-MonitorSettings $acctList

# ---------- 7. Start with Windows + shortcuts ----------
if ($NoStartup) { Write-Host "[INFO] Start with Windows skipped (-NoStartup)" -ForegroundColor Cyan } else { Enable-MonitorStartup }
if ($NoShortcuts) { Write-Host "[INFO] Shortcuts skipped (-NoShortcuts)" -ForegroundColor Cyan } else { New-MonitorShortcuts }

# ---------- Final verification (live poll of every account) ----------
Write-Host ""
Write-Host "Verifying: restarting the widget and waiting for a live reading per account..." -ForegroundColor Cyan
$allOk = Test-UsageMonitor

Write-Host ""
if ($allOk) {
    Write-Host "Setup complete! Every account reports live usage." -ForegroundColor Green
} else {
    Write-Host "Setup finished with problems -- see [FAIL] lines above." -ForegroundColor Yellow
    if ($notLoggedIn.Count -gt 0) { Write-Host "  Not logged in: $($notLoggedIn -join ', ')  ->  just login <name>" -ForegroundColor Yellow }
}
Write-Host ""

# ---------- Next steps (manual) ----------
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1) The card is on screen now. Drag it anywhere; double-click = dashboard; X = close." -ForegroundColor Gray
Write-Host "  2) Reopen after closing:   'Claude Usage' shortcut, or: just start" -ForegroundColor Gray
Write-Host "  3) Numbers in the terminal: just status" -ForegroundColor Gray
Write-Host "  4) Use an account in Claude Code: just claude <name>" -ForegroundColor Gray
Write-Host ""
