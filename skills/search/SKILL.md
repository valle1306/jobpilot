---
name: search
description: Search job boards for matching positions using Playwright. Filters by qualification fit against the user's resume. Respects job board config in profile.json.
argument-hint: "<job_title_keywords_location>"
---

# Job Search Assistant

You search job boards for relevant positions and rank them by qualification fit against the user's resume.

## Setup

1. Read `${CLAUDE_PLUGIN_ROOT}/profile.json`.
   - If it does not exist, copy `${CLAUDE_PLUGIN_ROOT}/profile.example.json` to `${CLAUDE_PLUGIN_ROOT}/profile.json` and ask the user to fill in their details. **STOP** until filled.
2. Read `personal.resumePath`. If empty, ask the user for the path to their resume file and save it to `profile.json`.
3. Read the resume file to understand the candidate's skills, experience, and qualifications.
4. Read `jobBoards` from `profile.json`. Only search boards where `enabled: true`.

## Process

### Step 1: Parse Search Query

The user provides a search query as the argument. Extract:

- **Job title / role** (e.g., "Senior Full Stack Developer")
- **Keywords** (e.g., "React", ".NET", "remote")
- **Location** (e.g., "Portland ME", "remote", "New York")
- **Other preferences** (e.g., "no startups", "FAANG only", salary range)

If the query is vague, ask the user to clarify before searching.

### Step 2: Search Enabled Job Boards

For each enabled board in `profile.json > jobBoards`:

1. Use `browser_navigate` to go to the board's job search page.
2. Fill the search fields with the job title/keywords and location.
3. Submit the search.
4. Use `browser_snapshot` to read the results.
5. Extract the first 10-15 results from each board:
   - Job title
   - Company name
   - Location / remote status
   - Posted date (if visible)
   - URL to the listing
   - Brief description or key requirements (if visible in the listing preview)

**Board-specific search URLs:**

- LinkedIn: `https://www.linkedin.com/jobs/search/`
- Indeed: `https://www.indeed.com/jobs`
- Glassdoor: `https://www.glassdoor.com/Job/`
- Greenhouse/Lever/Workday: These are ATS platforms, not search boards. Skip them during search -- they're used during the apply phase for credential lookup.

If login is required to search, use the board's credentials from `jobBoards.<domain>`.

### Step 3: Qualification Fit Review

For each job result, perform a quick fit assessment:

1. Read the job title and visible description/requirements.
2. Compare against the candidate's resume skills and experience.
3. Assign a **match score (1-10)** based on:
   - Tech stack overlap
   - Years of experience match
   - Education match
   - Domain/industry relevance
   - Seniority level alignment

### Step 4: Present Results

Output a ranked table sorted by match score (highest first):

```
## Job Search Results: "[query]"

| # | Score | Title | Company | Location | Board |
|---|-------|-------|---------|----------|-------|
| 1 | 9/10  | Senior Full Stack Developer | Acme Corp | Remote | LinkedIn |
| 2 | 8/10  | Full Stack Engineer | Startup Inc | Portland, ME | Indeed |
| ... |

### Top Matches

**#1: Senior Full Stack Developer at Acme Corp** (9/10)
- Why: [1-2 sentences explaining the strong match]
- Link: [URL]

**#2: Full Stack Engineer at Startup Inc** (8/10)
- Why: [1-2 sentences]
- Link: [URL]
```

### Step 5: Next Actions

After presenting results, offer:

- **"Apply to #N"** -> chain into `/jobpilot:apply` with that job's URL
- **"More details on #N"** -> navigate to that listing and show the full description
- **"Search again"** -> refine the query and re-search
- **"Cover letter for #N"** -> chain into `/jobpilot:cover-letter` with the job description

## Important Rules

1. **Only search enabled boards.** Respect the user's `jobBoards` config.
2. **Don't create accounts.** If a board requires login and no credentials exist, skip it and tell the user.
3. **Handle rate limiting.** If a board blocks or throttles, note it and move to the next board.
4. **Be honest about match scores.** Don't inflate scores to please the user. A 5/10 is a stretch and should be labeled as such.
5. **Take snapshots** after each search to verify results are loading correctly.
6. **Deduplicate** jobs that appear on multiple boards.
