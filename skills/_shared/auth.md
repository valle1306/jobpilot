# Authentication

## Proactive Login

**Always attempt to log in before interacting with a board** if credentials exist (the board's own `email`/`password`, or fall back to `credentials.default`). Many sites show content without login but limit functionality (no apply, fewer results, rate limiting).

1. Use `browser_snapshot` to assess the page state.
2. **Check if already logged in** (look for profile avatar, account menu, username, or "Sign out" link). If already logged in, skip authentication.
3. **Log in proactively:**
   - Look for "Sign in", "Log in", or "Sign up" buttons/links on the page and click to go to the login page.
   - Look up credentials using the credential lookup order (see setup.md).
   - If no credentials exist at all, proceed without login (some boards allow browsing without auth).
   - Fill the email/username and password fields, click sign-in/log-in.
   - Wait for navigation to complete, then take a snapshot to confirm login succeeded.
   - If login fails, proceed without auth and note the issue.
   - If 2FA/MFA is required, ask the user to complete it manually.
4. After login (or if skipping auth), navigate back to the intended page if needed.

## Registration Flow (if no account exists)

1. Look for a "Sign up" or "Create account" link and click it.
2. Fill registration fields using profile data (name, email, phone, etc.).
3. Use the credential's password for the password field.
4. Submit the form.
5. If email verification is needed, ask the user to verify and confirm.

## OAuth/SSO

If the site offers "Sign in with Google/LinkedIn" and the user prefers it, ask before proceeding with OAuth flow.
