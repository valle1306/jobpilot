param()

$ErrorActionPreference = "Stop"

$wrapper = Join-Path $PSScriptRoot "jobpilot-standalone.ps1"
if (-not (Test-Path $wrapper)) {
  throw "Standalone wrapper not found: $wrapper"
}

Write-Output "Opening enabled search boards in the persistent browser profile..."
Write-Output "Sign in or solve any verification challenges, then close the browser window."

& $wrapper "search-bootstrap"
exit $LASTEXITCODE
