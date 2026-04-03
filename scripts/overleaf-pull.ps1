param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $repoRoot "profile.json"

if (-not (Test-Path $profilePath)) {
  throw "profile.json not found at $profilePath"
}

$profile = Get-Content $profilePath -Raw | ConvertFrom-Json
$clonePath = [string]$profile.overleaf.localClonePath

if ([string]::IsNullOrWhiteSpace($clonePath)) {
  throw "overleaf.localClonePath is not set in profile.json"
}
if (-not (Test-Path $clonePath)) {
  throw "Overleaf clone directory not found at $clonePath"
}

Write-Output "Pulling latest from Overleaf at $clonePath ..."
& git -C $clonePath pull origin master
if ($LASTEXITCODE -ne 0) {
  throw "git pull failed."
}

Write-Output "Pulled latest from Overleaf."
