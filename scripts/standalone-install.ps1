param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = "C:\Program Files\nodejs\node.exe"
$npmCmd = "C:\Program Files\nodejs\npm.cmd"

if (-not (Test-Path $nodeExe) -or -not (Test-Path $npmCmd)) {
  throw "Node.js LTS is not installed. Install it first, then rerun this script."
}

Push-Location $repoRoot
try {
  & $npmCmd install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
  }
} finally {
  Pop-Location
}
