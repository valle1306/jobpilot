param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $repoRoot "profile.json"

function Resolve-RepoPath {
  param([string]$PathValue)

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return $null
  }

  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return $PathValue
  }

  return Join-Path $repoRoot $PathValue
}

if (-not (Test-Path $profilePath)) {
  throw "profile.json not found at $profilePath"
}

$profile = Get-Content $profilePath -Raw | ConvertFrom-Json
$clonePath = Resolve-RepoPath ([string]$profile.overleaf.localClonePath)

if (-not $profile.overleaf.enabled) {
  throw "overleaf.enabled must be true in profile.json"
}

if ([string]::IsNullOrWhiteSpace($clonePath)) {
  throw "overleaf.localClonePath is not set in profile.json"
}

if (-not (Test-Path $clonePath)) {
  Write-Output "Overleaf clone not found. Running overleaf-clone.ps1 ..."
  & (Join-Path $PSScriptRoot "overleaf-clone.ps1")
  if ($LASTEXITCODE -ne 0) {
    throw "overleaf-clone.ps1 failed."
  }
}

Write-Output "Rebasing local Overleaf clone onto the latest remote changes ..."
& git -C $clonePath pull --rebase origin master
if ($LASTEXITCODE -ne 0) {
  throw "git pull --rebase failed in $clonePath"
}

Write-Output "Syncing local resume templates into $clonePath ..."

$copied = New-Object System.Collections.Generic.List[string]
$seenDestinations = @{}

foreach ($property in $profile.overleaf.texFiles.PSObject.Properties) {
  $roleType = [string]$property.Name
  $destinationName = [string]$property.Value
  if ([string]::IsNullOrWhiteSpace($destinationName)) {
    throw "overleaf.texFiles.$roleType is empty in profile.json"
  }

  if ($seenDestinations.ContainsKey($destinationName)) {
    continue
  }
  $seenDestinations[$destinationName] = $true

  $configuredSource = $profile.personal.resumes.PSObject.Properties[$roleType]
  $sourcePath = $null
  if ($configuredSource) {
    $sourcePath = Resolve-RepoPath ([string]$configuredSource.Value)
  }

  if (-not $sourcePath -or -not (Test-Path $sourcePath)) {
    $fallbackPath = Resolve-RepoPath $destinationName
    if (Test-Path $fallbackPath) {
      $sourcePath = $fallbackPath
    }
  }

  if (-not $sourcePath -or -not (Test-Path $sourcePath)) {
    throw "Could not resolve a local source file for role '$roleType' -> '$destinationName'."
  }

  $destinationPath = Join-Path $clonePath $destinationName
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
  $copied.Add("$roleType -> $destinationName")
}

$defaultResumePath = Resolve-RepoPath ([string]$profile.personal.resumes.default)
if (-not $defaultResumePath -or -not (Test-Path $defaultResumePath)) {
  throw "personal.resumes.default does not point to an existing local file."
}

$mainTexPath = Join-Path $clonePath "main.tex"
Copy-Item -LiteralPath $defaultResumePath -Destination $mainTexPath -Force
Write-Output "Updated main.tex from personal.resumes.default."

& git -C $clonePath add -A
if ($LASTEXITCODE -ne 0) {
  throw "git add failed in $clonePath"
}

& git -C $clonePath diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Output "No changes to commit. Overleaf clone is already in sync."
  exit 0
}

$commitMessage = "chore: sync resume templates from local repo"
Write-Output "Committing Overleaf sync ..."
& git -C $clonePath commit -m $commitMessage
if ($LASTEXITCODE -ne 0) {
  throw "git commit failed in $clonePath"
}

Write-Output "Pushing synced templates to Overleaf ..."
& git -C $clonePath push origin master
if ($LASTEXITCODE -ne 0) {
  Write-Output "Initial push was rejected. Rebasing and retrying once ..."
  & git -C $clonePath pull --rebase origin master
  if ($LASTEXITCODE -ne 0) {
    throw "git push failed and git pull --rebase retry also failed in $clonePath"
  }

  & git -C $clonePath push origin master
  if ($LASTEXITCODE -ne 0) {
    throw "git push failed in $clonePath even after rebasing."
  }
}

Write-Output "Synced templates:"
$copied | ForEach-Object { Write-Output "  $_" }
Write-Output "Overleaf bootstrap complete."
