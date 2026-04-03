# JobPilot — Claude Instructions

## Project Overview
JobPilot is a Claude Code plugin that automates the full job application pipeline:
search → score → tailor resume → apply. It uses Playwright for browser automation,
bash scripts for data ops, and prompt-based skills (markdown instruction files) for AI logic.

## Resume Templates
Two LaTeX resume templates live in the repo root:

| File | Target Role Type | When to Use |
|------|-----------------|-------------|
| productds.tex | Product Data Science | Roles involving A/B testing, experimentation, analytics, growth, funnel, retention, dashboards |
| DS_ML.tex | ML / Healthcare AI | Roles involving ML engineering, deep learning, clinical AI, research scientist, modeling |

**Role Classification:**
- "product-ds" → productds.tex: keywords like product, analytics, experimentation, A/B, growth, funnel, retention, business intelligence, insights
- "ml-ds" → DS_ML.tex: keywords like machine learning, ML, deep learning, neural network, research scientist, healthcare AI, clinical modeling, PyTorch, uncertainty quantification
- "general-ds" → productds.tex (default): all other data science roles

## Overleaf Git Bridge Integration
The system uses Overleaf Premium's Git Bridge to pull/edit/push LaTeX resumes and download compiled PDFs.

### Setup (one-time)
1. Get your Overleaf project ID from the URL: `overleaf.com/project/YOUR_PROJECT_ID`
2. Add to profile.json (gitignored — never commit credentials):
   ```json
   "overleaf": {
     "enabled": true,
     "projectId": "YOUR_PROJECT_ID",
     "gitUrl": "https://git.overleaf.com/YOUR_PROJECT_ID",
     "localClonePath": "./overleaf-resume",
     "texFiles": {
       "product-ds": "productds.tex",
       "ml-ds": "DS_ML.tex",
       "general-ds": "productds.tex"
     },
     "tailoredOutputDir": "./resumes/tailored",
     "email": "your@email.com",
     "gitToken": "YOUR_OVERLEAF_GIT_TOKEN",
     "webPassword": "",
     "tailorResume": true
   }
   ```
3. Run: `bash scripts/overleaf-clone.sh` to clone the Overleaf project locally
   - Overleaf Git token auth uses username `git`
   - On Windows PowerShell: `.\scripts\overleaf-clone.ps1`

### How It Works Per Job
1. Classify job type → select .tex template
2. `scripts/overleaf-pull.sh` — pull latest from Overleaf
3. Claude edits .tex: weaves in keywords, preserves structure, enforces one-page
4. `scripts/overleaf-push.sh` — push + auto git tag the version
5. `scripts/overleaf-download-pdf.sh` — Playwright downloads compiled PDF
6. PDF saved to `resumes/tailored/<company>-<role>-<date>.pdf`
7. `tailoredResumePath` is set for the apply step

### Git Tagging Convention
Every tailored resume is tagged: `<role-type>/<company-slug>-<role-slug>-<YYYY-MM-DD>`
Examples:
- `product-ds/stripe-analytics-engineer-2026-04-03`
- `ml-ds/google-research-scientist-2026-04-03`

## Skills Reference

| Command | File | Purpose |
|---------|------|---------|
| `/autopilot <query>` | skills/autopilot/SKILL.md | Search → rank → tailor → apply loop |
| `/apply <url>` | skills/apply/SKILL.md | Single job apply with optional tailor |
| `/apply-batch <file>` | skills/apply-batch/SKILL.md | Batch apply from URL list |
| `/tailor-resume <url_or_desc>` | skills/tailor-resume/SKILL.md | Tailor resume for one job |
| `/search <query>` | skills/search/SKILL.md | Search and score jobs |
| `/cover-letter <desc>` | skills/cover-letter/SKILL.md | Generate cover letter |
| `/interview <desc>` | skills/interview/SKILL.md | Interview prep Q&A |
| `/dashboard` | skills/dashboard/SKILL.md | Application stats |

## Key Files

| File | Purpose |
|------|---------|
| `profile.json` | User config (gitignored — never commit) |
| `profile.example.json` | Template — copy to profile.json and fill in |
| `productds.tex` | Product DS resume template |
| `DS_ML.tex` | ML/Healthcare AI resume template |
| `applied-jobs.json` | Deduplication database (gitignored) |
| `runs/*.json` | Autopilot progress (gitignored) |
| `resumes/tailored/` | Generated tailored PDFs (gitignored) |
| `overleaf-resume/` | Local Overleaf git clone (gitignored) |
| `skills/_shared/setup.md` | Profile loading, resume selection, role classifier |
| `skills/_shared/form-filling.md` | Form field mapping and upload priority |
| `skills/_shared/auth.md` | Login, 2FA, CAPTCHA handling |

## Resume Editing Rules (CRITICAL)
When tailoring a .tex resume, Claude MUST follow these rules:

1. **Never touch structure**: Do not modify `\resumeSubheading`, `\resumeProjectHeading`, dates, company names, job titles, or `\section{}` headings
2. **Only edit `\resumeItem{}` contents**: Rewrite bullet point text only
3. **Max 2 bullets rewritten per experience entry**: Preserve the skeleton
4. **One-page constraint**: After editing, verify the document will fit one page. If too long, shorten edited bullets. Never delete sections — trim words.
5. **No fabrication**: Only add keywords the candidate actually has experience with. If a keyword is completely absent from their background, skip it.
6. **Skills section**: Add missing but accurate tech keywords to the correct subcategory (Programming / ML & Analytics / Visualization / Data Systems)
7. **Preserve all `\vspace` commands**: These are one-page tuning knobs — do not remove them

## Commit Conventions
Commit each logical change separately:
- `feat: <description>` — new feature or file
- `fix: <description>` — bug fix
- `docs: <description>` — documentation only
- `chore: <description>` — config, cleanup

Always push after each commit: `git push origin main`

## Security Rules
- NEVER commit `profile.json` — it contains credentials
- NEVER commit `applied-jobs.json` or `runs/` — personal data
- NEVER commit `resumes/tailored/` or `overleaf-resume/` — personal data
- The Overleaf Git token goes ONLY in profile.json

## Autopilot Behavior
- Jobs are ranked by match score (1–10), highest first
- Tailor-resume runs inline per job during Phase 3, in rank order
- Rate limit: wait 30s between Overleaf pushes
- If Overleaf compilation fails: fall back to default PDF, log warning, continue

## Profile Structure (Key Fields)
```json
{
  "personal": { "resumes": { "default": "...", "product-ds": "...", "ml-ds": "...", "general-ds": "..." } },
  "overleaf": { "enabled": true, "projectId": "...", ... },
  "autopilot": { "minMatchScore": 6, "confirmMode": "batch", ... }
}
```
