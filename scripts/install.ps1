# scripts/install.ps1
#
# One-line installer for agentpanel (Windows). Downloads a self-contained
# portable build that BUNDLES Node from GitHub Releases, extracts it to
# %LOCALAPPDATA%\agentpanel, and adds that folder to the user PATH.
# No Node.js install required on the host.
#
# Users run:
#   irm https://yancyuu.github.io/agentpanel/install.ps1 | iex

$ErrorActionPreference = 'Stop'

# GitHub repo that hosts the Releases with the portable zips.
$Repo = 'yancyuu/agentpanel'
$InstallDir = if ($env:AGENTPANEL_HOME) { $env:AGENTPANEL_HOME } else { Join-Path $env:LOCALAPPDATA 'agentpanel' }
$Arch = 'x64'
$Asset = "agentpanel-windows-$Arch.zip"
# GitHub 镜像前缀（国内 / 企业防火墙）；留空 = 直连 github.com，按顺序尝试。
$Mirrors = @('https://gh-proxy.com/', 'https://ghproxy.net/', '')

function Info($m) { Write-Host "► $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Die($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

# --- detect arch (fallback x64) -------------------------------------------
try {
  $pa = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
  if ($pa -eq 'Arm64') { $Arch = 'arm64'; $Asset = "agentpanel-windows-$Arch.zip" }
} catch {}

# --- download --------------------------------------------------------------
$tmp = Join-Path $env:TEMP 'agentpanel-install.zip'
$downloaded = $false
foreach ($prefix in $Mirrors) {
  $url = "${prefix}https://github.com/$Repo/releases/latest/download/$Asset"
  Info "尝试 $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    $downloaded = $true
    break
  } catch {
    Write-Host "  └ 跳过（失败），尝试下一个镜像" -ForegroundColor DarkGray
  }
}
if (-not $downloaded) {
  Die "下载失败。确认 $Repo 已发布含 $Asset 的 Release（首次发版前还没有），或当前网络无法访问 GitHub。"
}

# --- extract ---------------------------------------------------------------
Info "安装到 $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Expand-Archive -Path $tmp -DestinationPath $InstallDir -Force
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
Write-Host "开一个新终端（PowerShell/CMD），运行: agentpanel" -ForegroundColor Green
