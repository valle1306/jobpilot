# Standalone CLI

This repo now includes a standalone JobPilot CLI that does not depend on Claude skills to run.

## Install

1. Install Node.js LTS.
2. From the repo root, run:

```powershell
.\scripts\standalone-install.ps1
```

Optional for OpenAI-powered resume tailoring:

1. Create `.env` from [.env.example](c:\Users\lpnhu\Downloads\jobpilot\.env.example), or set a permanent user environment variable:

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your-openai-api-key", "User")
```

2. Enable the `openai` block in `profile.json`.

## Commands

Use the PowerShell wrapper:

```powershell
.\scripts\jobpilot-standalone.ps1 help
```

For unattended runs from a desktop shortcut:

```powershell
.\scripts\jobpilot-autorun.ps1
```

### Setup

```powershell
.\scripts\jobpilot-standalone.ps1 setup
.\scripts\jobpilot-standalone.ps1 setup --bootstrap-overleaf
```

### Search

```powershell
.\scripts\jobpilot-standalone.ps1 search "data scientist remote"
```

### Tailor a Resume

```powershell
.\scripts\jobpilot-standalone.ps1 tailor "https://jobs.lever.co/company/123"
.\scripts\jobpilot-standalone.ps1 tailor "https://jobs.lever.co/company/123" --no-download
```

### Apply to One Job

```powershell
.\scripts\jobpilot-standalone.ps1 apply "https://boards.greenhouse.io/company/jobs/123"
.\scripts\jobpilot-standalone.ps1 apply "https://boards.greenhouse.io/company/jobs/123" --submit
.\scripts\jobpilot-standalone.ps1 apply "https://boards.greenhouse.io/company/jobs/123" --resume "C:\path\resume.pdf"
```

### Autopilot

Query-based search:

```powershell
.\scripts\jobpilot-standalone.ps1 autopilot "data scientist remote"
```

File-driven batch mode:

```powershell
.\scripts\jobpilot-standalone.ps1 autopilot "manual batch" --file jobs-to-apply.txt --yes
.\scripts\jobpilot-standalone.ps1 autopilot "manual batch" --file jobs-to-apply.txt --yes --submit
```

### Autorun

`autorun` reads the `standalone` block from `profile.json` and runs without prompts.

```powershell
.\scripts\jobpilot-standalone.ps1 autorun
```

Current `standalone` config supports:

- `mode`: `query` or `file`
- `query`: default search query
- `queries`: optional list of default search queries for autorun; useful for adjacent roles like data analyst and product analyst
- `filePath`: URL list for file-driven batches
- `headless`: run the browser headlessly
- `autoApprove`: skip batch confirmation
- `autoSubmit`: submit application forms automatically
- `entryLevelOnly`: skip senior/staff/manager-style titles
- `entryLevelMaxYears`: skip roles that explicitly ask for more than this many years of experience
- `preferredLocations`: preferred locations for filtering; use `["Anywhere"]` or `[]` to disable location filtering
- `skipTitleKeywords`: extra blocked title keywords
- `maxApplicationsPerRun`: set to `0` to apply all currently qualified matches in the run
- `searchLimitPerQuery`: how many jobs to hydrate per query before filtering
- `resumePath`: optional direct resume override
- `logDir`: where autorun logs go

Current `openai` config supports:

- `enabled`: turn on OpenAI-backed resume tailoring before Overleaf compile
- `apiKeyEnvVar`: environment variable name for the API key, usually `OPENAI_API_KEY`
- `model`: OpenAI model ID, default `gpt-5.4-mini`
- `maxBulletEdits`: maximum LaTeX bullet rewrites per tailored resume
- `maxBulletsPerEntry`: cap edits per role/project entry
- `maxExtraCharsPerBullet`: one-page guardrail for line growth
- `maxTotalAddedChars`: one-page guardrail across the whole tailored resume

### Desktop Shortcut

To install a desktop shortcut that launches the unattended workflow:

```powershell
.\scripts\install-desktop-shortcut.ps1
```

That shortcut points to [scripts/jobpilot-autorun.cmd](c:\Users\lpnhu\Downloads\jobpilot\scripts\jobpilot-autorun.cmd), which in turn runs [scripts/jobpilot-autorun.ps1](c:\Users\lpnhu\Downloads\jobpilot\scripts\jobpilot-autorun.ps1).

On Windows, the shortcut is created in whatever path `[Environment]::GetFolderPath("Desktop")` returns. If your Desktop is synced with OneDrive, that usually means `C:\Users\<you>\OneDrive\Desktop` instead of `C:\Users\<you>\Desktop`.

You can verify the shortcut status any time with:

```powershell
.\scripts\check-setup.ps1
```

## Current Scope

- Search is best-effort and still needs adapter tuning per board.
- Tailoring in standalone mode can now use OpenAI for JD-aware bullet rewrites, but it still validates edits aggressively and falls back to the conservative path if an edit looks unsafe.
- Apply/autopilot are designed for ATS-style forms and may still need board-specific refinements for some sites.
- If you do not store `overleaf.webPassword`, Overleaf PDF download will pause for manual browser login.
