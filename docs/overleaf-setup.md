# Overleaf Git Bridge Setup

This guide walks you through connecting JobPilot to your Overleaf project so resumes can be tailored, compiled, and downloaded automatically per job application.

## Prerequisites

- An **Overleaf Premium** account (Git Bridge is a Premium feature)
- Your two LaTeX resume files (`productds.tex` and `DS_ML.tex`) already uploaded to an Overleaf project
- Git installed locally
- On Windows: Git for Windows is recommended so you have Git Bash available

## Step 1: Find Your Overleaf Project ID

1. Open your resume project in Overleaf.
2. Look at the URL in your browser. It will look like:
   ```
   https://www.overleaf.com/project/64a3f2c1b8e9d70012abc123
   ```
3. The long alphanumeric string at the end is your **project ID**.
4. Copy it. You will need it in Step 4.

## Step 2: Enable Git Bridge in Overleaf

1. With your project open, click the **Menu** button.
2. Scroll down to find **Git** under the "Sync" section.
3. If you see a "Git" option, click it. Overleaf will show you the clone URL:
   ```
   https://git.overleaf.com/YOUR_PROJECT_ID
   ```
4. If you do not see Git in the menu, your account may not have Premium. Upgrade at `overleaf.com/user/subscription`.

Alternatively:

1. Go to `overleaf.com/user/settings`.
2. Open the **Integrations** or **Git** tab.
3. Confirm Git Bridge is active for your account.

## Step 3: Generate an Overleaf Git Token

Overleaf Git Bridge now requires a **Git authentication token**. A regular Overleaf password may still work for website login, but it is not enough for Git clone, pull, or push.

1. Go to `overleaf.com/user/settings`.
2. Open the **Password** section.
3. Generate or set a password/token for Git access.
4. Copy it immediately. Overleaf may not show it again.

Use these credentials for Git Bridge:

- **Username**: `git`
- **Git token**: the Git token/password generated for Git access

If JobPilot needs to sign into the Overleaf website to download a compiled PDF, add your normal Overleaf account email as `overleaf.email` and optionally your normal website password as `overleaf.webPassword`.

## Step 4: Fill In `profile.json`

Open (or create) `profile.json` in the repo root and add the `overleaf` section. This file is gitignored, so your credentials stay local.

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
  "email": "you@example.com",
  "gitToken": "your-overleaf-git-token",
  "webPassword": "",
  "tailorResume": true
}
```

Replace:

- `64a3f2c1b8e9d70012abc123` with your actual project ID from Step 1
- `you@example.com` with your Overleaf account email
- `your-overleaf-git-token` with the token from Step 3
- `webPassword` with your normal Overleaf website password only if you want browser login automated

Set `"enabled": false` if you want to disable Overleaf integration temporarily without removing the config.

## Step 5: Run the Local Setup Check

From the repo root, run:

```powershell
.\scripts\check-setup.ps1
```

This verifies:

- `profile.json` is present and gitignored
- your default resume path exists
- Overleaf fields look complete
- Git, bash, and jq are available (or at least detectable)

## Step 6: Run the One-Time Clone

From the repo root:

On macOS/Linux:

```bash
bash scripts/overleaf-clone.sh
```

On Windows PowerShell:

```powershell
.\scripts\overleaf-clone.ps1
```

This clones your Overleaf project into `./overleaf-resume/`. That directory is gitignored and stays local.

If you want the full Windows setup in one command, use:

```powershell
.\scripts\overleaf-bootstrap.ps1
```

That script will:

- clone the Overleaf project if needed
- copy your local resume templates into the clone using `personal.resumes` and `overleaf.texFiles`
- copy `personal.resumes.default` into `main.tex`
- commit and push the synced files back to Overleaf


JobPilot expects the role-mapped template files in overleaf.texFiles to exist in this project. During tailoring, it copies the selected template content into main.tex before pushing so Overleaf compiles the right version.

## Step 7: Verify the Setup

After cloning:

1. Check that both `.tex` files are present in `overleaf-resume/`.
2. Test a pull.

On macOS/Linux:

```bash
bash scripts/overleaf-pull.sh
```

On Windows PowerShell:

```powershell
.\scripts\overleaf-pull.ps1
```

3. Check that `resumes/tailored/` exists.

## Troubleshooting

### Clone or pull returns 403 / token errors

Example:

```text
remote: Overleaf now only supports Git authentication tokens to access git.
fatal: unable to access 'https://git.overleaf.com/...': The requested URL returned error: 403
```

- Overleaf Git token auth uses the username `git`, not your email.
- Make sure `overleaf.gitToken` is an Overleaf Git token, not your regular website password.
- If your config still uses `overleaf.gitPassword`, migrate that value to `overleaf.gitToken`.

### PDF download reaches the login page

- Add `overleaf.webPassword` if you want website login automated.
- If you use SSO or do not want to store a website password, sign in manually when prompted.

### Missing `.tex` files after clone

- Confirm both `productds.tex` and `DS_ML.tex` exist in your Overleaf project.
- If your project currently only has main.tex, either upload the role-specific .tex files or temporarily point all overleaf.texFiles.* entries to main.tex.

### `bash` is not recognized in PowerShell

Use:

```powershell
.\scripts\run-bash.ps1 scripts\overleaf-clone.sh
```

### `jq` was installed but still is not found

Open a new terminal and run the command again. JobPilot's scripts also check the WinGet install path automatically now.

## File Layout After Setup

```text
jobpilot/
  overleaf-resume/         # gitignored - local Overleaf clone
    productds.tex
    DS_ML.tex
  resumes/
    tailored/              # gitignored - generated PDFs
      stripe-analytics-engineer-2026-04-03.pdf
  profile.json             # gitignored - your credentials live here
  scripts/
    overleaf-clone.sh
    overleaf-pull.sh
    overleaf-push.sh
    overleaf-download-pdf.sh
```

