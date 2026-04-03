param(
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot ".env"
$npmCmd = "C:\Program Files\nodejs\npm.cmd"

function Get-LocalEnvValue {
  param(
    [string]$EnvPath,
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $EnvPath)) {
    return $null
  }

  $pattern = "^\s*$([regex]::Escape($Name))\s*=\s*(.*)\s*$"
  foreach ($line in Get-Content -LiteralPath $EnvPath) {
    if ($line -match $pattern) {
      $value = $matches[1].Trim()
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }

  return $null
}

function Get-CodexCliPath {
  $command = Get-Command codex -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $npmCandidate = Join-Path $env:APPDATA "npm\codex.cmd"
  if (Test-Path -LiteralPath $npmCandidate) {
    return $npmCandidate
  }

  $extensionsDir = Join-Path $env:USERPROFILE ".vscode\extensions"
  if (Test-Path -LiteralPath $extensionsDir) {
    $extension = Get-ChildItem -LiteralPath $extensionsDir -Directory -Filter "openai.chatgpt-*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($extension) {
      $embeddedCandidate = Join-Path $extension.FullName "bin\windows-x86_64\codex.exe"
      if (Test-Path -LiteralPath $embeddedCandidate) {
        return $embeddedCandidate
      }
    }
  }

  return $null
}

function Invoke-CodexLoginStatus {
  param(
    [string]$CodexPath
  )

  try {
    return & $CodexPath login status 2>&1
  } catch {
    return @()
  }
}

$codexPath = Get-CodexCliPath
if (-not $codexPath) {
  if (-not (Test-Path -LiteralPath $npmCmd)) {
    throw "Codex CLI was not found and npm is not installed at $npmCmd."
  }

  Write-Host "Installing Codex CLI globally via npm..."
  & $npmCmd install -g @openai/codex
  $codexPath = Get-CodexCliPath
}

if (-not $codexPath) {
  throw "Codex CLI installation did not produce a usable executable."
}

Write-Host "Codex CLI detected at $codexPath"

$loginStatus = Invoke-CodexLoginStatus -CodexPath $codexPath
$statusText = ($loginStatus | Out-String).Trim()
if ($statusText -match "Logged in using") {
  Write-Host $statusText
} else {
  $codexApiKey = [Environment]::GetEnvironmentVariable("CODEX_API_KEY", "Process")
  if ([string]::IsNullOrWhiteSpace($codexApiKey)) {
    $codexApiKey = Get-LocalEnvValue -EnvPath $envPath -Name "CODEX_API_KEY"
  }
  if ([string]::IsNullOrWhiteSpace($codexApiKey)) {
    $codexApiKey = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "Process")
  }
  if ([string]::IsNullOrWhiteSpace($codexApiKey)) {
    $codexApiKey = Get-LocalEnvValue -EnvPath $envPath -Name "OPENAI_API_KEY"
  }

  if ([string]::IsNullOrWhiteSpace($codexApiKey)) {
    Write-Host "No API-key fallback detected. Starting Codex login..."
    & $codexPath login
  } else {
    Write-Host "Codex CLI will use the available API-key fallback during JobPilot runs."
  }
}

if (-not $SkipSmokeTest) {
  $smokeDir = Join-Path $repoRoot "runs\codex-bootstrap"
  $smokeOutput = Join-Path $smokeDir "smoke-last-message.txt"
  New-Item -ItemType Directory -Path $smokeDir -Force | Out-Null

  $fallbackApiKey = Get-LocalEnvValue -EnvPath $envPath -Name "CODEX_API_KEY"
  if ([string]::IsNullOrWhiteSpace($fallbackApiKey)) {
    $fallbackApiKey = Get-LocalEnvValue -EnvPath $envPath -Name "OPENAI_API_KEY"
  }
  if ([string]::IsNullOrWhiteSpace($fallbackApiKey)) {
    $fallbackApiKey = [Environment]::GetEnvironmentVariable("CODEX_API_KEY", "User")
  }
  if ([string]::IsNullOrWhiteSpace($fallbackApiKey)) {
    $fallbackApiKey = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "User")
  }

  if (-not [string]::IsNullOrWhiteSpace($fallbackApiKey)) {
    $env:CODEX_API_KEY = $fallbackApiKey
  }

  Write-Host "Running Codex CLI smoke test..."
  "Reply with exactly: codex ok" | & $codexPath exec --skip-git-repo-check --ephemeral --full-auto --sandbox workspace-write --cd $smokeDir --output-last-message $smokeOutput -
  $lastMessage = if (Test-Path -LiteralPath $smokeOutput) {
    (Get-Content -LiteralPath $smokeOutput -Raw).Trim()
  } else {
    ""
  }

  if ([string]::IsNullOrWhiteSpace($lastMessage)) {
    Write-Host "Codex smoke test finished without a captured last message."
  } else {
    Write-Host "Codex smoke test reply: $lastMessage"
  }
}

Write-Host "Codex bootstrap complete."
