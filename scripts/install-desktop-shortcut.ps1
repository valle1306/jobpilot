param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetPath = Join-Path $PSScriptRoot "jobpilot-autorun.cmd"

if (-not (Test-Path $targetPath)) {
  throw "Launcher target not found: $targetPath"
}

$desktopPath = [Environment]::GetFolderPath("Desktop")
if ([string]::IsNullOrWhiteSpace($desktopPath) -or -not (Test-Path -LiteralPath $desktopPath)) {
  throw "Windows Desktop path could not be resolved."
}

$shortcutPath = Join-Path $desktopPath "JobPilot Autopilot.lnk"
$workingDirectory = $repoRoot
$iconPath = "$env:SystemRoot\System32\shell32.dll"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $workingDirectory
$shortcut.Description = "Run the standalone JobPilot autorun workflow"
$shortcut.IconLocation = "$iconPath,220"
$shortcut.Save()

Write-Output "Desktop resolved to: $desktopPath"
Write-Output "Desktop shortcut created: $shortcutPath"
Write-Output "Shortcut target: $targetPath"
