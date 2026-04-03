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
$staleLockMinutes = 20

function Test-JobPilotAutorunOwnerActive {
  param(
    [Parameter(Mandatory = $false)]
    [object]$LockInfo
  )

  if ($null -eq $LockInfo) {
    return $false
  }

  $pidValue = 0
  if ($LockInfo.PSObject.Properties.Name -contains "pid") {
    [void][int]::TryParse([string]$LockInfo.pid, [ref]$pidValue)
  }

  if ($pidValue -le 0) {
    return $false
  }

  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  return ($null -ne $process)
}

if (Test-Path $lockPath) {
  $lockRaw = Get-Content $lockPath -Raw -ErrorAction SilentlyContinue
  $lockInfo = $null
  try {
    $lockInfo = $lockRaw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $lockInfo = [pscustomobject]@{
      timestamp = ($lockRaw | Out-String).Trim()
    }
  }

  $lockAgeMinutes = ((Get-Date) - (Get-Item $lockPath).LastWriteTime).TotalMinutes
  if ((Test-JobPilotAutorunOwnerActive -LockInfo $lockInfo) -and $lockAgeMinutes -lt $staleLockMinutes) {
    throw "Another autorun appears to be active. Existing lock: $lockPath"
  }

  "[$(Get-Date -Format o)] Removing stale autorun lock at $lockPath" | Tee-Object -FilePath $logPath -Append
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}

$lockInfo = [pscustomobject]@{
  pid = $PID
  timestamp = (Get-Date -Format o)
  logPath = $logPath
}
$lockInfo | ConvertTo-Json | Set-Content -Path $lockPath

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
