---
name: dashboard
description: View application tracking stats across all autopilot runs. Shows totals, per-board breakdown, success rate, and recent activity. Can export to CSV.
argument-hint: "<'stats' | 'export' | 'failed' | 'board <name>'>"
---

# Application Tracking Dashboard

You present a summary of the user's job application history across all autopilot runs.

## Setup

Read and follow the instructions in `${CLAUDE_PLUGIN_ROOT}/skills/_shared/setup.md` to load the profile and resume.

## Get Stats

Run `bash ${CLAUDE_PLUGIN_ROOT}/scripts/run-stats.sh` to get a JSON summary of all runs. Parse the output and present it based on the user's request.

## Commands

### Default / `stats`

If no argument is provided, or the argument is `"stats"`, present the full dashboard:

```
## Job Application Dashboard

| Metric | Count |
|--------|-------|
| Total runs | <totalRuns> |
| Jobs found | <totalJobsFound> |
| Applied | <totalApplied> |
| Failed | <totalFailed> |
| Skipped | <totalSkipped> |
| Success rate | <successRate> |

### By Board

| Board | Found | Applied | Failed | Skipped |
|-------|-------|---------|--------|---------|
| Hiring Cafe | 45 | 15 | 5 | 25 |
| LinkedIn | 27 | 8 | 3 | 16 |

### Recent Runs

| Run | Query | Status | Applied | Failed | Date |
|-----|-------|--------|---------|--------|------|
| <runId> | <query> | <status> | <applied> | <failed> | <startedAt> |

**Commands:**
- "failed" -- show all failed applications with reasons
- "board <name>" -- show details for a specific board
- "export" -- export all applications to CSV
- "retry-failed <run-id>" -- chain to /autopilot to retry failures
```

### `failed`

Show all failed applications with their failure reasons and retry notes:

```
## Failed Applications

| # | Title | Company | Board | Reason | Run |
|---|-------|---------|-------|--------|-----|
| 1 | Software Engineer | Acme Corp | LinkedIn | CAPTCHA required | 2026-03-22... |
| 2 | Full Stack Dev | BigCo | Indeed | Login failed | 2026-03-22... |

For jobs with retry notes, show them below the table.

**Tip:** Use `/autopilot "retry-failed <run-id>"` to retry failures from a specific run.
```

### `board <name>`

Filter stats for a specific board. Show all applied and failed jobs from that board.

### `export`

Run `bash ${CLAUDE_PLUGIN_ROOT}/scripts/export-csv.sh` to export all applied and failed jobs to `job-applications.csv`. Report the file path and count to the user.

## Important Rules

1. **Always use the script** to get stats. Never read run files directly.
2. **Format numbers clearly** - use counts, not raw JSON.
3. **Keep it scannable** - tables over paragraphs.
4. **Offer next actions** after every view.
