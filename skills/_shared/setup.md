# Setup: Load Profile and Resume

1. Read `${CLAUDE_PLUGIN_ROOT}/profile.json`.
   - If it does not exist, copy `${CLAUDE_PLUGIN_ROOT}/profile.example.json` to `${CLAUDE_PLUGIN_ROOT}/profile.json` and ask the user to fill in their details. **STOP** until filled.
2. Read `personal.resumes`. If empty or missing, ask the user for the path to their resume file and save it as `personal.resumes.default` in `profile.json`.
3. Read the `default` resume file to extract candidate details (education, experience, skills, projects, technologies).

## Resume Selection

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
