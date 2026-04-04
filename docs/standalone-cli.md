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

For repo-local standalone runs, values in `.env` take precedence over inherited Windows environment variables. This avoids stale user-level `OPENAI_API_KEY` values overriding the key you intended to use for this repo.

For Codex CLI-powered tailoring on Windows:

```powershell
.\scripts\codex-bootstrap.ps1
```

JobPilot will use your existing Codex CLI ChatGPT login when available, or fall back to `CODEX_API_KEY` / `OPENAI_API_KEY` from `.env`.

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
.\scripts\jobpilot-standalone.ps1 setup --bootstrap-codex
.\scripts\overleaf-login-bootstrap.ps1
.\scripts\search-session-bootstrap.ps1
.\scripts\codex-bootstrap.ps1
```

Use `.\scripts\overleaf-login-bootstrap.ps1` once if Overleaf asks for a browser verification step. It opens the same persistent browser profile that unattended runs reuse later.
Use `.\scripts\search-session-bootstrap.ps1` if LinkedIn, Indeed, or other search boards are showing authwalls or security verification screens. It opens the enabled search boards in the persistent browser profile so you can sign in or solve the challenge once.

### Search

```powershell
.\scripts\jobpilot-standalone.ps1 search "data scientist remote"
.\scripts\jobpilot-standalone.ps1 search "entry level data analyst" --search-mode direct-ats-first
.\scripts\jobpilot-standalone.ps1 search "entry level data analyst" --search-mode direct-ats-first --posted-within-hours 24
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
.\scripts\jobpilot-standalone.ps1 autopilot "entry level data analyst" --yes --search-mode direct-ats-first
.\scripts\jobpilot-standalone.ps1 autopilot "entry level data analyst" --yes --search-mode direct-ats-first --posted-within-hours 24
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

- `executionMode`: `unattended-safe` or `supervised`; unattended-safe never waits for manual auth/verification and skips outside a conservative safe-host allowlist
- `browserName`: `edge` or `chrome`
- `browserUserDataDir`: optional browser user-data root; when you point this at a real Edge or Chrome profile, JobPilot mirrors that profile state into a repo-local automation profile before launch instead of trying to take over the live browser profile directly
- `browserProfileDirectory`: optional browser profile directory name such as `Default` when reusing a real browser profile
- `mode`: `query` or `file`
- `query`: default search query
- `queries`: optional list of default search queries for autorun; useful for adjacent roles like data analyst and product analyst
- `filePath`: URL list for file-driven batches
- `headless`: run the browser headlessly; set this to `false` if you want to watch Playwright drive the browser live
- `autoApprove`: skip batch confirmation
- `autoSubmit`: submit application forms automatically
- `runLoopMode`: currently `one-pass`; autorun searches once, processes the current batch, and exits with a summary
- `failurePolicy`: currently `continue-and-log`; failed jobs are recorded and the run continues
- `searchMode`: `balanced` or `direct-ats-first`; the direct ATS mode ranks Greenhouse, Lever, and Workday-style hosts ahead of generic external apply links
- `applySurfacePolicy`: default `external-only`; unattended runs use LinkedIn as discovery only and follow extracted external apply targets
- `guidanceProvider`: `codex-cli` or `deterministic`; `codex-cli` lets Codex review the discovered job pool and choose what this run should pursue
- `codexGuidedRun`: enables Codex-guided run selection when Codex CLI is available
- `codexGuidedMaxReviewJobs`: maximum number of discovered jobs shown to Codex for one run-planning pass
- `codexGuidedRescueMinScore`: lowest heuristic match score a job can have and still be eligible for Codex-guided rescue
- `postedWithinHours`: optional posting-age filter; set `24` to keep the search/apply pass focused on jobs from the past day when the board exposes posting age
- `tailoringProvider`: preferred AI tailoring backend; use `codex-cli` for file-level LaTeX editing through Codex CLI
- `requireTailoringProvider`: set to `codex-cli`, `openai`, or `ai-agent` to block applications unless that provider succeeds
- `codexAssistedApply`: when `true`, hard ATS hosts can ask Codex CLI for the next browser actions based on the live page state
- `manualAutofillAssist`: when `true` and the browser is visible, JobPilot pauses on difficult ATS pages so you can use a browser autofill extension manually before resuming
- `unattendedSafeHostsOnly`: when `true`, unattended-safe runs skip apply hosts outside the safe-host allowlist
- `unattendedSafeApplyHosts`: conservative allowlist for true unattended auto-apply hosts
- `codexAssistedApplyHosts`: host substrings that should trigger Codex-assisted apply, such as Workday, UKG/UltiPro, ADP, iCIMS, Taleo, Oracle Recruiting, SilkRoad, and Avature tenants
- `codexAssistedApplyMaxRounds`: how many Codex-assisted planning rounds a single application step can use before falling back to the normal bounded loop
- `codexAssistedApplyMaxActions`: maximum browser actions Codex can suggest per assistance round
- `entryLevelOnly`: skip senior/staff/manager-style titles
- `entryLevelMaxYears`: skip roles that explicitly ask for more than this many years of experience
- `preferredLocations`: preferred locations for filtering; use `["Anywhere"]` or `[]` to disable location filtering
- `requireDirectApply`: when `true`, unattended runs skip bare aggregator listings like LinkedIn pages unless a direct ATS/company apply URL was extracted
- `requireOpenAITailoring`: legacy boolean gate; if `true`, standalone apply and autorun require an AI tailoring provider instead of heuristic fallback
- `preferredAtsDomains`: optional ATS hosts to prioritize in `direct-ats-first` mode
- `skipTitleKeywords`: extra blocked title keywords
- `maxApplicationsPerRun`: set to `0` to apply all currently qualified matches in the run
- `searchLimitPerQuery`: how many jobs to hydrate per query before filtering
- `resumePath`: optional direct resume override
- `logDir`: where autorun logs go

Each autorun now writes:

- a machine-readable JSON run file in `runs`
- a human-readable summary file next to it as `*.summary.txt`
- stage-specific totals plus skip buckets, including postings skipped for being older than the configured time window
- a richer end-of-run summary grouped by board/apply host, plus top failure and skip reasons

The unattended workflow order is:

- discover jobs
- let Codex CLI review the discovered pool and choose the best unattended-safe external apply targets for this pass
- tailor resume with Codex CLI or the configured AI provider
- compile and download the one-page PDF from Overleaf
- upload the PDF into the ATS/company form
- submit and record the result

Recommended operating model:

- Use `executionMode: "unattended-safe"` when you are away. It behaves more conservatively than the original Claude workflow and skips hosts that are likely to need manual rescue.
- Use `executionMode: "supervised"` when you are present. This is the closer analogue to Claude Code because JobPilot can pause for verification, registration, or manual autofill and then continue.

Current `openai` config supports:

- `enabled`: turn on OpenAI-backed resume tailoring before Overleaf compile
- `enabled`: turn on the legacy OpenAI API tailoring fallback
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
- The current standalone defaults disable `Indeed` and `Hiring Cafe` because both are frequently blocked by anti-bot challenges in unattended mode.
- Tailoring in standalone mode can now use OpenAI for JD-aware bullet rewrites, but it still validates edits aggressively. If OpenAI makes no accepted safe bullet edits, JobPilot now keeps the existing one-page resume content and still records the result as an OpenAI tailoring success instead of forcing a heuristic fallback.
- Standalone mode now supports `codex-cli` as the preferred tailoring provider, which edits a temporary copy of the LaTeX resume file directly before the result is synced back into the Overleaf build flow.
- Standalone mode can also use Codex CLI during the apply stage for hard ATS hosts and other non-preferred external ATS pages. That makes the browser loop more agentic on Workday-class forms, but it still cannot bypass real login, verification, CAPTCHA, or MFA challenges.
- If you enable `requireOpenAITailoring`, that conservative fallback is no longer accepted for unattended applying. The run will fail that job instead of applying with a non-OpenAI-tailored resume.
- Apply/autopilot are designed for ATS-style forms and may still need board-specific refinements for some sites.
- Resume upload handling now includes hidden file inputs, which improves compatibility with ATSes like Lever that wrap the real upload control behind a styled button.
- Workday flows now try to steer toward guest/manual apply paths before falling back to login-required handling, and `incomplete` failures now include visible validation clues when available.
- If an ATS forces account creation before applying, standalone mode now keeps that page in the normal form-filling path and uses your configured application password from `credentials.default.password` unless a board-specific credential override exists.
- If `manualAutofillAssist` is enabled, standalone mode can pause on those difficult ATS pages and let you use a browser autofill extension yourself before JobPilot continues.
- If you want supervised Chrome runs to reuse your installed browser extensions, point `browserUserDataDir` and `browserProfileDirectory` at your real Chrome profile. JobPilot will mirror that profile state into its own automation profile before launch, which is more reliable than trying to attach directly to a live Chrome or Edge session.
- Unattended runs work best with direct ATS/company URLs. LinkedIn Easy Apply is skipped in unattended mode; LinkedIn is treated as a discovery source unless JobPilot can extract a direct external apply link.
- Redirector-style hosts such as `jobright.ai`, `appcast`, `remotehunter`, `jobsyn`, and similar non-ATS apply wrappers are now treated as aggregator surfaces and skipped in unattended mode.
- If an apply host requires login, extra verification, or repeatedly stalls as `incomplete`, standalone autorun now skips the rest of that host for the current run instead of wasting more attempts.
- If Overleaf still triggers a one-time verification step, run `.\scripts\overleaf-login-bootstrap.ps1` first so the persistent browser session is ready before autorun starts.
- Some search boards now block unattended browsers entirely. When that happens, autorun will log the board-specific block reason instead of silently returning zero jobs.
