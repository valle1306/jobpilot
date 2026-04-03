# How It Works

## Architecture

- All skills are **prompt-based** - no compiled code, just markdown instruction files that Claude follows at runtime
- Browser automation uses [Playwright MCP](https://github.com/anthropics/claude-code/blob/main/docs/mcp.md) for navigation, form filling, and page reading
- Shared logic (authentication, form filling, browser tips) lives in `skills/_shared/` and is referenced by each skill
- The autopilot skill tracks progress in `runs/*.json` files so interrupted runs can resume exactly where they left off
- A persistent applied-jobs database (`applied-jobs.json`) prevents duplicate applications even if run files are deleted. Every successful application is logged via `scripts/log-applied.sh` and checked before applying via `scripts/check-applied.sh`
- Cover letters and proposals are passed through the [humanizer](https://github.com/blader/humanizer) to remove AI writing patterns

## Why Claude Felt Smoother

Claude Code's strength is not that it bypasses ATS security. It works better on messy portals because the runtime can:

- inspect the live page repeatedly and change tactics
- pause for human help on login, email codes, CAPTCHA, or account creation
- resume the same run after that interruption
- leave retry notes when a specific path fails

That means the original Claude `/autopilot` behaves like a supervised agent. It is still using browser automation, but it can recover interactively in a way a pure deterministic script cannot.

## Standalone Adaptation

The standalone Codex-powered flow now mirrors that split explicitly:

- **`executionMode: "unattended-safe"`**: conservative fire-and-forget mode. It does not wait for user input, skips hosts outside a safe-host allowlist, and treats verification/account walls as reasons to skip or fail fast and continue.
- **`executionMode: "supervised"`**: visible browser mode. It is the closer analogue to the Claude skills flow because JobPilot can pause on hard ATS pages, let the user handle verification or trigger an autofill extension, and then continue with the same run.

In both modes:

- Codex CLI can tailor the LaTeX resume before Overleaf compilation
- Playwright handles the actual browser interaction
- run files and applied-job tracking still persist progress and prevent duplicate applications

## Skills in Detail

### Autopilot (`/autopilot`)

The flagship skill. Combines search and apply into a single autonomous workflow:

1. **Search** - navigates to each enabled job board, logs in, searches for matching jobs
2. **Score** - rates each job against your resume (1-10) on tech stack, experience, seniority, location
3. **Filter** - removes jobs below `minMatchScore`, from blocked companies, or previously applied to
4. **Confirm** - presents a ranked table for one-time approval (or auto-approves if `confirmMode: "auto"` and all scores >= `minMatchScore`)
5. **Apply** - fills and submits every approved application autonomously
6. **Track** - saves progress to `runs/*.json` after every action for resumability

Special invocations:

- `/autopilot "resume"` - resume an interrupted run
- `/autopilot "retry-failed <run-id>"` - retry failed applications from a completed run

### Apply (`/apply`)

Single-job application. Navigates to the job page, performs a qualification fit review, handles login, and fills every form field from your profile and resume. Always asks for confirmation before submitting.

### Batch Apply (`/apply-batch`)

Apply to multiple jobs from a file of URLs. Visits each job page, extracts details, scores against your resume, and presents a batch confirmation table. After approval, applies to every approved job autonomously with full progress tracking. Create a `jobs-to-apply.txt` file with one URL per line (see `jobs-to-apply.example.txt` for the format).

### Search (`/search`)

Searches enabled job boards, scores results against your resume, and presents a ranked table. Offers next actions: apply, get details, or generate a cover letter for any result.

### Cover Letter (`/cover-letter`)

Analyzes the job description against your resume, writes a tailored cover letter, and passes it through the humanizer for natural tone. Output is 350-450 words.

### Upwork Proposal (`/upwork-proposal`)

Writes a concise Upwork proposal (under 200 words) focused on the client's needs, with specific project examples from your resume. Passed through the humanizer.

### Interview Prep (`/interview`)

Generates role-specific prep material: behavioral questions with STAR-format answers from your experience, technical questions on the role's stack, system design scenarios, and gap analysis.

### Dashboard (`/dashboard`)

Aggregates stats across all autopilot runs: total applied, failed, skipped, success rate, per-board breakdown, and recent run history. Can export all applications to CSV for tracking in spreadsheets. Uses `scripts/run-stats.sh` and `scripts/export-csv.sh` to keep context lean.

### Humanizer (`/humanizer`)

Rewrites text to remove AI writing patterns (significance inflation, promotional language, AI vocabulary, etc.) and add natural voice. Used automatically by cover letter and proposal skills.

## Project Structure

```text
jobpilot/
  skills/
    _shared/            # Shared instructions referenced by all skills
      setup.md          # Profile loading, resume reading, credential lookup
      auth.md           # Login flow, 2FA, registration, OAuth
      form-filling.md   # Field mapping, special fields, multi-page forms
      browser-tips.md   # Large page handling, token overflow, popups
    apply/              # Single job application
    apply-batch/        # Batch apply from a file of URLs
    autopilot/          # Autonomous batch search + apply
    cover-letter/       # Cover letter generation
    dashboard/          # Application tracking stats and export
    interview/          # Interview prep Q&A
    search/             # Job board search
    upwork-proposal/    # Upwork proposal generation
    humanizer/          # AI text humanizer (git submodule)
  scripts/
    check-applied.sh    # Checks if a job URL was already applied to
    log-applied.sh      # Logs a successful application to the database
    run-stats.sh        # Aggregates stats from all run files
    export-csv.sh       # Exports applications to CSV
    update-run.sh       # Updates run file fields without full JSON read
  applied-jobs.json     # Persistent applied-jobs database (gitignored)
  jobs-to-apply.example.txt  # Template for batch apply
  docs/
    images/             # Screenshots for documentation
    configuration.md    # Detailed configuration reference
    how-it-works.md     # This file
  runs/                 # Autopilot progress files (gitignored)
  profile.json          # Your personal config (gitignored)
  profile.example.json  # Template for new users
  settings.json         # Plugin-level permission settings
  .claude-plugin/
    plugin.json         # Plugin manifest (name, version, author)
  .mcp.json             # Playwright MCP server config
```
