# Setup: Load Profile and Resume

1. Read `${CLAUDE_PLUGIN_ROOT}/profile.json`.
   - If it does not exist, copy `${CLAUDE_PLUGIN_ROOT}/profile.example.json` to `${CLAUDE_PLUGIN_ROOT}/profile.json` and ask the user to fill in their details. **STOP** until filled.
2. Read `personal.resumes`. If empty or missing, ask the user for the path to their resume file and save it as `personal.resumes.default` in `profile.json`.
3. Read the `default` resume file to extract candidate details (education, experience, skills, projects, technologies).

## Resume Selection

Resume selection priority (check in order):
1. `tailoredResumePath` session variable — if set, use this PDF for all upload steps, skip further selection
2. Match job title/description against `personal.resumes` keys (product-ds, ml-ds, general-ds, frontend, backend)
3. Fall back to `personal.resumes.default`

The `personal.resumes` object maps role types to resume file paths:

```json
"resumes": {
  "default": "/path/to/resume.pdf",
  "frontend": "/path/to/frontend-resume.pdf",
  "backend": "/path/to/backend-resume.pdf"
}
```

When applying to a job:

1. Analyze the job title and description to determine the best resume variant.
2. Match against the keys in `personal.resumes` (e.g., a "Frontend Developer" role should use the `"frontend"` resume).
3. If no key matches well, use `"default"`.
4. Use the selected resume for both reading candidate details and for file uploads.

## Credential Lookup

When credentials are needed for a domain:

1. Find the matching entry in the `jobBoards` array where `domain` matches or is contained in the URL.
2. If the board entry has `email` and `password` set, use those.
3. Otherwise, fall back to `credentials.default`.
4. If no credentials are found at all, report it -- do not guess.

## Overleaf Config

When a skill needs Overleaf settings, read from profile.json:
- `overleaf.enabled` — boolean, skip all Overleaf steps if false
- `overleaf.projectId` — Overleaf project ID
- `overleaf.localClonePath` — path to local git clone of Overleaf project
- `overleaf.texFiles` — map of role type to .tex filename
- `overleaf.tailoredOutputDir` — where to save tailored PDFs
- `overleaf.gitToken` — Overleaf Git Bridge token (the Git username is always `git`)
- `overleaf.email` — Overleaf account email for website login

Overleaf normally compiles main.tex. When tailoring a role-specific template, copy the selected .tex content into main.tex before pushing so the downloaded PDF matches the chosen variant.

## Role Classification

When a skill needs to determine the resume type for a job, use this classifier:

Given a job title and description, return one of: `product-ds`, `ml-ds`, or `general-ds`

- **product-ds**: title or description contains any of: product, analytics, experimentation, A/B test, growth, funnel, retention, business intelligence, insights, data analyst, product analyst, dashboard, KPI, metrics
- **ml-ds**: title or description contains any of: machine learning, ML engineer, deep learning, neural network, research scientist, healthcare AI, clinical, PyTorch, model training, LLM, NLP scientist, computer vision, reinforcement learning
- **general-ds**: all other data science, statistics, or quantitative roles

After classifying, look up `overleaf.texFiles.<roleType>` in profile.json for the .tex file to use.

