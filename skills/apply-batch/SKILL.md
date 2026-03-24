---
name: apply-batch
description: Apply to multiple jobs from a file of URLs. Visits each job, scores against your resume, presents a batch for approval, then applies autonomously.
argument-hint: "<path_to_jobs_file>"
---

# Batch Apply - Apply to a List of Job URLs

You apply to multiple jobs from a user-provided file of URLs. You visit each job page, extract details, score against the user's resume, present a ranked batch for approval, then apply to every approved job autonomously.

## Setup

Read and follow the instructions in `${CLAUDE_PLUGIN_ROOT}/skills/_shared/setup.md` to load the profile, resume, and credentials.

### Load Configuration

Read the `autopilot` section from `profile.json` for shared settings. Apply these defaults for any missing fields:

| Setting | Default | Description |
|---------|---------|-------------|
| `minMatchScore` | 6 | Minimum score (1-10) to include in batch |
| `maxApplicationsPerRun` | 10 | Max jobs to apply to |
| `confirmMode` | "batch" | `"batch"` = review before applying. `"auto"` = skip confirmation when ALL jobs score >= `minMatchScore`. |
| `salaryExpectation` | "" | Auto-fill salary expectation fields |
| `defaultStartDate` | "2 weeks notice" | Default answer for start date fields |

## Phase 1: Parse Job URLs

1. Read the file at the path provided by the user.
2. Parse URLs from the file:
   - One URL per line
   - Skip blank lines and lines starting with `#` (comments)
   - Trim whitespace
3. If no valid URLs found, report an error and stop.
4. Report: **"Found X job URLs. Visiting each to gather details..."**

### Create Run File

Create a run file at `${CLAUDE_PLUGIN_ROOT}/runs/<run-id>.json` where `<run-id>` is `YYYY-MM-DDTHH-MM-SS_batch-apply`.

Initialize with:

```json
{
  "runId": "<run-id>",
  "query": "batch-apply from <filename>",
  "config": {
    "minMatchScore": <resolved value>,
    "maxApplications": <resolved value>,
    "source": "apply-batch"
  },
  "status": "in_progress",
  "startedAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "completedAt": null,
  "jobs": [],
  "summary": {
    "totalFound": 0,
    "qualified": 0,
    "applied": 0,
    "failed": 0,
    "skipped": 0,
    "remaining": 0
  }
}
```

## Phase 2: Visit and Score Each Job

For each URL:

### Step 2.1: Check if Already Applied

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/check-applied.sh "<job-url>"
```

If `already-applied`, add to the run file as `status: "skipped"` with `skipReason: "Already applied (found in applied-jobs database)"`. Move to the next URL.

### Step 2.2: Visit the Job Page

1. Use `browser_navigate` to open the URL.
2. Use `browser_snapshot` with a targeted `ref` to read the job listing content.
3. Extract:
   - Job title
   - Company name
   - Location / remote status
   - Salary range (if visible)
   - Key requirements (brief)
4. If the page requires login to view details, follow `${CLAUDE_PLUGIN_ROOT}/skills/_shared/auth.md` to authenticate first, then re-read.

### Step 2.3: Score Against Resume

Assign a **match score (1-10)** based on:

- Tech stack overlap with resume
- Years of experience match
- Education match
- Domain/industry relevance
- Seniority level alignment
- Location/remote preference match

Add the job to the run file with `status: "pending"`, the score, and `matchReason`.

**Filter out** jobs below `minMatchScore` -> set `status: "skipped"`, `skipReason: "Below minimum match score (X < Y)"`.

## Phase 3: Batch Confirmation

### Auto Mode (`confirmMode: "auto"`)

If `confirmMode` is `"auto"` AND **every** qualified job has a match score >= `minMatchScore`:

1. Log the qualified jobs table for the user's reference.
2. Mark all qualified jobs as `status: "approved"` automatically.
3. Proceed directly to Phase 4 without waiting for user input.

### Batch Mode (`confirmMode: "batch"`, or auto mode fallback)

Present all qualified jobs in a ranked table:

```
## Batch Apply: <filename>

Visited <total> jobs. <qualified> qualify (score >= <minMatchScore>/10).

| # | Score | Title | Company | Location | Source |
|---|-------|-------|---------|----------|--------|
| 1 | 9/10  | Senior Full Stack Dev | Acme Corp | Remote | Greenhouse |
| 2 | 8/10  | Full Stack Engineer | StartupCo | Portland, ME | Lever |

Applying to up to <maxApplications> jobs.

**Commands:**
- "go" -- apply to all qualified jobs
- "go 1,3,5" -- apply only to specific jobs
- "remove 3" -- exclude specific jobs
- "details 2" -- show full job description and URL before deciding
- "stop" -- cancel the run
```

Process the user's response:
- **"go"** -> mark all qualified jobs as `status: "approved"`
- **"go 1,3,5"** -> mark only those as `approved`, rest as `skipped` with `skipReason: "Not selected by user"`
- **"remove N"** -> mark as `skipped` with `skipReason: "Removed by user"`, re-present table
- **"details N"** -> show the full extracted details and URL, then re-present table
- **"stop"** -> set run `status: "paused"`, save, and stop

## Phase 4: Autonomous Apply Loop

For each job with `status: "approved"`, in order of match score (highest first):

### Step 4.1: Begin Application

1. Update the job's status to `"applying"` via the update script.
2. Use `browser_navigate` to open the job URL.
3. Use `browser_snapshot` to assess the page.

### Step 4.2: Find and Click Apply

1. Determine the page type:
   - **Job listing page** -> find and click "Apply", "Apply Now", "Quick Apply", or similar
   - **Login page** -> go to Step 4.3
   - **Application form** -> go to Step 4.4
   - **Other** -> analyze and navigate toward the application

2. After clicking Apply, use `browser_wait_for` for page load, then `browser_snapshot` to reassess.

### Step 4.3: Authentication (if needed)

Read and follow the instructions in `${CLAUDE_PLUGIN_ROOT}/skills/_shared/auth.md`.

### Step 4.4: Fill Application Forms

Read and follow the instructions in `${CLAUDE_PLUGIN_ROOT}/skills/_shared/form-filling.md`.

**Batch-specific overrides:**
- **Salary expectations** -> use `autopilot.salaryExpectation` from config if set. Otherwise ask on first encounter and remember for the rest.
- **Start date** -> use `autopilot.defaultStartDate` from config.
- **Custom questions** -> make a reasonable attempt from resume. Do not pause the run.

### Step 4.5: Submit

**Submit without per-job confirmation.** The user already approved the batch in Phase 3.

1. Click "Submit", "Submit Application", or equivalent.
2. Use `browser_wait_for` to confirm submission.
3. Take a targeted snapshot to verify success.

### Step 4.6: Record Result

**On success:**
- Update job status to `"applied"` and set `appliedAt`.
- Log to the persistent database:
  ```bash
  bash ${CLAUDE_PLUGIN_ROOT}/scripts/log-applied.sh "<job-url>" "<title>" "<company>" "apply-batch" "<run-id>"
  ```

**On failure:**
- Set `failReason` with a clear description.
- Set `retryNotes` with actionable context for future retry.
- **Continue to the next job.**

### Step 4.7: Check Limits

If `summary.applied >= config.maxApplications`, mark remaining `approved` jobs as `skipped` with `skipReason: "Max applications limit reached"`. End the loop.

### Step 4.8: Update Progress File

Use the update script for all status changes:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/update-run.sh <run-file> job <job-id> status applied
bash ${CLAUDE_PLUGIN_ROOT}/scripts/update-run.sh <run-file> summary
```

**Do NOT read the full progress file to update it.**

## Phase 5: Summary Report

1. Set run `status: "completed"` and `completedAt`.
2. Present:

```
## Batch Apply Complete: <filename>

| Metric | Count |
|--------|-------|
| Jobs in file | <total> |
| Qualified | <qualified> |
| Applied | <applied> |
| Failed | <failed> |
| Skipped | <skipped> |

### Successfully Applied
- #1 Senior Full Stack Dev at Acme Corp (9/10)

### Failed (can retry)
- #2 Backend Dev at BigCo -- CAPTCHA required

### Skipped
- #3 Junior Dev at SmallCo -- Below minimum match score (4 < 6)

Progress saved to: runs/<run-id>.json
```

## Important Rules

1. **Batch confirmation is mandatory.** The user must approve before any applications are submitted.
2. **After approval, do NOT ask per-job confirmation.** Apply autonomously.
3. **Never create accounts** on any job board.
4. **Never process payments.** Mark as `failed` with `failReason: "Payment required"`.
5. **Handle CAPTCHAs and email verification** by pausing and asking the user (see `auth.md`).
6. **Be honest about match scores.** Don't inflate.
7. **Pace applications.** Wait 3-5 seconds between submissions on the same domain.
8. **Progress file is the audit trail.** Update after every state change.

Read and follow `${CLAUDE_PLUGIN_ROOT}/skills/_shared/browser-tips.md` for handling large pages, popups, and general browser best practices.
