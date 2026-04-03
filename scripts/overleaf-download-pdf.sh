#!/usr/bin/env bash
# Prints Playwright instructions for downloading the compiled PDF from Overleaf.
# Claude (the calling skill) reads this output and executes the steps via Playwright MCP.
# Usage: bash scripts/overleaf-download-pdf.sh "<outputPath>"
#
# Reads from profile.json:
#   overleaf.projectId   - Overleaf project ID (the hash in the project URL)
#   overleaf.gitUsername - Overleaf account email (used to log in to overleaf.com)
#   overleaf.gitPassword - Overleaf password / token

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
GIT_USERNAME=$(jq -r '.overleaf.gitUsername // ""' "$PROFILE")
GIT_PASSWORD=$(jq -r '.overleaf.gitPassword // ""' "$PROFILE")

if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: overleaf.projectId is not set in profile.json" >&2
  exit 1
fi
if [ -z "$GIT_USERNAME" ]; then
  echo "ERROR: overleaf.gitUsername is not set in profile.json" >&2
  exit 1
fi
if [ -z "$GIT_PASSWORD" ]; then
  echo "ERROR: overleaf.gitPassword is not set in profile.json" >&2
  exit 1
fi

PROJECT_URL="https://www.overleaf.com/project/${PROJECT_ID}"
PDF_URL="https://www.overleaf.com/project/${PROJECT_ID}/output/output.pdf"

cat <<EOF
OVERLEAF_DOWNLOAD_INSTRUCTIONS
projectUrl: ${PROJECT_URL}
username: ${GIT_USERNAME}
outputPath: ${OUTPUT_PATH}
steps:
  1. Navigate to projectUrl
  2. If login page: enter username and gitPassword, submit
  3. Wait for project editor to load (look for "Recompile" button or compile status)
  4. Wait for green compile indicator (text: "Success" or green checkmark near Recompile button)
     - If red/error: capture the error message and print it, then exit with COMPILE_ERROR status
  5. Click the download button (look for download icon or "Download PDF" in the menu)
     OR navigate to: ${PDF_URL}
  6. Save downloaded file to: outputPath
END_OVERLEAF_DOWNLOAD_INSTRUCTIONS
EOF
