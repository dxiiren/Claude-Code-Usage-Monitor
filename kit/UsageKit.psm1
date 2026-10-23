# UsageKit -- install/run helpers for the widget + Account Manager.
#
# Shared by setup.ps1 and the justfile. Windows PowerShell 5.1 compatible (no ternary / ??).
# Accounts are NOT managed here any more: the Account Manager web app (web/, SQLite at
# %APPDATA%\ClaudeCodeUsageMonitor\accounts.db) owns them, and the widget reads that DB.
# See docs/account-manager-contract.md.

# Windows PowerShell 5.1 started from a PowerShell 7 session (e.g. `just` run in pwsh) inherits
# pwsh's PSModulePath, and then cannot autoload its own built-in modules: Get-FileHash and
# Get-CimInstance fail with CommandNotFoundException. Drop the PowerShell 7 entries.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = (($env:PSModulePath -split ';') |
        Where-Object { $_ -and $_ -notmatch '\\PowerShell\\7' -and $_ -notmatch '\\Documents\\PowerShell\\Modules' }) -join ';'
}

$script:KitDir       = $PSScriptRoot
$script:RepoDir      = Split-Path $PSScriptRoot -Parent
$script:WebDir       = Join-Path $script:RepoDir 'web'
$script:AppDataDir   = Join-Path $env:APPDATA 'ClaudeCodeUsageMonitor'
$script:InstallDir   = Join-Path $env:LOCALAPPDATA 'Programs\ClaudeUsageMonitor'
$script:WidgetExe    = Join-Path $script:InstallDir 'claude-code-usage-monitor.exe'
$script:ReleaseRepo  = 'dxiiren/Claude-Code-Usage-Monitor'
$script:ManagerUrl   = 'http://127.0.0.1:47291'
$script:RunKey       = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunWidget    = 'ClaudeCodeUsageMonitor'   # same value the widget's own "Start with Windows" uses
$script:RunManager   = 'ClaudeUsageManager'

function Write-Ok($Msg)   { Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Info($Msg) { Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function Write-Warn($Msg) { Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Fail($Msg) { Write-Host "[FAIL] $Msg" -ForegroundColor Red }

# ---------- Widget (our build, not the upstream WinGet package) ----------

# Our build: the exe from this fork's GitHub release (or a local cargo build), installed
# portable under %LOCALAPPDATA%\Programs. Its updater follows the fork's releases.
function Get-MonitorExe {
    if (Test-Path $script:WidgetExe) { return $script:WidgetExe }
    return $null
}

# The upstream WinGet build does not read accounts.db; if present it must not autostart.
function Get-UpstreamMonitorExe {
    $pkgRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (-not (Test-Path $pkgRoot)) { return $null }
    $hit = Get-ChildItem $pkgRoot -Directory -Filter 'CodeZeno.ClaudeCodeUsageMonitor*' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem $_.FullName -Filter 'claude-code-usage-monitor.exe' -ErrorAction SilentlyContinue } |
        Select-Object -First 1
    if ($hit) { return $hit.FullName }
    return $null
}

function Stop-Monitor {
    Get-Process claude-code-usage-monitor -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
}

function Start-Monitor([switch]$Diagnose) {
    $exe = Get-MonitorExe
    if (-not $exe) { throw "Widget not installed. Run setup.ps1." }
    if ($Diagnose) { Start-Process $exe -ArgumentList '--diagnose' } else { Start-Process $exe }
}

function Install-MonitorRelease {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $rel = Invoke-RestMethod "https://api.github.com/repos/$script:ReleaseRepo/releases/latest" -Headers @{ 'User-Agent' = 'claude-usage-setup' }
    $asset = @($rel.assets) | Where-Object { $_.name -eq 'claude-code-usage-monitor.exe' } | Select-Object -First 1
    if (-not $asset) { throw "Release $($rel.tag_name) has no claude-code-usage-monitor.exe asset." }
    New-Item -ItemType Directory -Force $script:InstallDir | Out-Null
    $tmp = "$script:WidgetExe.download"
    Invoke-WebRequest $asset.browser_download_url -OutFile $tmp -UseBasicParsing
    if ($asset.digest -and $asset.digest -like 'sha256:*') {
        $want = $asset.digest.Substring(7).ToLower()
        # .NET, not Get-FileHash: works in any host even if module autoloading is broken.
        $stream = [IO.File]::OpenRead($tmp)
        try { $got = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
        finally { $stream.Dispose() }
        if ($want -ne $got) { Remove-Item $tmp -Force; throw "SHA-256 mismatch for the downloaded widget." }
    }
    Stop-Monitor
    Move-Item $tmp $script:WidgetExe -Force
    Write-Ok "Widget $($rel.tag_name) installed: $script:WidgetExe"
}

# Local build from this repo (needs Rust + MSVC). Used by `just widget-build`.
function Install-MonitorFromSource {
    Push-Location $script:RepoDir
    try {
        & cargo build --release
        if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
    } finally { Pop-Location }
    New-Item -ItemType Directory -Force $script:InstallDir | Out-Null
    Stop-Monitor
    Copy-Item (Join-Path $script:RepoDir 'target\release\claude-code-usage-monitor.exe') $script:WidgetExe -Force
    Write-Ok "Widget built from source and installed: $script:WidgetExe"
}

# ---------- Account Manager (web app) ----------

function Install-ManagerApp {
    Push-Location $script:WebDir
    try {
        # Through cmd so npm's stderr progress is plain text, not a red NativeCommandError in 5.1.
        & cmd.exe /c "npm ci --no-audit --no-fund 2>&1" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
        & cmd.exe /c "npm run build 2>&1" | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally { Pop-Location }
    Write-Ok "Account Manager built: $(Join-Path $script:WebDir 'build')"
}

function Get-ManagerProcess {
    $start = Join-Path $script:WebDir 'start.js'
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$start*" }
}

function Stop-Manager {
    Get-ManagerProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Test-ManagerUp {
    try { return ((Invoke-WebRequest $script:ManagerUrl -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) } catch { return $false }
}

function Start-Manager {
    if (Test-ManagerUp) { return $true }
    Start-Process wscript.exe -ArgumentList "`"$(Join-Path $script:KitDir 'manager.vbs')`""
    for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; if (Test-ManagerUp) { return $true } }
    return $false
}

# ---------- Remote mode (widget reads a server's Account Manager) ----------

# Sets or clears settings.json remote_server_url / remote_server_token (see
# docs/account-manager-contract.md "Widget remote mode"), then restarts the widget.
function Set-RemoteServer([string]$Url, [string]$Token) {
    $file = Join-Path $script:AppDataDir 'settings.json'
    if (-not (Test-Path $file)) { throw "Widget settings not found; start the widget once first." }
    Stop-Monitor
    $s = Get-Content $file -Raw | ConvertFrom-Json
    foreach ($pair in @(@('remote_server_url', $Url), @('remote_server_token', $Token))) {
        if ($s.PSObject.Properties[$pair[0]]) { $s.($pair[0]) = $pair[1] }
        else { $s | Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1] }
    }
    [IO.File]::WriteAllText($file, (ConvertTo-Json $s -Depth 20), (New-Object System.Text.UTF8Encoding $false))
    Start-Monitor
    if ($Url) { Write-Ok "Widget now reads $Url (token saved in settings.json)" }
    else { Write-Ok "Widget back to local accounts" }
}

# How often the widget fetches usage (settings.json poll_interval_ms), then restart it.
function Set-PollInterval([int]$Minutes) {
    if ($Minutes -lt 1 -or $Minutes -gt 120) { throw "Use 1-120 minutes (the usage endpoint is rate limited; 5 is a good default)." }
    $file = Join-Path $script:AppDataDir 'settings.json'
    if (-not (Test-Path $file)) { throw "Widget settings not found; start the widget once first." }
    Stop-Monitor
    $s = Get-Content $file -Raw | ConvertFrom-Json
    if ($s.PSObject.Properties['poll_interval_ms']) { $s.poll_interval_ms = $Minutes * 60000 }
    else { $s | Add-Member -NotePropertyName poll_interval_ms -NotePropertyValue ($Minutes * 60000) }
    [IO.File]::WriteAllText($file, (ConvertTo-Json $s -Depth 20), (New-Object System.Text.UTF8Encoding $false))
    Start-Monitor
    Write-Ok "Widget fetches usage every $Minutes minute(s)"
}

# ---------- Compact taskbar strip (opt-in) ----------

# One strip per account, three short lines each (name, 5h, 7d), reset times in Kuala Lumpur time (MYT, UTC+8):
#   BA
#   5h 42% 23/10 14:30
#   7d 61% 27/10 09:00
# Writes themes\compact-usage-myt.json from the account list (the Account Manager's list in
# remote mode, else settings.json profiles), makes it the active theme, docks it at the
# left or right end of the taskbar, then restarts the widget. `-Side off` goes back to the
# built-in widget. Nothing changes unless this is run.
function Set-CompactTaskbar([ValidateSet('left','right','off')][string]$Side = 'left') {
    $file = Join-Path $script:AppDataDir 'settings.json'
    if (-not (Test-Path $file)) { throw "Widget settings not found; start the widget once first." }
    Stop-Monitor
    $s = Get-Content $file -Raw | ConvertFrom-Json
    $set = {
        param($name, $value)
        if ($s.PSObject.Properties[$name]) { $s.$name = $value }
        else { $s | Add-Member -NotePropertyName $name -NotePropertyValue $value }
    }
    if ($Side -eq 'off') {
        & $set 'custom_theme_enabled' $false
        & $set 'active_theme_path' $null
        [IO.File]::WriteAllText($file, (ConvertTo-Json $s -Depth 20), (New-Object System.Text.UTF8Encoding $false))
        Start-Monitor
        Write-Ok "Compact taskbar strip off (built-in widget)"
        return
    }
    $accounts = @()
    $remote = Join-Path $script:AppDataDir 'remote-accounts.json'
    if ($s.remote_server_url -and (Test-Path $remote)) {
        foreach ($a in @((Get-Content $remote -Raw | ConvertFrom-Json).accounts)) {
            $accounts += [pscustomobject]@{ Provider = $a.provider; Id = $a.id; Name = $a.name }
        }
    } else {
        foreach ($prov in 'claude', 'codex') {
            $block = $s.accounts.$prov
            if ($block) { foreach ($a in @($block.profiles)) { if ($a.enabled) { $accounts += [pscustomobject]@{ Provider = $prov; Id = $a.id; Name = $a.name } } } }
        }
    }
    if ($accounts.Count -eq 0) { throw "No accounts found to show." }
    $children = New-Object System.Collections.ArrayList
    $text = {
        param($id, $x, $y, $w, $h, $render, $template, $weight, $size)
        foreach ($mode in @(@('dark', 'system.dark', '#F1F5F9FF'), @('light', '1 - system.dark', '#111827FF'))) {
            [void]$children.Add([ordered]@{
                id = "$id-$($mode[0])"; name = "$id $($mode[0])"
                render = "($render) * ($($mode[1]))"; visibility = '100'
                x = "$x"; y = "$y"; width = "$w"; height = "$h"
                background = @{ type = 'none' }; border = $null; corner_radius = '0'
                layout = 'freeform'; align = 'start'; gap = '0'
                content = [ordered]@{
                    type = 'text'; template = $template; font_family = 'Segoe UI'; font_size = "$size"
                    weight = $weight; rendering = 'clear_type'; contrast = '1'; align = 'left'
                    color = @{ color = $mode[2]; opacity = '1' }
                }
            })
        }
    }
    $x = 0
    $n = 0
    foreach ($a in $accounts) {
        $n++
        $p = "accounts.$($a.Provider).$($a.Id)"
        $ok = "1 - $p.login_required"
        $colW = 106
        $tpl5 = "5h {$p.five_hour.percentage:0}% {$p.five_hour.reset.unix:myt_dm_hm}"
        $tpl7 = "7d {$p.weekly.percentage:0}% {$p.weekly.reset.unix:myt_dm_hm}"
        & $text "n$n" $x 1 $colW 14 '1' $a.Name 'semibold' 10
        & $text "a$n" $x 15 $colW 14 $ok $tpl5 'medium' 10.5
        & $text "b$n" $x 29 $colW 14 $ok $tpl7 'medium' 10.5
        & $text "x$n" $x 15 $colW 14 "$p.login_required" 'Expired - re-login' 'semibold' 10.5
        $x = $x + $colW + 6
    }
    $horizontal = if ($Side -eq 'left') { 'left' } else { 'right' }
    $theme = [ordered]@{
        schema_version = 1; id = 'compact-usage-myt'; name = 'Compact usage (MYT)'
        surfaces = @([ordered]@{
            id = 'main'; name = 'Compact taskbar strip'; render = '1'; visibility = '100'
            placement = [ordered]@{
                reference = @{ region = $(if ($Side -eq 'left') { 'taskbar' } else { 'system_tray' }); display = 0 }
                nest = 'taskbar'; horizontal = $horizontal; vertical = 'bottom'
                surface_horizontal = $horizontal; surface_vertical = 'bottom'
                offset_x = $(if ($Side -eq 'left') { 8 } else { -6 }); offset_y = 0
            }
            width = "$($x - 6)"; height = '46'
            background = @{ type = 'none' }; border = $null
            mouse_events = [ordered]@{ double_click = 'show_dashboard()'; right_click = 'show_context_menu("classic-v1")' }
            corner_radius = '0'; layout = 'freeform'; align = 'start'; gap = '0'
            content = @{ type = 'none' }
            children = @($children)
        })
    }
    $dir = Join-Path $script:AppDataDir 'themes'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $themeFile = Join-Path $dir 'compact-usage-myt.json'
    [IO.File]::WriteAllText($themeFile, (ConvertTo-Json $theme -Depth 30), (New-Object System.Text.UTF8Encoding $false))
    & $set 'active_theme_path' $themeFile
    & $set 'custom_theme_enabled' $true
    # Drop any saved drag/float position so the theme's own placement applies.
    if ($s.PSObject.Properties['placement_override']) { $s.PSObject.Properties.Remove('placement_override') }
    [IO.File]::WriteAllText($file, (ConvertTo-Json $s -Depth 20), (New-Object System.Text.UTF8Encoding $false))
    Start-Monitor
    Write-Ok "Compact taskbar strip on the $Side of the taskbar for $($accounts.Count) account(s) (reset times in MYT)"
}

# ---------- Startup + shortcuts ----------

function Enable-Startup {
    Set-ItemProperty $script:RunKey -Name $script:RunWidget -Value $script:WidgetExe
    Set-ItemProperty $script:RunKey -Name $script:RunManager -Value "wscript.exe `"$(Join-Path $script:KitDir 'manager.vbs')`""
    Write-Ok "Widget + Account Manager start with Windows"
}

function Disable-Startup {
    Remove-ItemProperty $script:RunKey -Name $script:RunWidget -ErrorAction SilentlyContinue
    Remove-ItemProperty $script:RunKey -Name $script:RunManager -ErrorAction SilentlyContinue
    Write-Ok "Widget + Account Manager no longer start with Windows"
}

function New-Shortcuts {
    $ws = New-Object -ComObject WScript.Shell
    foreach ($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
        $lnk = $ws.CreateShortcut((Join-Path $d 'Claude Usage.lnk'))
        $lnk.TargetPath = $script:WidgetExe
        $lnk.WorkingDirectory = $script:InstallDir
        $lnk.IconLocation = "$script:WidgetExe,0"
        $lnk.Description = 'Claude usage widget'
        $lnk.Save()
        # .url shortcut: opens the page; starts nothing (the manager autostarts with Windows).
        Set-Content (Join-Path $d 'Claude Accounts.url') "[InternetShortcut]`r`nURL=$script:ManagerUrl/`r`nIconFile=$script:WidgetExe`r`nIconIndex=0" -Encoding ASCII
    }
    Write-Ok "Shortcuts: 'Claude Usage' (widget) and 'Claude Accounts' (web page), Desktop + Start menu"
}

# The card's X button opens this one-item menu (Exit); the web app's theme references it.
function Install-CloseMenu {
    $menuDir = Join-Path $script:AppDataDir 'context-menus'
    New-Item -ItemType Directory -Force $menuDir | Out-Null
    Copy-Item (Join-Path $script:KitDir 'close-menu.json') (Join-Path $menuDir 'close-menu.json') -Force
}

Export-ModuleMember -Function Write-Ok, Write-Info, Write-Warn, Write-Fail, Get-MonitorExe, Get-UpstreamMonitorExe,
    Stop-Monitor, Start-Monitor, Install-MonitorRelease, Install-MonitorFromSource, Install-ManagerApp,
    Get-ManagerProcess, Stop-Manager, Test-ManagerUp, Start-Manager, Enable-Startup, Disable-Startup, New-Shortcuts,
    Install-CloseMenu, Set-RemoteServer, Set-PollInterval, Set-CompactTaskbar
