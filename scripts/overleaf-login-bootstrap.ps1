param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $PSScriptRoot "jobpilot-standalone.ps1"

if (-not (Test-Path $wrapper)) {
  throw "Standalone wrapper not found: $wrapper"
}

Write-Output "Opening the persistent browser profile for Overleaf sign-in..."
Write-Output "Complete any Overleaf login or verification steps in the browser window."

& $wrapper "overleaf-login"
exit $LASTEXITCODE
