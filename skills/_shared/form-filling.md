# Form Filling

Job applications often span multiple pages/steps. For each page:

## Identify and Fill Fields

1. **Take a snapshot** of the current form state.
2. **Identify all form fields** -- text inputs, textareas, selects, checkboxes, radio buttons, file uploads.
3. **Map each field** to the candidate's profile and resume data using field labels, placeholders, and names.
4. **Fill fields** using Playwright MCP tools:
   - Text inputs -> `browser_fill_form` or `browser_click` + `browser_type`
   - Dropdowns/selects -> `browser_select_option`
   - Checkboxes/radio buttons -> `browser_click`
   - File uploads (resume) -> `browser_file_upload` using the Resume Upload Priority below
   - Date fields -> use the appropriate date format for the field

### Resume Upload Priority

When a form field requires a resume file upload, select the file in this order:

1. **`tailoredResumePath`** (session variable) — if set and file exists, ALWAYS use this. This is a PDF tailored specifically for this job.
2. **Role-matched variant** — match job title/description against `personal.resumes` keys (product-ds, ml-ds, general-ds)
3. **`personal.resumes.default`** — fallback

Note: tailored resumes are PDFs in `resumes/tailored/`. They are pre-compiled and ready to upload directly.

## Special Fields

- **Address fields** -> use `profile.json > address.*`
- **Phone number** -> use `profile.json > personal.phone`
- **LinkedIn/GitHub/Website** -> use `profile.json > personal.linkedin`, `personal.github`, `personal.website`
- **Salary expectations** -> If `autopilot.salaryExpectation` is set in `profile.json`, use that value. For radio buttons or dropdowns, select the option that best matches the configured value. If `salaryExpectation` is not set, ask the user (in autopilot mode: ask once on first encounter, remember for the rest of the run).
- **Start date** -> "Immediately" or "2 weeks notice" unless configured otherwise in `autopilot.defaultStartDate`.
- **Cover letter** -> Generate a tailored cover letter using `/jobpilot:cover-letter` with the job description. The cover-letter skill already runs through the humanizer. Then determine the field type:
  - **Text area** -> paste the cover letter text directly into the field.
  - **File upload only** -> save the generated cover letter to `${CLAUDE_PLUGIN_ROOT}/cover-letter.txt` using the `Write` tool, then use `browser_file_upload` to upload that file. Reuse the same file path for each application (it gets overwritten each time).
- **"How did you hear about us?"** -> "Job board" or "Company website" as appropriate.
- **Years of experience** -> Calculate from the earliest work experience date in the resume.
- **Custom questions** -> Use best judgment from the candidate's resume. If genuinely uncertain, ask the user (in autopilot mode: make a reasonable attempt and log it in notes).
- **Relocation** -> Use `profile.json > workAuthorization.willingToRelocate` to answer "Are you willing to relocate?" questions. If the form asks for preferred or target locations, use `workAuthorization.preferredLocations`. If `preferredLocations` is an empty array `[]` or contains `"Anywhere"`, it means the user is open to any location — answer accordingly (e.g., "Yes", "Open to all locations", "Anywhere") without asking. If `willingToRelocate` is not set, ask the user (in autopilot mode: ask once on first encounter, remember for the rest of the run).
- **Work authorization / visa sponsorship** -> Use `profile.json > workAuthorization`. Answer "Are you authorized to work in the US?" with `usAuthorized`, "Will you require sponsorship?" with `requiresSponsorship`, visa status with `visaStatus`, and OPT details with `optExtension`. If the field is a dropdown, select the closest matching option.
- **EEO/Diversity questions** -> Use `profile.json > eeo` to fill these fields. Match `gender` for gender questions, `race` for race, `ethnicity` or `hispanicOrLatino` for ethnicity/Hispanic or Latino questions, `veteranStatus` for veteran status, and `disabilityStatus` for disability questions. If the field is a dropdown, select the closest matching option. If a specific field is missing from the `eeo` section, default to "Prefer not to disclose".

## Multi-Page Navigation

Many applications have multiple steps (e.g., "Personal Info" -> "Experience" -> "Education" -> "Review"):

1. After filling each page, look for "Next", "Continue", or "Save & Continue" buttons.
2. Click to proceed to the next step.
3. Repeat the form filling process for each new page.
4. **Take a snapshot** after filling each page to verify.
