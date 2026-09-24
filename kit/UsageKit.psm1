# UsageKit -- multi-account setup for Claude Code Usage Monitor.
#
# Shared by setup.ps1 and the justfile recipes. Windows PowerShell 5.1 compatible
# (no ternary / ?? operators), so a fresh PC can run it before PowerShell 7 exists.
#
# Accounts live in kit/accounts.json (git-ignored; created from accounts.json.stub):
#   [ { "name": "ba", "dir": "~/.claude" }, { "name": "kv", "dir": "~/.claude-kv" } ]
# "~/.claude" is Claude Code's default login; every other account gets its own folder,
# selected with CLAUDE_CONFIG_DIR. No token ever touches this repo.

$script:KitDir      = $PSScriptRoot
$script:RepoDir     = Split-Path $PSScriptRoot -Parent
$script:AccountsFile = Join-Path $PSScriptRoot 'accounts.json'
$script:AccountsStub = Join-Path $PSScriptRoot 'accounts.json.stub'
$script:AppDataDir  = Join-Path $env:APPDATA 'ClaudeCodeUsageMonitor'
$script:SettingsFile = Join-Path $script:AppDataDir 'settings.json'
$script:ThemeFile   = Join-Path $script:AppDataDir 'themes\multi-claude-accounts.json'
$script:RunKey      = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunValue    = 'ClaudeCodeUsageMonitor'   # same value the app's own "Start with Windows" uses
$script:ShortcutName = 'Claude Usage.lnk'

function Write-Ok($Msg)   { Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Info($Msg) { Write-Host "[INFO] $Msg" -ForegroundColor Cyan }
function Write-Warn($Msg) { Write-Host "[WARN] $Msg" -ForegroundColor Yellow }
function Write-Fail($Msg) { Write-Host "[FAIL] $Msg" -ForegroundColor Red }

function Expand-HomePath([string]$Path) {
    if ($Path -eq '~') { return $HOME }
    if ($Path -match '^~[\\/]') { return (Join-Path $HOME $Path.Substring(2)) }
    return $Path
}

function Test-DefaultDir([string]$Dir) {
    $full = [IO.Path]::GetFullPath((Expand-HomePath $Dir)).TrimEnd('\')
    return ($full -ieq (Join-Path $HOME '.claude'))
}

# ---------- Accounts ----------

function Get-UsageAccounts {
    if (-not (Test-Path $script:AccountsFile)) {
        throw "kit/accounts.json not found. Run setup.ps1 (or: just accounts ba,kv,...) first."
    }
    $raw = Get-Content $script:AccountsFile -Raw | ConvertFrom-Json
    $seen = @{}
    $list = @()
    foreach ($a in @($raw)) {
        if (-not $a.name) { throw "Every account in accounts.json needs a name." }
        if ($seen.ContainsKey($a.name.ToLower())) { throw "Duplicate account name '$($a.name)' in accounts.json." }
        $seen[$a.name.ToLower()] = $true
        $dir = $a.dir
        if (-not $dir) { $dir = "~/.claude-$($a.name)" }
        $isDefault = Test-DefaultDir $dir
        $id = ($a.name.ToLower() -replace '[^a-z0-9_-]', '_')
        if ($isDefault) { $id = 'default' }
        $list += [pscustomobject]@{ Name = $a.name; Dir = $dir; FullDir = (Expand-HomePath $dir); IsDefault = $isDefault; Id = $id }
    }
    if ($list.Count -eq 0) { throw "accounts.json lists no accounts." }
    return $list
}

# Writes accounts.json from "ba,kv,newgen". The first name gets Claude Code's default
# folder (~/.claude); the rest get ~/.claude-<name>. Existing dirs for a name are kept.
function Set-UsageAccounts([string[]]$Names) {
    $existing = @{}
    if (Test-Path $script:AccountsFile) {
        foreach ($a in @(Get-Content $script:AccountsFile -Raw | ConvertFrom-Json)) { $existing[$a.name.ToLower()] = $a.dir }
    }
    $out = @()
    $i = 0
    foreach ($n in $Names) {
        $n = $n.Trim()
        if (-not $n) { continue }
        $dir = $existing[$n.ToLower()]
        if (-not $dir) { if ($i -eq 0) { $dir = '~/.claude' } else { $dir = "~/.claude-$n" } }
        $out += [ordered]@{ name = $n; dir = $dir }
        $i++
    }
    ConvertTo-Json @($out) -Depth 3 | Set-Content $script:AccountsFile -Encoding UTF8
    Write-Ok "Saved $($out.Count) account(s) to kit/accounts.json"
}

function Initialize-AccountsFile {
    if (Test-Path $script:AccountsFile) { return }
    Copy-Item $script:AccountsStub $script:AccountsFile
    Write-Info "Created kit/accounts.json from accounts.json.stub -- edit names/folders there (git-ignored)."
}

# ---------- Claude Code login state ----------

function Invoke-ClaudeFor($Account, [string[]]$ClaudeArgs) {
    $saved = $env:CLAUDE_CONFIG_DIR
    try {
        if ($Account.IsDefault) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
        else { $env:CLAUDE_CONFIG_DIR = $Account.FullDir }
        return (& claude @ClaudeArgs 2>&1 | Out-String)
    } finally {
        if ($null -eq $saved) { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:CLAUDE_CONFIG_DIR = $saved }
    }
}

function Get-AccountAuth($Account) {
    try {
        $j = (Invoke-ClaudeFor $Account @('auth', 'status')) | ConvertFrom-Json
        return [pscustomobject]@{ LoggedIn = [bool]$j.loggedIn; Email = $j.email; Plan = $j.subscriptionType }
    } catch {
        return [pscustomobject]@{ LoggedIn = $false; Email = $null; Plan = $null }
    }
}

function Find-Edge {
    foreach ($p in @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                     "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# Logs one account in without ever touching the default browser.
#  - `claude auth login` would auto-open the DEFAULT browser, which is usually signed in
#    to your main account and silently completes the login as THAT account. BROWSER is
#    pointed at a script that only records the URL, so nothing opens by itself.
#  - The URL opens in Edge with a brand-new --user-data-dir: no cookies, no shared
#    InPrivate session (all InPrivate windows share one session while any is open).
#  - You paste the code shown after "Authorize"; it is fed to the waiting CLI.
function Invoke-AccountLogin($Account) {
    if (-not $Account.IsDefault) { New-Item -ItemType Directory -Force $Account.FullDir | Out-Null }
    $work = Join-Path $env:TEMP ("claude-usage-login-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force $work | Out-Null
    $urlFile = Join-Path $work 'url.txt'
    $browser = Join-Path $work 'browser.cmd'
    Set-Content $browser "@echo %* > `"$urlFile`"" -Encoding ASCII

    $claude = (Get-Command claude -ErrorAction Stop).Source
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($claude -match '\.(cmd|bat)$') { $psi.FileName = 'cmd.exe'; $psi.Arguments = "/c `"$claude`" auth login --claudeai" }
    else { $psi.FileName = $claude; $psi.Arguments = 'auth login --claudeai' }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['BROWSER'] = $browser
    if ($Account.IsDefault) { [void]$psi.EnvironmentVariables.Remove('CLAUDE_CONFIG_DIR') }
    else { $psi.EnvironmentVariables['CLAUDE_CONFIG_DIR'] = $Account.FullDir }

    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEndAsync()
    $stderr = $proc.StandardError.ReadToEndAsync()
    $url = $null
    for ($i = 0; $i -lt 60 -and -not $url; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $urlFile) { $url = ((Get-Content $urlFile -Raw) -replace '"', '').Trim() }
    }
    if (-not $url) {
        if (-not $proc.HasExited) { $proc.Kill() }
        Write-Fail "Claude Code never produced a login link for '$($Account.Name)'."
        return $false
    }

    $edge = Find-Edge
    $profileDir = Join-Path $work 'edge-profile'
    Write-Host ""
    Write-Host "  Log in account '$($Account.Name)'" -ForegroundColor Cyan
    if ($edge) {
        Start-Process $edge -ArgumentList "--user-data-dir=`"$profileDir`"", '--no-first-run', '--inprivate', $url
        Write-Host "  1. A fresh Edge window opened (shares no sign-in with anything)." -ForegroundColor Gray
    } else {
        Write-Warn "Edge not found. Open this link in a PRIVATE window that is signed in to nothing:"
        Write-Host "  $url" -ForegroundColor Gray
    }
    Write-Host "  2. Sign in as '$($Account.Name)', click Authorize, copy the code." -ForegroundColor Gray
    $code = Read-Host "  3. Paste the code here"
    $proc.StandardInput.WriteLine($code.Trim())
    $proc.StandardInput.Flush()
    if (-not $proc.WaitForExit(60000)) { $proc.Kill() }
    $out = $stdout.Result

    # Close the throwaway Edge window and remove its profile.
    Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$profileDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

    if ($out -notmatch 'Login successful') {
        $why = (($stderr.Result + "`n" + $out) -split "`n" | Where-Object { $_.Trim() -and $_ -notmatch 'https://|Opening browser' } | Select-Object -Last 2) -join ' '
        $why = $why -replace 'Paste code here if prompted >\s*', ''
        if (-not $why.Trim()) { $why = 'the code was rejected or expired' }
        Write-Fail "Login for '$($Account.Name)' did not complete ($($why.Trim())). Retry: just login $($Account.Name)"
        return $false
    }
    $auth = Get-AccountAuth $Account
    Write-Ok "'$($Account.Name)' is logged in as $($auth.Email) ($($auth.Plan))"
    return $true
}

# ---------- The monitor app ----------

function Get-MonitorExe {
    $pkgRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path $pkgRoot) {
        $hit = Get-ChildItem $pkgRoot -Directory -Filter 'CodeZeno.ClaudeCodeUsageMonitor*' -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem $_.FullName -Filter 'claude-code-usage-monitor.exe' -ErrorAction SilentlyContinue } |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    $cmd = Get-Command claude-code-usage-monitor -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Stop-Monitor {
    Get-Process claude-code-usage-monitor -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 800
}

function Start-Monitor([switch]$Diagnose) {
    $exe = Get-MonitorExe
    if (-not $exe) { throw "Claude Code Usage Monitor is not installed. Run setup.ps1." }
    if ($Diagnose) { Start-Process $exe -ArgumentList '--diagnose' } else { Start-Process $exe }
}

# PSCustomObject from ConvertFrom-Json refuses new properties via plain assignment.
function Set-JsonProp($Obj, [string]$Name, $Value) {
    if ($Obj.PSObject.Properties[$Name]) { $Obj.$Name = $Value }
    else { $Obj | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

# ---------- Theme: one row per account, 5h + 7d bars ----------

function New-TextLayer($Id, $X, $Y, $W, $H, $Template, $Size, $Color, $Weight) {
    [ordered]@{
        id = $Id; name = $Id; render = '1'; visibility = '100'
        x = "$X"; y = "$Y"; width = "$W"; height = "$H"
        background = @{ type = 'none' }; border = $null; corner_radius = '0'
        layout = 'freeform'; align = 'start'; gap = '0'
        content = [ordered]@{
            type = 'text'; template = $Template; font_family = 'Segoe UI Variable Text'
            font_size = "$Size"; weight = $Weight; rendering = 'antialiased'; contrast = '1'
            align = 'left'; color = @{ color = $Color; opacity = '1' }
        }
    }
}

function New-BoxLayer($Id, $X, $Y, $W, $H, $Color, $Render, $Radius, $Opacity) {
    [ordered]@{
        id = $Id; name = $Id; render = $Render; visibility = '100'
        x = "$X"; y = "$Y"; width = "$W"; height = "$H"
        background = @{ type = 'colour'; colour = @{ color = $Color; opacity = $Opacity } }
        border = $null; corner_radius = "$Radius"; layout = 'freeform'; align = 'start'; gap = '0'
        content = @{ type = 'none' }
    }
}

# Card opacity 0.85: see-through, but still readable over light windows.
function Write-UsageTheme($Accounts, [double]$Opacity = 0.85) {
    $PAD = 10; $TOP = 16; $LINE = 17; $GAP = 9; $BW = 44; $TW = 96
    $LX = 67; $BX = $LX + 20; $TX = $BX + $BW + 6
    $W = $TX + $TW + $PAD - 6
    $BLOCK = 2 * $LINE + $GAP
    $H = $PAD + $TOP + $BLOCK * $Accounts.Count - $GAP + $PAD
    # Non-ASCII via [char]: Windows PowerShell 5.1 reads a BOM-less .psm1 as ANSI.
    $DOT = [string][char]0x00B7
    $GREEN = '#3FB950FF'; $AMBER = '#D29922FF'; $RED = '#F85149FF'; $TRACK = '#4A515BFF'; $MUTED = '#C9D1D9FF'

    $kids = New-Object System.Collections.ArrayList
    [void]$kids.Add((New-TextLayer 'title' 10 6 150 16 'Claude usage' 11 $MUTED 'semibold'))
    $close = New-TextLayer 'close-btn' ($W - 26) 3 20 20 ([string][char]0x2715) 12 $MUTED 'regular'
    $close.content.align = 'center'
    $close['mouse_events'] = @{ click = 'show_context_menu("close-menu")' }
    [void]$kids.Add($close)

    $n = 0
    for ($i = 0; $i -lt $Accounts.Count; $i++) {
        $a = $Accounts[$i]
        $y0 = $PAD + $TOP + $i * $BLOCK
        $b = "accounts.claude.$($a.Id)"
        if ($i -gt 0) { $n++; [void]$kids.Add((New-BoxLayer "div$n" $PAD ($y0 - [math]::Floor($GAP / 2) - 1) ($W - 2 * $PAD) 1 '#2D333BFF' '1' 0 '0.6')) }
        [void]$kids.Add((New-TextLayer "name-$($a.Id)" $PAD ($y0 + [math]::Floor($LINE / 2)) 56 18 $a.Name 13 '#FFFFFFFF' 'semibold'))
        $rows = @(@('5h', 'session'), @('7d', 'weekly'))
        for ($j = 0; $j -lt 2; $j++) {
            $lab = $rows[$j][0]; $win = $rows[$j][1]
            $y = $y0 + $j * $LINE
            $p = "$b.$win.percentage"
            [void]$kids.Add((New-TextLayer "lab-$($a.Id)-$win" $LX $y 20 $LINE $lab 11 $MUTED 'medium'))
            $n++; [void]$kids.Add((New-BoxLayer "track$n" $BX ($y + 6) $BW 6 $TRACK '1' 3 '1'))
            $fw = "max(1, $BW * clamp($p, 0, 100) / 100)"
            foreach ($c in @(@($GREEN, "$p < 70"), @($AMBER, "($p >= 70) * ($p < 90)"), @($RED, "$p >= 90"))) {
                $n++; [void]$kids.Add((New-BoxLayer "bar$n" $BX ($y + 6) $fw 6 $c[0] $c[1] 3 '1'))
            }
            [void]$kids.Add((New-TextLayer "val-$($a.Id)-$win" $TX $y $TW $LINE "{$p`:0}% $DOT {$b.$win.reset.seconds:duration}" 11 '#FFFFFFFF' 'medium'))
        }
    }

    $theme = [ordered]@{
        schema_version = 1; id = 'multi-claude-accounts'; name = 'Claude accounts'
        surfaces = @([ordered]@{
            id = 'main'; name = 'Claude accounts'; render = '1'; visibility = '100'
            placement = [ordered]@{
                reference = @{ region = 'system_tray'; display = 0 }; nest = 'floating'
                horizontal = 'right'; vertical = 'top'; surface_horizontal = 'right'; surface_vertical = 'bottom'
                offset_x = 0; offset_y = -12
            }
            width = "$W"; height = "$H"
            background = @{ type = 'colour'; colour = @{ color = '#0D1117FF'; opacity = "$Opacity" } }
            border = $null
            mouse_events = @{ double_click = 'show_dashboard()'; right_click = 'show_context_menu("dashboard-v2")' }
            corner_radius = '10'; layout = 'freeform'; align = 'start'; gap = '0'
            content = @{ type = 'none' }
            children = $kids
        })
    }
    New-Item -ItemType Directory -Force (Split-Path $script:ThemeFile) | Out-Null
    # UTF-8 without BOM: the app's JSON parser rejects a BOM.
    [IO.File]::WriteAllText($script:ThemeFile, (ConvertTo-Json $theme -Depth 20), (New-Object System.Text.UTF8Encoding $false))
    $menuDir = Join-Path $script:AppDataDir 'context-menus'
    New-Item -ItemType Directory -Force $menuDir | Out-Null
    Copy-Item (Join-Path $script:KitDir 'close-menu.json') (Join-Path $menuDir 'close-menu.json') -Force
    Write-Ok "Theme written for $($Accounts.Count) account(s): $script:ThemeFile"
}

# ---------- Monitor settings ----------

function Write-MonitorSettings($Accounts) {
    New-Item -ItemType Directory -Force $script:AppDataDir | Out-Null
    if (Test-Path $script:SettingsFile) {
        Copy-Item $script:SettingsFile "$script:SettingsFile.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        $s = Get-Content $script:SettingsFile -Raw | ConvertFrom-Json
    } else {
        $s = New-Object psobject
    }
    $profiles = @()
    foreach ($a in $Accounts) {
        $cfg = ''
        if (-not $a.IsDefault) { $cfg = ($a.Dir -replace '\\', '/') }
        $profiles += [pscustomobject][ordered]@{ config_dir = $cfg; credentials_path = ''; enabled = $true; id = $a.Id; name = $a.Name }
    }
    $claude = [pscustomobject][ordered]@{ profiles = $profiles; selected = $Accounts[0].Id; used_ids = @($Accounts | ForEach-Object { $_.Id }) }
    if (-not $s.PSObject.Properties['accounts']) { Set-JsonProp $s 'accounts' (New-Object psobject) }
    Set-JsonProp $s.accounts 'claude' $claude
    Set-JsonProp $s 'active_theme_path' $script:ThemeFile
    Set-JsonProp $s 'custom_theme_enabled' $true
    Set-JsonProp $s 'show_claude_code' $true
    [IO.File]::WriteAllText($script:SettingsFile, (ConvertTo-Json $s -Depth 20), (New-Object System.Text.UTF8Encoding $false))
    Write-Ok "Monitor settings updated (backup kept next to settings.json)"
}

# ---------- Startup + shortcuts ----------

function Enable-MonitorStartup {
    $exe = Get-MonitorExe
    Set-ItemProperty $script:RunKey -Name $script:RunValue -Value $exe
    Write-Ok "Starts with Windows (HKCU Run -> $script:RunValue)"
}

function Disable-MonitorStartup {
    Remove-ItemProperty $script:RunKey -Name $script:RunValue -ErrorAction SilentlyContinue
    Write-Ok "Will no longer start with Windows"
}

function New-MonitorShortcuts {
    $exe = Get-MonitorExe
    $ws = New-Object -ComObject WScript.Shell
    foreach ($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
        $lnk = $ws.CreateShortcut((Join-Path $d $script:ShortcutName))
        $lnk.TargetPath = $exe
        $lnk.WorkingDirectory = Split-Path $exe
        $lnk.IconLocation = "$exe,0"
        $lnk.Description = 'Claude usage for all your accounts'
        $lnk.Save()
    }
    Write-Ok "Shortcut 'Claude Usage' on the Desktop and in the Start menu"
}

# ---------- Status + verify ----------

function Format-Reset($Unix) {
    if (-not $Unix) { return '-' }
    $s = [int64]$Unix - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    if ($s -le 0) { return 'now' }
    $d = [math]::Floor($s / 86400); $h = [math]::Floor(($s % 86400) / 3600); $m = [math]::Floor(($s % 3600) / 60)
    if ($d -gt 0) { return "${d}d ${h}h" }
    if ($h -gt 0) { return "${h}h ${m}m" }
    return "${m}m"
}

# Reads the monitor's own cache (%APPDATA%\ClaudeCodeUsageMonitor\usage-cache.json) --
# the numbers the widget shows, no API call.
function Show-UsageStatus {
    $accounts = Get-UsageAccounts
    $cacheFile = Join-Path $script:AppDataDir 'usage-cache.json'
    $cache = $null
    if (Test-Path $cacheFile) { $cache = Get-Content $cacheFile -Raw | ConvertFrom-Json }
    $rows = foreach ($a in $accounts) {
        $auth = Get-AccountAuth $a
        $u = $null
        if ($cache) {
            $credPath = Join-Path $a.FullDir '.credentials.json'
            $entry = @($cache.data.accounts) | Where-Object { $_.provider -eq 'claude' -and ($_.source_path -ieq $credPath) } | Select-Object -First 1
            if ($entry) { $u = $entry.usage }
        }
        $s5 = '-'; $s7 = '-'
        if ($u) {
            $s5 = "{0}% (resets {1})" -f $u.session.percentage, (Format-Reset $u.session.resets_at.secs_since_epoch)
            $s7 = "{0}% (resets {1})" -f $u.weekly.percentage, (Format-Reset $u.weekly.resets_at.secs_since_epoch)
        }
        $email = $auth.Email
        if (-not $auth.LoggedIn) { $email = 'NOT LOGGED IN' }
        [pscustomobject]@{ Account = $a.Name; Email = $email; '5-hour' = $s5; Weekly = $s7; Folder = $a.Dir }
    }
    $rows | Format-Table -AutoSize
    if ($cache) { Write-Host ("  Widget cache updated {0}" -f ([DateTimeOffset]::FromUnixTimeSeconds([int64]$cache.updated_unix).LocalDateTime)) -ForegroundColor DarkGray }
}

# Restarts the widget with diagnostics on and waits for a live poll of every account.
function Test-UsageMonitor {
    $accounts = Get-UsageAccounts
    $log = Join-Path $env:TEMP 'claude-code-usage-monitor.log'
    Stop-Monitor
    # --diagnose sometimes truncates the log and sometimes appends, so keep only lines
    # stamped after this restart ("[<unix>] [pid N] ...") rather than a line offset.
    $since = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 1
    Start-Monitor -Diagnose
    $ok = @{}
    for ($i = 0; $i -lt 30 -and $ok.Count -lt $accounts.Count; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Test-Path $log)) { continue }
        $new = @(Get-Content $log) | Where-Object { $_ -match '^\[(\d+)\]' -and [int64]$Matches[1] -ge $since }
        foreach ($a in $accounts) {
            $hit = $new | Where-Object { $_ -like "*Claude Code account $($a.Name) usage received*" } | Select-Object -Last 1
            if ($hit) { $ok[$a.Name] = ($hit -replace '.*usage received: ', '') }
            $bad = $new | Where-Object { $_ -like "*Claude Code account $($a.Name) usage poll failed*" } | Select-Object -Last 1
            if ($bad -and -not $ok.ContainsKey($a.Name)) { $ok[$a.Name] = 'FAILED: ' + ($bad -replace '.*poll failed: ', '') }
        }
    }
    Stop-Monitor
    Start-Monitor
    $failed = 0
    foreach ($a in $accounts) {
        $r = $ok[$a.Name]
        if ($r -and $r -notlike 'FAILED*') { Write-Ok "$($a.Name): $r" }
        elseif ($r) { Write-Fail "$($a.Name): $r"; $failed++ }
        else { Write-Fail "$($a.Name): no poll result within 30s"; $failed++ }
    }
    return ($failed -eq 0)
}

Export-ModuleMember -Function Write-Ok, Write-Info, Write-Warn, Write-Fail, Get-UsageAccounts, Set-UsageAccounts,
    Initialize-AccountsFile, Get-AccountAuth, Invoke-AccountLogin, Invoke-ClaudeFor, Get-MonitorExe, Stop-Monitor,
    Start-Monitor, Write-UsageTheme, Write-MonitorSettings, Enable-MonitorStartup, Disable-MonitorStartup,
    New-MonitorShortcuts, Show-UsageStatus, Test-UsageMonitor
