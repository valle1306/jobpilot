param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $repoRoot "profile.json"
$wrapperPath = Join-Path $PSScriptRoot "jobpilot-standalone.ps1"

if (-not (Test-Path $profilePath)) {
  throw "profile.json not found at $profilePath"
}

if (-not (Test-Path $wrapperPath)) {
  throw "Standalone wrapper not found at $wrapperPath"
}

$profile = Get-Content $profilePath -Raw | ConvertFrom-Json
$standalone = $profile.standalone
if ($null -eq $standalone) {
  throw "profile.json is missing the standalone block."
}
if ($standalone.enabled -eq $false) {
  throw "profile.json standalone.enabled is false."
}

$logDir = if ($standalone.logDir) {
  if ([System.IO.Path]::IsPathRooted([string]$standalone.logDir)) {
    [string]$standalone.logDir
  } else {
    Join-Path $repoRoot ([string]$standalone.logDir)
  }
} else {
  Join-Path $repoRoot "runs\standalone-logs"
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logPath = Join-Path $logDir "autorun-$timestamp.log"
$lockPath = Join-Path $logDir "autorun.lock"

if (Test-Path $lockPath) {
  throw "Another autorun appears to be active. Remove $lockPath if that previous run is no longer running."
}

Set-Content -Path $lockPath -Value $timestamp

try {
  Push-Location $repoRoot
  try {
    "[$(Get-Date -Format o)] Starting standalone autorun..." | Tee-Object -FilePath $logPath -Append
    & $wrapperPath "autorun" 2>&1 | Tee-Object -FilePath $logPath -Append
    if ($LASTEXITCODE -ne 0) {
      throw "Standalone autorun failed with exit code $LASTEXITCODE"
    }
    "[$(Get-Date -Format o)] Standalone autorun finished." | Tee-Object -FilePath $logPath -Append
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue
}
