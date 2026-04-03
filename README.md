# JobPilot

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that automates your job search end-to-end: find matching positions, auto-fill applications, generate cover letters, write proposals, and prep for interviews - all powered by your resume.

![Autopilot batch confirmation - jobs scored and ranked against your resume](docs/images/batch-confirmation.png)

## What It Does

| Skill | Command | What it does |
| ----- | ------- | ------------ |
| **Autopilot** | `/autopilot <query>` | Search boards, score matches, and apply to jobs autonomously in batch |
| **Apply** | `/apply <url>` | Auto-fill a single job application form via browser automation |
| **Batch Apply** | `/apply-batch <file>` | Apply to multiple jobs from a file of URLs with scoring and batch approval |
| **Search** | `/search <query>` | Search job boards and rank results by qualification fit |
| **Cover Letter** | `/cover-letter <job_desc>` | Generate a tailored cover letter matched to your experience |
| **Upwork Proposal** | `/upwork-proposal <job_desc>` | Generate a concise, client-focused Upwork proposal |
| **Interview Prep** | `/interview <job_desc>` | Generate Q&A prep (behavioral, technical, system design) |
| **Dashboard** | `/dashboard` | View application stats, success rates, and export to CSV |
| **Humanizer** | `/humanizer <text>` | Rewrite text to remove AI patterns and sound natural |

## Quick Start

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Git (Git for Windows includes Git Bash)
- [jq](https://jqlang.github.io/jq/download/) is required by utility scripts (auto-installed on first run if missing)

### 1. Install

```bash
git clone --recursive https://github.com/suxrobgm/jobpilot.git
claude --plugin-dir ./jobpilot
```

![Launching JobPilot with claude --plugin-dir](docs/images/launch.png)

> Use `--recursive` to pull the [humanizer](https://github.com/blader/humanizer) submodule.

### 2. Set up your profile

```bash
cp profile.example.json profile.json
```

Edit `profile.json` with your personal info, resume path, credentials, and job board config. See [Configuration](docs/configuration.md) for the full reference.

On Windows PowerShell, run a local setup check with:

```powershell
.\scripts\check-setup.ps1
```

If `bash` is not on your PATH, run shell scripts through the wrapper:

```powershell
.\scripts\run-bash.ps1 scripts\overleaf-clone.sh
```

For Overleaf setup on Windows, you can also use the native PowerShell script:

```powershell
.\scripts\overleaf-clone.ps1
```

To run the full Overleaf bootstrap on Windows without Claude-specific commands:

```powershell
.\scripts\overleaf-bootstrap.ps1
```

To run the standalone unattended workflow:

```powershell
.\scripts\jobpilot-autorun.ps1
```

If Overleaf prompts for a browser verification step before PDF download, run this once first to seed the persistent browser session used by autorun:

```powershell
.\scripts\overleaf-login-bootstrap.ps1
```

To enable OpenAI-powered JD-aware resume tailoring in the standalone flow, set `OPENAI_API_KEY` in your environment or `.env`, then enable the `openai` block in `profile.json`.

Unattended runs now prefer direct ATS/company apply URLs. Aggregator pages like LinkedIn are treated as discovery sources unless JobPilot can extract the external apply link.

To create a Desktop shortcut for the unattended workflow:

```powershell
.\scripts\install-desktop-shortcut.ps1
```

On Windows, that shortcut is created in the Desktop path Windows resolves for your account, which is often `OneDrive\Desktop` on synced machines.

### 3. Allow browser permissions (recommended)

Add to `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_jobpilot_playwright__*"
    ]
  }
}
```

## Usage

```bash
# Autopilot: search and apply to matching jobs autonomously
/autopilot "senior fullstack developer Portland ME remote"

# Apply to a single job
/apply https://boards.greenhouse.io/company/jobs/12345

# Apply to multiple jobs from a file
/apply-batch jobs-to-apply.txt

# Search for jobs
/search "software engineer remote"

# Generate a cover letter
/cover-letter We are looking for a senior full-stack developer...

# Write an Upwork proposal
/upwork-proposal Need a React/Node developer to build a dashboard...

# Prep for an interview
/interview We are hiring a backend engineer for our API platform...

# Resume an interrupted autopilot run
/autopilot "resume"

# View application tracking dashboard
/dashboard

# Export all applications to CSV
/dashboard "export"
```

![Auto-filling a job application form with profile data](docs/images/form-autofill.png)

![Autopilot run summary showing applied, failed, and skipped jobs](docs/images/run-summary.png)

![Application tracking dashboard with stats and failure reasons](docs/images/dashboard.png)

## Documentation

- [Configuration](docs/configuration.md) - profile setup, job boards, autopilot settings, work authorization, EEO
- [How It Works](docs/how-it-works.md) - architecture, skill details, project structure
- [Standalone CLI](docs/standalone-cli.md) - run search, tailor, apply, and autopilot without Claude skills

## Credits

- [Humanizer](https://github.com/blader/humanizer) by blader - included as a git submodule (MIT License)

## License

MIT
