# scripts/install.ps1
#
# One-line installer for agentcli (Windows). Downloads a self-contained
# portable build that BUNDLES Node from GitHub Releases, extracts it to
# %LOCALAPPDATA%\agentcli, and adds that folder to the user PATH.
# No Node.js install required on the host.
#
# Users run:
#   irm https://yancyuu.github.io/agentcli/install.ps1 | iex

$ErrorActionPreference = 'Stop'

# GitHub repo that hosts the Releases with the portable zips.
$Repo = 'yancyuu/agentcli'
$InstallDir = if ($env:AGENTCLI_HOME) { $env:AGENTCLI_HOME } else { Join-Path $env:LOCALAPPDATA 'agentcli' }
$Arch = 'x64'
$Asset = "agentcli-windows-$Arch.zip"
$Url = "https://github.com/$Repo/releases/latest/download/$Asset"

function Info($m) { Write-Host "► $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Die($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

# --- detect arch (fallback x64) -------------------------------------------
try {
  $pa = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
  if ($pa -eq 'Arm64') { $Arch = 'arm64'; $Asset = "agentcli-windows-$Arch.zip"; $Url = "https://github.com/$Repo/releases/latest/download/$Asset" }
} catch {}

# --- download --------------------------------------------------------------
Info "下载 $Url"
$tmp = New-TemporaryFile
try {
  Invoke-WebRequest -Uri $Url -OutFile $tmp.FullName -UseBasicParsing
} catch {
  Die "下载失败。确认 $Repo 已发布含 $Asset 的 Release（首次发版前还没有）。"
}

# --- extract ---------------------------------------------------------------
Info "安装到 $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Expand-Archive -Path $tmp.FullName -DestinationPath $InstallDir -Force
Remove-Item $tmp

# --- PATH ------------------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$InstallDir*") {
  $newPath = if ($userPath) { "$InstallDir;$userPath" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Ok "已加入用户 PATH（重开终端生效）"
} else {
  Ok "PATH 已包含 $InstallDir"
}

Ok "安装完成 → $InstallDir"
Write-Host ""
Write-Host "开一个新终端（PowerShell/CMD），运行: agentcli" -ForegroundColor Green
