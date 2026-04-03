param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $repoRoot "profile.json"

if (-not (Test-Path $profilePath)) {
  throw "profile.json not found at $profilePath"
}

$profile = Get-Content $profilePath -Raw | ConvertFrom-Json
$gitUrl = [string]$profile.overleaf.gitUrl
$clonePath = [string]$profile.overleaf.localClonePath
$gitToken = if ($profile.overleaf.gitToken) { [string]$profile.overleaf.gitToken } else { [string]$profile.overleaf.gitPassword }

if ([string]::IsNullOrWhiteSpace($gitUrl)) {
  throw "overleaf.gitUrl is not set in profile.json"
}
if ([string]::IsNullOrWhiteSpace($clonePath)) {
  throw "overleaf.localClonePath is not set in profile.json"
}
if ([string]::IsNullOrWhiteSpace($gitToken)) {
  throw "overleaf.gitToken is not set in profile.json"
}
if (Test-Path $clonePath) {
  Write-Output "Already cloned at $clonePath. Use git -C $clonePath pull origin master to update."
  exit 0
}

$encodedToken = [uri]::EscapeDataString($gitToken)
$protocol, $rest = $gitUrl -split '://', 2
$authUrl = "${protocol}://git:${encodedToken}@${rest}"

Write-Output "Cloning Overleaf project to $clonePath ..."
& git clone $authUrl $clonePath
if ($LASTEXITCODE -ne 0) {
  throw "git clone failed. Overleaf token auth uses username 'git' and your Git token as the password."
}

$texFiles = $profile.overleaf.texFiles.PSObject.Properties.Value
$missing = @()
foreach ($texFile in $texFiles) {
  if (-not (Test-Path (Join-Path $clonePath $texFile))) {
    $missing += $texFile
  }
}

if ($missing.Count -gt 0) {
  Write-Warning ("Some expected .tex files were not found: " + ($missing -join ", "))
}

Write-Output "Overleaf project cloned successfully to: $clonePath"
