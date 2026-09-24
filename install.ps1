# Claude Code Usage Monitor -- one-line installer (no clone needed).
#
#   irm https://raw.githubusercontent.com/dxiiren/Claude-Code-Usage-Monitor/main/install.ps1 | iex
#
# Downloads this repo to %USERPROFILE%\claude-usage-monitor (zip, so Git is not required)
# and runs setup.ps1: widget + Account Manager web app, both starting with Windows.
# Then add accounts at http://127.0.0.1:47291 -- type a name, sign in, paste the code.
# Re-running updates the kit; your accounts live in %APPDATA%\ClaudeCodeUsageMonitor\accounts.db
# and are never touched by an update.

param(
    [string]$InstallTo = (Join-Path $env:USERPROFILE 'claude-usage-monitor'),
    [string]$Repo = 'dxiiren/Claude-Code-Usage-Monitor',
    [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$zip = Join-Path $env:TEMP "claude-usage-monitor-$Branch.zip"
$unpack = Join-Path $env:TEMP "claude-usage-monitor-$Branch"

Write-Host "[INSTALL] Downloading $Repo@$Branch..." -ForegroundColor Yellow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip -UseBasicParsing
Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $unpack -Force
$src = Get-ChildItem $unpack -Directory | Select-Object -First 1

# Stop the running Account Manager first, or its files are locked while we replace them.
$build = Join-Path $InstallTo 'web\start.js'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$build*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Force $InstallTo | Out-Null
foreach ($item in @('setup.ps1', 'justfile', 'kit', 'web')) {
    $dest = Join-Path $InstallTo $item
    if ((Test-Path $dest) -and (Get-Item $dest).PSIsContainer) {
        # Keep node_modules (npm ci refreshes it); replace everything else.
        Get-ChildItem $dest -Force | Where-Object { $_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force
        Copy-Item (Join-Path $src.FullName "$item\*") $dest -Recurse -Force
    } else {
        Copy-Item (Join-Path $src.FullName $item) $InstallTo -Recurse -Force
    }
}
Remove-Item $zip, $unpack -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "[OK] Kit in $InstallTo" -ForegroundColor Green

& (Join-Path $InstallTo 'setup.ps1')
