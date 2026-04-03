# Standalone CLI

This repo now includes a standalone JobPilot CLI that does not depend on Claude skills to run.

## Install

1. Install Node.js LTS.
2. From the repo root, run:

```powershell
.\scripts\standalone-install.ps1
```

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
- `filePath`: URL list for file-driven batches
- `headless`: run the browser headlessly
- `autoApprove`: skip batch confirmation
- `autoSubmit`: submit application forms automatically
- `entryLevelOnly`: skip senior/staff/manager-style titles
- `preferredLocations`: preferred locations for filtering
- `skipTitleKeywords`: extra blocked title keywords
- `maxApplicationsPerRun`
- `resumePath`: optional direct resume override
- `logDir`: where autorun logs go

### Desktop Shortcut

To install a desktop shortcut that launches the unattended workflow:

```powershell
.\scripts\install-desktop-shortcut.ps1
```

That shortcut points to [scripts/jobpilot-autorun.cmd](c:\Users\lpnhu\Downloads\jobpilot\scripts\jobpilot-autorun.cmd), which in turn runs [scripts/jobpilot-autorun.ps1](c:\Users\lpnhu\Downloads\jobpilot\scripts\jobpilot-autorun.ps1).

## Current Scope

- Search is best-effort and still needs adapter tuning per board.
- Tailoring in standalone mode is intentionally conservative: it selects the role-mapped resume template and safely enriches skills lines instead of rewriting experience bullets with an LLM.
- Apply/autopilot are designed for ATS-style forms and may still need board-specific refinements for some sites.
- If you do not store `overleaf.webPassword`, Overleaf PDF download will pause for manual browser login.
