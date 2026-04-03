# Overleaf Git Bridge Setup

This guide walks you through connecting JobPilot to your Overleaf project so resumes can be tailored, compiled, and downloaded automatically per job application.

## Prerequisites

- An **Overleaf Premium** account (Git Bridge is a Premium feature)
- Your two LaTeX resume files (`productds.tex` and `DS_ML.tex`) already uploaded to an Overleaf project
- Git installed locally

---

## Step 1: Find Your Overleaf Project ID

1. Open your resume project in Overleaf
2. Look at the URL in your browser — it will look like:
   ```
   https://www.overleaf.com/project/64a3f2c1b8e9d70012abc123
   ```
3. The long alphanumeric string at the end is your **project ID**
4. Copy it — you will need it in Step 4

---

## Step 2: Enable Git Bridge in Overleaf

1. With your project open, click the **Menu** button (top-left hamburger icon)
2. Scroll down to find **Git** under the "Sync" section
3. If you see a "Git" option, click it — Overleaf will show you the clone URL:
   ```
   https://git.overleaf.com/YOUR_PROJECT_ID
   ```
4. If you do not see Git in the menu, your account may not have Premium. Upgrade at `overleaf.com/user/subscription`

Alternatively, enable via Account Settings:
1. Go to `overleaf.com/user/settings`
2. Navigate to the **Integrations** or **Git** tab
3. Confirm Git Bridge is active for your account

---

## Step 3: Get Your Overleaf Token

Overleaf supports token-based authentication for Git. To generate a token:

1. Go to `overleaf.com/user/settings`
2. Scroll to the **Password** section — for Git authentication you use your **Overleaf account password** directly, OR
3. If your institution uses SSO (single sign-on), generate a Git token:
   - Go to `overleaf.com/user/settings` → **Password** → **Set a password for Git access**
   - Copy the generated token — it will not be shown again

Your Git credentials for Overleaf are:
- **Username**: your Overleaf account email address
- **Password**: your Overleaf password or the generated Git token

---

## Step 4: Fill In profile.json

Open (or create) `profile.json` in the repo root and add the `overleaf` section. This file is gitignored — your credentials will never be committed.

```json
"overleaf": {
  "enabled": true,
  "projectId": "64a3f2c1b8e9d70012abc123",
  "gitUrl": "https://git.overleaf.com/64a3f2c1b8e9d70012abc123",
  "localClonePath": "./overleaf-resume",
  "texFiles": {
    "product-ds": "productds.tex",
    "ml-ds": "DS_ML.tex",
    "general-ds": "productds.tex"
  },
  "tailoredOutputDir": "./resumes/tailored",
  "gitUsername": "you@example.com",
  "gitPassword": "your-overleaf-password-or-token",
  "tailorResume": true
}
```

Replace:
- `64a3f2c1b8e9d70012abc123` with your actual project ID from Step 1
- `you@example.com` with your Overleaf account email
- `your-overleaf-password-or-token` with the credential from Step 3

Set `"enabled": false` if you want to disable Overleaf integration temporarily without removing the config.

---

## Step 5: Run the One-Time Clone

From the repo root, run:

```bash
bash scripts/overleaf-clone.sh
```

This clones your Overleaf project into the `./overleaf-resume/` directory. This directory is gitignored — it will not be committed to the JobPilot repo.

You will be prompted for your Git credentials unless you have them cached. To cache credentials for the session:

```bash
git config --global credential.helper cache
```

Or store them permanently (less secure):

```bash
git config --global credential.helper store
```

---

## Step 6: Verify the Setup

After cloning, verify everything is working:

1. **Check that both .tex files are present:**
   ```bash
   ls overleaf-resume/
   ```
   You should see `productds.tex` and `DS_ML.tex` (and any other files in your Overleaf project).

2. **Test a pull:**
   ```bash
   bash scripts/overleaf-pull.sh
   ```
   This should complete without errors.

3. **Check the tailored output directory exists:**
   ```bash
   ls resumes/tailored/
   ```
   If the directory does not exist, create it: `mkdir -p resumes/tailored`

---

## Troubleshooting

### Authentication errors on clone or pull

```
fatal: Authentication failed for 'https://git.overleaf.com/...'
```

- Double-check your `gitUsername` (must be your full Overleaf email) and `gitPassword` in profile.json
- If using SSO, make sure you have set a Git-specific password in Overleaf account settings
- Try authenticating manually: `git clone https://git.overleaf.com/YOUR_PROJECT_ID overleaf-resume-test`

### Compilation errors / PDF not downloading

- Open your Overleaf project in the browser and check if the project compiles successfully there first
- Common causes: missing LaTeX packages, syntax errors introduced during tailoring
- If tailoring introduces a compile error, JobPilot will fall back to the default (un-tailored) PDF and log a warning

### Missing .tex files after clone

- Confirm both `productds.tex` and `DS_ML.tex` exist in your Overleaf project
- File names are case-sensitive — make sure the names in `texFiles` in profile.json exactly match the filenames in Overleaf
- You can rename files inside Overleaf by right-clicking them in the file tree

### Git Bridge not available in Menu

- Git Bridge requires Overleaf Premium. Verify your subscription at `overleaf.com/user/subscription`
- If you recently upgraded, try refreshing the project page

### overleaf-resume/ directory already exists

If you need to re-clone (e.g., after deleting the directory):

```bash
rm -rf overleaf-resume/
bash scripts/overleaf-clone.sh
```

### Rate limiting between pushes

JobPilot enforces a 30-second wait between Overleaf pushes during batch operations to avoid overwhelming the Git Bridge. If you see timeout errors, increase this delay in `scripts/overleaf-push.sh`.

---

## File Layout After Setup

```
jobpilot/
├── overleaf-resume/         # gitignored — local Overleaf clone
│   ├── productds.tex
│   └── DS_ML.tex
├── resumes/
│   └── tailored/            # gitignored — generated PDFs
│       └── stripe-analytics-engineer-2026-04-03.pdf
├── profile.json             # gitignored — your credentials live here
└── scripts/
    ├── overleaf-clone.sh
    ├── overleaf-pull.sh
    ├── overleaf-push.sh
    └── overleaf-download-pdf.sh
```
