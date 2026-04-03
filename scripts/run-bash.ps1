param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ScriptPath,

  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArgs = @()
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedScriptPath = if ([System.IO.Path]::IsPathRooted($ScriptPath)) {
  $ScriptPath
} else {
  Join-Path $repoRoot $ScriptPath
}

if (-not (Test-Path $resolvedScriptPath)) {
  throw "Script not found: $resolvedScriptPath"
}

$bashCommand = Get-Command bash -ErrorAction SilentlyContinue
$bashCandidates = @(
  $bashCommand.Source,
  "C:\Program Files\Git\usr\bin\bash.exe",
  "C:\Program Files\Git\bin\bash.exe"
) | Where-Object { $_ -and (Test-Path $_) }

$bashExe = $bashCandidates | Select-Object -First 1
if (-not $bashExe) {
  throw "Git Bash was not found. Install Git for Windows or add bash to PATH."
}

$normalizedScriptPath = $resolvedScriptPath -replace "\\", "/"
& $bashExe $normalizedScriptPath @ScriptArgs
exit $LASTEXITCODE
