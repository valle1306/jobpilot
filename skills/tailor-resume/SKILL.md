---
name: tailor-resume
description: Tailor a LaTeX resume to a specific job using Overleaf Git Bridge. Classifies the role type, pulls the correct .tex template, rewrites bullet points to match job keywords, pushes back to Overleaf, and downloads the compiled PDF.
argument-hint: "<job_url_or_pasted_description>"
---

# Resume Tailor (Overleaf Git Bridge)

You rewrite a candidate's LaTeX resume to match a specific job posting, then compile and download it as a PDF via Overleaf.

## Setup

Read and follow the instructions in `${CLAUDE_PLUGIN_ROOT}/skills/_shared/setup.md` to load the profile, resume, and credentials.

## Execution Steps

### Step 0: Load Config and Validate Overleaf Setup

1. Read `profile.json` and locate the `overleaf` config block.
2. Check `overleaf.enabled`. If it is `false`, missing, or the `overleaf` block does not exist at all, print the following and **stop**:

```
Overleaf integration is not enabled.

To set it up, follow the instructions in:
  ${CLAUDE_PLUGIN_ROOT}/docs/overleaf-setup.md

Then set "overleaf.enabled": true in profile.json and re-run this command.
```

3. Check that the directory at `overleaf.localClonePath` exists. If it does not exist, print the following and **stop**:

```
Overleaf local clone not found at: <overleaf.localClonePath>

Run the following command to clone your Overleaf project locally:
  bash ${CLAUDE_PLUGIN_ROOT}/scripts/overleaf-clone.sh

On Windows PowerShell, use:
  .\scripts\run-bash.ps1 scripts\overleaf-clone.sh

Then re-run this command.
```

4. Check that `overleaf.tailoredOutputDir` exists as a directory. If it does not exist, create it now. Confirm creation with: `Created output directory: <tailoredOutputDir>`

### Step 1: Get Job Description

The argument may be a URL or pasted text.

**If the argument looks like a URL** (starts with `http://` or `https://`):
1. Use `browser_navigate` to open the URL.
2. Use `browser_snapshot` to read the page.
3. Extract:
   - `jobTitle` — the exact job title from the posting
   - `companyName` — the hiring company name
   - `jobDescription` — the full body text of the job description (requirements, responsibilities, qualifications)

**If the argument is pasted text:**
1. Parse out `jobTitle` and `companyName` from the content using best-effort heuristics (look for patterns like "Role:", "Position:", "Job Title:", or the first prominent heading).
2. Store the full pasted content as `jobDescription`.
3. If you cannot confidently determine `jobTitle` or `companyName`, ask the user to clarify before continuing.

Store all three values — `jobTitle`, `companyName`, `jobDescription` — in the session for use in subsequent steps.

### Step 2: Classify Role Type

Analyze `jobTitle` and the **first 500 characters** of `jobDescription`.

Apply the following classifier in order (first match wins):

- **`product-ds`** — if any of these terms appear (case-insensitive): "product", "analytics", "experimentation", "A/B", "growth", "funnel", "retention", "business intelligence", "insights", "data analyst", "product analyst"
- **`ml-ds`** — if any of these terms appear (case-insensitive): "machine learning", "ML engineer", "deep learning", "neural", "research scientist", "healthcare AI", "clinical", "PyTorch", "model training", "LLM", "NLP scientist"
- **`general-ds`** — all other data science / data engineering / analytics engineering roles

Look up the corresponding `.tex` filename from `overleaf.texFiles.<roleType>` in `profile.json`. For example:

```json
"overleaf": {
  "texFiles": {
    "product-ds": "resume-product.tex",
    "ml-ds": "resume-ml.tex",
    "general-ds": "resume-general.tex"
  }
}
```

Store `roleType` and `texFile` in the session.

Print: `Role classified as: <roleType> → using <texFile>`

### Step 3: Pull Latest from Overleaf

Run the pull script to sync the local clone with the latest Overleaf content:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/overleaf-pull.sh
```

If the script exits with a non-zero code, print the error output and **stop**. Do not proceed with a stale or missing file.

After a successful pull, read the full content of:

```
<overleaf.localClonePath>/<texFile>
```

Store the content in the session as `texContent`.

### Step 4: Keyword Extraction and Planning

Scan `jobDescription` for the following categories of terms:

- **Technical skills** — programming languages, tools, libraries, frameworks, platforms, databases (e.g., Python, Spark, dbt, Tableau, BigQuery, Redshift)
- **Methodologies** — analytical or engineering methods (e.g., A/B testing, causal inference, experimentation, time series, regression, statistical modeling)
- **Domain terms** — industry or business context (e.g., healthcare, clinical, product analytics, marketplace, supply chain)
- **Action keywords** — strong verbs that appear in the job posting (e.g., deployed, scaled, shipped, designed, optimized, partnered, automated)

Then scan `texContent` to identify which extracted keywords are already present in the resume.

Divide the keywords into three groups:
1. **Will add** — top 8–12 keywords that are (a) missing from the current resume AND (b) honest (the candidate genuinely has this background based on the resume content)
2. **Already present** — keywords found in the existing `.tex`
3. **Skipping** — keywords from the job posting that are NOT reflected in the candidate's existing experience and cannot be honestly claimed

Print the keyword plan in this format:

```
Keyword plan:
  Will add:          [comma-separated list]
  Already present:   [comma-separated list]
  Skipping (not in background): [comma-separated list]
```

If fewer than 3 honest keywords can be added, print:

```
Resume already well-matched. Proceeding with minor polish only.
```

and continue — do not abort.

### Step 5: Rewrite .tex

Edit `texContent` to weave in the selected keywords. Follow these rules **strictly and without exception**:

#### What you MAY change

1. The text content inside `\resumeItem{...}` bullets — rephrase to naturally include a keyword. Do not replace the entire bullet; integrate the keyword into the existing sentence.
2. The skills section subcategory lines (e.g., `Programming / ML & Analytics / Visualization / Data Systems & Tools`) — append accurate missing keywords to the correct subcategory.

#### What you MUST NOT change

1. `\resumeSubheading` — job titles, company names, dates, locations
2. `\resumeProjectHeading` — project names and links
3. Any URL or href value anywhere in the document
4. `\section{}` headings
5. LaTeX preamble, `\documentclass`, `\usepackage`, `\begin`, `\end`, or any command outside of bullet item content
6. `\vspace{-Xpt}` commands — preserve all of them exactly as-is
7. Any existing `\resumeItem` that is not being modified

#### Quantity limits

- Rewrite **at most 2 bullets per experience entry**
- Rewrite **at most 4 bullets total** across the entire document
- Do **NOT** add new `\resumeItem` bullets — only edit existing ones

#### Length constraint (one-page rule)

After rewriting a bullet, compare its character length to the original. If the rewritten version is meaningfully longer, trim other words within the same bullet to stay length-neutral. The goal is to preserve the one-page layout.

After editing, print a before/after diff for every changed bullet in this format:

```
Changed bullet 1 (at <JobTitle>, <Company>):
  Before: Developed pipeline for ingesting raw clickstream data.
  After:  Developed Spark pipeline for ingesting and transforming raw clickstream data using dbt.

Changed bullet 2 (at <JobTitle>, <Company>):
  Before: Built dashboards for stakeholder reporting.
  After:  Built Tableau dashboards to surface A/B testing results for stakeholder reporting.
```

Store the modified content as `modifiedTexContent`.

### Step 6: Write and Push to Overleaf

1. Write `modifiedTexContent` back to `<overleaf.localClonePath>/<texFile>`, overwriting the existing file.

2. Also write the same `modifiedTexContent` to `<overleaf.localClonePath>/main.tex`.
   This ensures Overleaf compiles the selected template even when the project uses `main.tex` as the build entrypoint.

3. Generate a **company slug**: lowercase `companyName`, replace spaces and special characters with hyphens, strip all non-alphanumeric characters except hyphens. Example: "Stripe (US)" → `stripe-us`.

4. Generate a **job title slug**: same rules applied to `jobTitle`. Example: "Analytics Engineer II" → `analytics-engineer-ii`.

5. Generate a **tag**: `<roleType>/<companySlug>-<YYYY-MM-DD>` using today's date.

6. Set **commit message**: `Tailored for <jobTitle> at <companyName>`

7. Run the push script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/overleaf-push.sh "<commitMsg>" "<tag>"
```

If the push script exits with a non-zero code:
- Print the full error output.
- Do **not** set `tailoredResumePath`.
- Print: `Push failed. Check that your Overleaf Git credentials are correct in profile.json (overleaf.gitToken).`
- **Stop.**

If the push succeeds, print:

```
Pushed to Overleaf. Tag: <tag>. Waiting 20 seconds for compilation...
```

Then wait 20 seconds before proceeding to Step 7.

### Step 7: Download Compiled PDF via Playwright

Construct the output filename: `<companySlug>-<jobTitleSlug>-<YYYY-MM-DD>.pdf`

Run the download script:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/overleaf-download-pdf.sh "<tailoredOutputDir>/<companySlug>-<jobTitleSlug>-<YYYY-MM-DD>.pdf"
```

Read the `OVERLEAF_DOWNLOAD_INSTRUCTIONS` block from the script's stdout. This block contains step-by-step Playwright instructions along with the Overleaf project URL and login credentials needed. Execute each step in the instructions block exactly as described:

1. Use `browser_navigate` to go to the Overleaf project URL.
2. If a login page is shown:
   - If `hasLoginPassword` is `true`, log in using the credentials provided in the instructions block.
   - If `hasLoginPassword` is `false`, stop and ask the user to either sign in manually in the browser session or add `overleaf.webPassword` to `profile.json`.
3. Wait for the green compile-success indicator in the Overleaf editor.
4. **If the editor shows a compile error (`COMPILE_ERROR`):**
   - Print the compile error message in full.
   - Set `tailoredResumePath = ""`.
   - Print: `Compile failed. Please fix the .tex file manually at: <overleaf.localClonePath>/<texFile>`
   - **Stop.** Do not fall back to downloading a stale PDF.
5. Download the compiled PDF to the output path specified in the script argument.

After download, verify the file exists at the output path. If the file is missing (download failed):
- Print: `PDF download failed. Falling back to default resume for this role type.`
- Set `tailoredResumePath` to the value of `personal.resumes.<roleType>` if it exists, otherwise `personal.resumes.default`.
- Continue to Step 8 with the fallback path.

### Step 8: Report

Set the session variable:

```
tailoredResumePath = <full absolute output path>
```

Print the following summary:

```
Resume tailored successfully.

  Role type:      <roleType>
  Template:       <texFile>
  Keywords added: <comma-separated list of added keywords>
  Git tag:        <tag>
  PDF saved:      <tailoredResumePath>

Next step: /apply <jobUrl>
The tailored PDF will be used automatically for the upload step.
```

## Important Rules

1. **Never fabricate experience.** Only add keywords that are honestly reflected in the candidate's existing resume content. If a keyword cannot be integrated truthfully, skip it.
2. **Never touch structural LaTeX.** Only the text inside `\resumeItem{}` braces and skills subcategory lines are in scope. Everything else is off-limits.
3. **Respect the one-page constraint.** When lengthening a bullet, trim elsewhere in the same bullet to stay length-neutral.
4. **Do not submit or auto-apply.** This skill only tailors and downloads the resume. The `/apply` skill handles submission.
5. **Stop on push failure.** Do not leave the local `.tex` in a modified state without confirming the push succeeded. If push fails, the file has already been written locally — tell the user where it is so they can inspect or revert manually.

Read and follow `${CLAUDE_PLUGIN_ROOT}/skills/_shared/browser-tips.md` for handling Overleaf login, popups, and PDF download interactions.


