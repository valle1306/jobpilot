# How It Works

## Architecture

- All skills are **prompt-based** - no compiled code, just markdown instruction files that Claude follows at runtime
- Browser automation uses [Playwright MCP](https://github.com/anthropics/claude-code/blob/main/docs/mcp.md) for navigation, form filling, and page reading
- Shared logic (authentication, form filling, browser tips) lives in `skills/_shared/` and is referenced by each skill
- The autopilot skill tracks progress in `runs/*.json` files so interrupted runs can resume exactly where they left off
- Previously applied jobs are automatically excluded from future searches using `scripts/applied-jobs.sh`
- Cover letters and proposals are passed through the [humanizer](https://github.com/blader/humanizer) to remove AI writing patterns

## Skills in Detail

### Autopilot (`/autopilot`)

The flagship skill. Combines search and apply into a single autonomous workflow:

1. **Search** - navigates to each enabled job board, logs in, searches for matching jobs
2. **Score** - rates each job against your resume (1-10) on tech stack, experience, seniority, location
3. **Filter** - removes jobs below `minMatchScore`, from blocked companies, or previously applied to
4. **Confirm** - presents a ranked table for one-time approval (or auto-approves if `confirmMode: "auto"` and all scores >= 6)
5. **Apply** - fills and submits every approved application autonomously
6. **Track** - saves progress to `runs/*.json` after every action for resumability

Special invocations:

- `/autopilot "resume"` - resume an interrupted run
- `/autopilot "retry-failed <run-id>"` - retry failed applications from a completed run

### Apply (`/apply-job`)

Single-job application. Navigates to the job page, performs a qualification fit review, handles login, and fills every form field from your profile and resume. Always asks for confirmation before submitting.

### Search (`/search-job`)

Searches enabled job boards, scores results against your resume, and presents a ranked table. Offers next actions: apply, get details, or generate a cover letter for any result.

### Cover Letter (`/cover-letter`)

Analyzes the job description against your resume, writes a tailored cover letter, and passes it through the humanizer for natural tone. Output is 350-450 words.

### Upwork Proposal (`/upwork-proposal`)

Writes a concise Upwork proposal (under 200 words) focused on the client's needs, with specific project examples from your resume. Passed through the humanizer.

### Interview Prep (`/interview`)

Generates role-specific prep material: behavioral questions with STAR-format answers from your experience, technical questions on the role's stack, system design scenarios, and gap analysis.

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
    apply-job/          # Single job application
    autopilot/          # Autonomous batch search + apply
    cover-letter/       # Cover letter generation
    interview/          # Interview prep Q&A
    search-job/         # Job board search
    upwork-proposal/    # Upwork proposal generation
    humanizer/          # AI text humanizer (git submodule)
  scripts/
    applied-jobs.sh     # Returns previously applied jobs from run history
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
