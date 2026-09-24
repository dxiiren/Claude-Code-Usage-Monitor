# Claude Code Usage Monitor -- one-line installer (no clone needed).
#
#   irm https://raw.githubusercontent.com/dxiiren/Claude-Code-Usage-Monitor/main/install.ps1 | iex
#
# Downloads this repo's kit to %USERPROFILE%\claude-usage-monitor (zip, so Git is not
# required) and runs setup.ps1. Re-running updates the kit and keeps kit\accounts.json.
# With arguments, use a scriptblock:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/dxiiren/Claude-Code-Usage-Monitor/main/install.ps1))) -Accounts ba,kv

param(
    [string[]]$Accounts,
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

New-Item -ItemType Directory -Force $InstallTo | Out-Null
$keep = Join-Path $InstallTo 'kit\accounts.json'
$saved = $null
if (Test-Path $keep) { $saved = Get-Content $keep -Raw }
foreach ($item in @('setup.ps1', 'justfile', 'kit')) {
    Copy-Item (Join-Path $src.FullName $item) $InstallTo -Recurse -Force
}
if ($saved) { Set-Content $keep $saved -Encoding UTF8 }
Remove-Item $zip, $unpack -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "[OK] Kit in $InstallTo" -ForegroundColor Green

$setup = Join-Path $InstallTo 'setup.ps1'
if ($Accounts) { & $setup -Accounts $Accounts } else { & $setup }
