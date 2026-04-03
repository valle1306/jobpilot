param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = "C:\Program Files\nodejs\node.exe"
$entry = Join-Path $repoRoot "standalone\jobpilot.mjs"

if (-not (Test-Path $nodeExe)) {
  throw "Node.js LTS is not installed. Run .\scripts\standalone-install.ps1 after installing Node."
}

if (-not (Test-Path $entry)) {
  throw "Standalone CLI entry not found: $entry"
}

& $nodeExe $entry @Args
exit $LASTEXITCODE
