param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$profilePath = Join-Path $repoRoot "profile.json"
$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param(
    [string]$Level,
    [string]$Name,
    [string]$Message
  )

  $results.Add([pscustomobject]@{
      Level   = $Level
      Name    = $Name
      Message = $Message
    })
}

function Get-Value {
  param(
    $Root,
    [string[]]$Path
  )

  $current = $Root
  foreach ($segment in $Path) {
    if ($null -eq $current) {
      return $null
    }

    $prop = $current.PSObject.Properties[$segment]
    if (-not $prop) {
      return $null
    }

    $current = $prop.Value
  }

  return $current
}

function Test-Placeholder {
  param($Value)

  if ($null -eq $Value) {
    return $true
  }

  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $true
  }

  $markers = @(
    "your",
    "example.com",
    "YOUR_",
    "placeholder",
    "123 Main St",
    "555-555-5555",
    "yoursite.com",
    "yourhandle"
  )

  foreach ($marker in $markers) {
    if ($text -like "*$marker*") {
      return $true
    }
  }

  return $false
}

function Check-Field {
  param(
    [string]$Level,
    [string]$Name,
    [string[]]$Path,
    [string]$Hint
  )

  $value = Get-Value -Root $profile -Path $Path
  if (Test-Placeholder $value) {
    Add-Result $Level $Name $Hint
    return $null
  }

  return $value
}

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

if (-not (Test-Path $profilePath)) {
  Add-Result "ERROR" "profile.json" "Create profile.json from profile.example.json before running setup checks."
  $results | ForEach-Object { "{0}`t{1}`t{2}" -f $_.Level, $_.Name, $_.Message }
  exit 1
}

try {
  $profile = Get-Content $profilePath -Raw | ConvertFrom-Json
} catch {
  Add-Result "ERROR" "profile.json" "profile.json is not valid JSON."
  $results | ForEach-Object { "{0}`t{1}`t{2}" -f $_.Level, $_.Name, $_.Message }
  exit 1
}

$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if ($gitCommand) {
  Add-Result "OK" "git" "Git is available."
} else {
  Add-Result "ERROR" "git" "Git is required for Overleaf sync and repo workflows."
}

$bashCommand = Get-Command bash -ErrorAction SilentlyContinue
$gitBashPath = "C:\Program Files\Git\bin\bash.exe"
if ($bashCommand) {
  Add-Result "OK" "bash" "bash is available on PATH."
} elseif (Test-Path $gitBashPath) {
  Add-Result "WARN" "bash" "bash is not on PATH. From PowerShell, use the native script: .\scripts\overleaf-clone.ps1"
} else {
  Add-Result "WARN" "bash" "bash was not found. Install Git for Windows if you want to run the shell scripts manually."
}

$jqCommand = Get-Command jq -ErrorAction SilentlyContinue
$jqWingetPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
if ($jqCommand) {
  Add-Result "OK" "jq" "jq is available on PATH."
} elseif (Test-Path $jqWingetPath) {
  $jqFallback = Get-ChildItem -Path $jqWingetPath -Recurse -Filter jq.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($jqFallback) {
    Add-Result "WARN" "jq" "jq is installed but may need a new shell. JobPilot's scripts now detect the WinGet install path automatically."
  } else {
    Add-Result "WARN" "jq" "jq is not installed yet. The shell scripts can install it on first run."
  }
} else {
  Add-Result "WARN" "jq" "jq is not installed yet. The shell scripts can install it on first run."
}

if ($gitCommand) {
  $trackedOutput = & git -C $repoRoot ls-files -- profile.json
  if ($trackedOutput) {
    Add-Result "ERROR" "profile.json" "profile.json is tracked by git. Remove it from version control before pushing."
  } else {
    $previousNativePreference = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    $ignoredOutput = & git -C $repoRoot check-ignore profile.json 2>$null
    $PSNativeCommandUseErrorActionPreference = $previousNativePreference
    if ($LASTEXITCODE -eq 0 -and $ignoredOutput) {
      Add-Result "OK" "profile.json" "profile.json is ignored by git."
    } else {
      Add-Result "WARN" "profile.json" "profile.json is not tracked, but gitignore could not be confirmed."
    }
  }
}

$desktopPath = [Environment]::GetFolderPath("Desktop")
$autorunLauncherPath = Join-Path $PSScriptRoot "jobpilot-autorun.cmd"
if ([string]::IsNullOrWhiteSpace($desktopPath) -or -not (Test-Path -LiteralPath $desktopPath)) {
  Add-Result "WARN" "desktop" "Windows Desktop path could not be resolved."
} else {
  Add-Result "OK" "desktop" "Windows Desktop resolves to $desktopPath."

  $shortcutPath = Join-Path $desktopPath "JobPilot Autopilot.lnk"
  if (-not (Test-Path -LiteralPath $shortcutPath)) {
    Add-Result "WARN" "desktop shortcut" "Shortcut not found. Run .\scripts\install-desktop-shortcut.ps1"
  } else {
    try {
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($shortcutPath)
      if ($shortcut.TargetPath -eq $autorunLauncherPath) {
        Add-Result "OK" "desktop shortcut" "Desktop shortcut points to scripts\jobpilot-autorun.cmd."
      } else {
        $targetMessage = if ([string]::IsNullOrWhiteSpace($shortcut.TargetPath)) {
          "an empty target"
        } else {
          $shortcut.TargetPath
        }
        Add-Result "WARN" "desktop shortcut" "Shortcut exists but points to $targetMessage. Re-run .\scripts\install-desktop-shortcut.ps1"
      }
    } catch {
      Add-Result "WARN" "desktop shortcut" "Shortcut exists but could not be inspected. Re-run .\scripts\install-desktop-shortcut.ps1"
    }
  }
}

$null = Check-Field "ERROR" "personal.firstName" @("personal", "firstName") "Set personal.firstName."
$null = Check-Field "ERROR" "personal.lastName" @("personal", "lastName") "Set personal.lastName."
$null = Check-Field "ERROR" "personal.email" @("personal", "email") "Set personal.email."
$null = Check-Field "ERROR" "personal.phone" @("personal", "phone") "Set personal.phone."
$null = Check-Field "WARN" "personal.website" @("personal", "website") "Add personal.website if you want JobPilot to auto-fill portfolio fields."
$null = Check-Field "WARN" "personal.linkedin" @("personal", "linkedin") "Add personal.linkedin if you want LinkedIn fields filled automatically."
$null = Check-Field "WARN" "personal.github" @("personal", "github") "Add personal.github if you want GitHub fields filled automatically."

$defaultResume = Check-Field "ERROR" "personal.resumes.default" @("personal", "resumes", "default") "Set personal.resumes.default to your primary resume path."
$null = Check-Field "ERROR" "address.street" @("address", "street") "Set address.street."
$null = Check-Field "ERROR" "address.city" @("address", "city") "Set address.city."
$null = Check-Field "ERROR" "address.state" @("address", "state") "Set address.state."
$null = Check-Field "ERROR" "address.zipCode" @("address", "zipCode") "Set address.zipCode."
$null = Check-Field "WARN" "workAuthorization.visaStatus" @("workAuthorization", "visaStatus") "Set workAuthorization.visaStatus so visa questions do not interrupt runs."
$null = Check-Field "WARN" "eeo.gender" @("eeo", "gender") "Set eeo defaults if you want diversity questions auto-filled."
$null = Check-Field "WARN" "credentials.default.email" @("credentials", "default", "email") "Set credentials.default.email if you want automatic board login."
$null = Check-Field "WARN" "credentials.default.password" @("credentials", "default", "password") "Set credentials.default.password if you want automatic board login."

if ($defaultResume) {
  $resumePath = if ([System.IO.Path]::IsPathRooted([string]$defaultResume)) {
    [string]$defaultResume
  } else {
    Join-Path $repoRoot ([string]$defaultResume)
  }

  if (Test-Path $resumePath) {
    Add-Result "OK" "resume" "Default resume exists at $defaultResume."
  } else {
    Add-Result "ERROR" "resume" "Default resume path does not exist: $defaultResume"
  }
}

$openAIEnabled = [bool](Get-Value -Root $profile -Path @("openai", "enabled"))
$standaloneRequireOpenAITailoring = [bool](Get-Value -Root $profile -Path @("standalone", "requireOpenAITailoring"))
if ($openAIEnabled) {
  $apiKeyEnvVar = Get-Value -Root $profile -Path @("openai", "apiKeyEnvVar")
  if ([string]::IsNullOrWhiteSpace([string]$apiKeyEnvVar)) {
    $apiKeyEnvVar = "OPENAI_API_KEY"
  }

  $openAIModel = Get-Value -Root $profile -Path @("openai", "model")
  if ([string]::IsNullOrWhiteSpace([string]$openAIModel)) {
    $openAIModel = "gpt-5.4-mini"
  }

  $envPath = Join-Path $repoRoot ".env"
  $apiKeyValue = [Environment]::GetEnvironmentVariable([string]$apiKeyEnvVar, "Process")
  if ([string]::IsNullOrWhiteSpace($apiKeyValue)) {
    $apiKeyValue = [Environment]::GetEnvironmentVariable([string]$apiKeyEnvVar, "User")
  }
  if ([string]::IsNullOrWhiteSpace($apiKeyValue)) {
    $apiKeyValue = Get-LocalEnvValue -EnvPath $envPath -Name ([string]$apiKeyEnvVar)
  }

  if ([string]::IsNullOrWhiteSpace($apiKeyValue)) {
    Add-Result "WARN" "openai.apiKey" "OpenAI tailoring is enabled but $apiKeyEnvVar is not set. Add it to your environment or .env."
  } else {
    Add-Result "OK" "openai.apiKey" "OpenAI API key was found via $apiKeyEnvVar."
  }

  Add-Result "OK" "openai.model" "OpenAI tailoring model is set to $openAIModel."
} elseif ($null -ne (Get-Value -Root $profile -Path @("openai"))) {
  Add-Result "WARN" "openai.enabled" "OpenAI tailoring is configured but disabled."
}

if ($standaloneRequireOpenAITailoring) {
  if (-not $openAIEnabled) {
    Add-Result "ERROR" "standalone.requireOpenAITailoring" "standalone.requireOpenAITailoring is true but openai.enabled is false."
  } elseif ([string]::IsNullOrWhiteSpace($apiKeyValue)) {
    Add-Result "ERROR" "standalone.requireOpenAITailoring" "standalone.requireOpenAITailoring is true but the OpenAI API key is missing."
  } else {
    Add-Result "OK" "standalone.requireOpenAITailoring" "Standalone runs will require successful OpenAI tailoring before applying."
  }
}

$overleafEnabled = [bool](Get-Value -Root $profile -Path @("overleaf", "enabled"))
if (-not $overleafEnabled) {
  Add-Result "WARN" "overleaf.enabled" "Overleaf integration is disabled. Leave it off if you do not need tailored resume automation."
} else {
  Add-Result "OK" "overleaf.enabled" "Overleaf integration is enabled."

  $projectId = Check-Field "ERROR" "overleaf.projectId" @("overleaf", "projectId") "Set overleaf.projectId from your Overleaf project URL."
  $gitUrl = Check-Field "ERROR" "overleaf.gitUrl" @("overleaf", "gitUrl") "Set overleaf.gitUrl to https://git.overleaf.com/<projectId>."
  $loginEmail = Get-Value -Root $profile -Path @("overleaf", "email")
  if (Test-Placeholder $loginEmail) {
    $loginEmail = Get-Value -Root $profile -Path @("overleaf", "gitUsername")
  }
  if (Test-Placeholder $loginEmail) {
    $loginEmail = Get-Value -Root $profile -Path @("personal", "email")
  }
  $gitToken = Get-Value -Root $profile -Path @("overleaf", "gitToken")
  $legacyGitPassword = Get-Value -Root $profile -Path @("overleaf", "gitPassword")
  $webPassword = Get-Value -Root $profile -Path @("overleaf", "webPassword")
  $localClonePath = Check-Field "ERROR" "overleaf.localClonePath" @("overleaf", "localClonePath") "Set overleaf.localClonePath."
  $tailoredOutputDir = Check-Field "ERROR" "overleaf.tailoredOutputDir" @("overleaf", "tailoredOutputDir") "Set overleaf.tailoredOutputDir."

  if (Test-Placeholder $gitToken) {
    if (Test-Placeholder $legacyGitPassword) {
      Add-Result "ERROR" "overleaf.gitToken" "Set overleaf.gitToken to an Overleaf Git token. Overleaf no longer accepts regular passwords for Git Bridge."
    } else {
      Add-Result "WARN" "overleaf.gitToken" "Using legacy overleaf.gitPassword. Prefer renaming it to overleaf.gitToken."
    }
  } else {
    Add-Result "OK" "overleaf.gitToken" "Overleaf Git token is configured."
  }

  if (Test-Placeholder $loginEmail) {
    Add-Result "WARN" "overleaf.email" "Add overleaf.email if you want Overleaf website login automated during PDF download."
  } else {
    Add-Result "OK" "overleaf.email" "Overleaf login email is configured."
  }

  if (Test-Placeholder $webPassword) {
    Add-Result "WARN" "overleaf.webPassword" "overleaf.webPassword is not set. If Overleaf prompts for browser login during PDF download, sign in manually or add your web password."
  } else {
    Add-Result "OK" "overleaf.webPassword" "Overleaf browser login password is configured."
  }

  if ($projectId -and $gitUrl) {
    $expectedGitUrl = "https://git.overleaf.com/$projectId"
    if ([string]$gitUrl -eq $expectedGitUrl) {
      Add-Result "OK" "overleaf.gitUrl" "overleaf.gitUrl matches the project ID."
    } else {
      Add-Result "WARN" "overleaf.gitUrl" "overleaf.gitUrl does not match overleaf.projectId. Expected $expectedGitUrl"
    }
  }

  foreach ($roleType in @("product-ds", "ml-ds", "general-ds")) {
    $texFile = Get-Value -Root $profile -Path @("overleaf", "texFiles", $roleType)
    if (Test-Placeholder $texFile) {
      Add-Result "ERROR" "overleaf.texFiles.$roleType" "Set overleaf.texFiles.$roleType to the matching .tex filename in Overleaf."
    }
  }

  if ($localClonePath) {
    $resolvedClonePath = if ([System.IO.Path]::IsPathRooted([string]$localClonePath)) {
      [string]$localClonePath
    } else {
      Join-Path $repoRoot ([string]$localClonePath)
    }

    if (Test-Path $resolvedClonePath) {
      Add-Result "OK" "overleaf clone" "Local clone exists at $localClonePath."

      foreach ($roleType in @("product-ds", "ml-ds", "general-ds")) {
        $texFile = Get-Value -Root $profile -Path @("overleaf", "texFiles", $roleType)
        if (-not (Test-Placeholder $texFile)) {
          $texPath = Join-Path $resolvedClonePath ([string]$texFile)
          if (Test-Path $texPath) {
            Add-Result "OK" "overleaf template $roleType" "Found $texFile in the local Overleaf clone."
          } else {
            Add-Result "WARN" "overleaf template $roleType" "Configured template file is missing from the local Overleaf clone: $texFile"
          }
        }
      }
    } else {
      Add-Result "WARN" "overleaf clone" "Local clone not found yet. Run .\scripts\overleaf-clone.ps1 after setting your Git token."
    }
  }

  if ($tailoredOutputDir) {
    $resolvedOutputDir = if ([System.IO.Path]::IsPathRooted([string]$tailoredOutputDir)) {
      [string]$tailoredOutputDir
    } else {
      Join-Path $repoRoot ([string]$tailoredOutputDir)
    }

    if (Test-Path $resolvedOutputDir) {
      Add-Result "OK" "overleaf output" "Tailored output directory exists at $tailoredOutputDir."
    } else {
      Add-Result "WARN" "overleaf output" "Tailored output directory does not exist yet: $tailoredOutputDir"
    }
  }
}

$results | ForEach-Object {
  "{0}`t{1}`t{2}" -f $_.Level, $_.Name, $_.Message
}

$errorCount = ($results | Where-Object Level -eq "ERROR").Count
if ($errorCount -gt 0) {
  exit 1
}

