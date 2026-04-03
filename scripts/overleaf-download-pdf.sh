#!/usr/bin/env bash
# Prints Playwright instructions for downloading the compiled PDF from Overleaf.
# Claude (the calling skill) reads this output and executes the steps via Playwright MCP.
# Usage: bash scripts/overleaf-download-pdf.sh "<outputPath>"
#
# Reads from profile.json:
#   overleaf.projectId   - Overleaf project ID (the hash in the project URL)
#   overleaf.email       - Overleaf account email (preferred for website login)
#   overleaf.webPassword - Overleaf website password (preferred for browser login)

set -euo pipefail

source "$(dirname "$0")/_ensure-jq.sh"

OUTPUT_PATH="${1:-}"

if [ -z "$OUTPUT_PATH" ]; then
  echo "Usage: bash scripts/overleaf-download-pdf.sh \"<outputPath>\"" >&2
  exit 1
fi

PROFILE="${CLAUDE_PLUGIN_ROOT:-.}/profile.json"

if [ ! -f "$PROFILE" ]; then
  echo "ERROR: profile.json not found at $PROFILE" >&2
  exit 1
fi

PROJECT_ID=$(jq -r '.overleaf.projectId // ""' "$PROFILE")
LOGIN_EMAIL=$(jq -r '.overleaf.email // .overleaf.gitUsername // .personal.email // ""' "$PROFILE")
LOGIN_PASSWORD=$(jq -r '.overleaf.webPassword // .overleaf.gitPassword // ""' "$PROFILE")
HAS_LOGIN_PASSWORD=$(jq -r 'if (.overleaf.webPassword // .overleaf.gitPassword // "") != "" then "true" else "false" end' "$PROFILE")

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: overleaf.projectId is not set in profile.json" >&2
  exit 1
fi
if [ -z "$LOGIN_EMAIL" ]; then
  echo "ERROR: overleaf.email is not set in profile.json" >&2
  exit 1
fi
PROJECT_URL="https://www.overleaf.com/project/${PROJECT_ID}"
PDF_URL="https://www.overleaf.com/project/${PROJECT_ID}/output/output.pdf"

cat <<EOF
OVERLEAF_DOWNLOAD_INSTRUCTIONS
projectUrl: ${PROJECT_URL}
username: ${LOGIN_EMAIL}
hasLoginPassword: ${HAS_LOGIN_PASSWORD}
loginPassword: ${LOGIN_PASSWORD}
outputPath: ${OUTPUT_PATH}
steps:
  1. Navigate to projectUrl
  2. If login page:
     - If hasLoginPassword is true: enter username and loginPassword, submit
     - Otherwise: sign in manually or use an existing Overleaf session
  3. Wait for project editor to load (look for "Recompile" button or compile status)
  4. Wait for green compile indicator (text: "Success" or green checkmark near Recompile button)
     - If red/error: capture the error message and print it, then exit with COMPILE_ERROR status
  5. Click the download button (look for download icon or "Download PDF" in the menu)
     OR navigate to: ${PDF_URL}
  6. Save downloaded file to: outputPath
END_OVERLEAF_DOWNLOAD_INSTRUCTIONS
EOF
