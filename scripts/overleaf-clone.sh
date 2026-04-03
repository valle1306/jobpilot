#!/usr/bin/env bash
# Clones your Overleaf project via Git Bridge (one-time setup).
# Usage: bash scripts/overleaf-clone.sh
#
# Reads from profile.json:
#   overleaf.gitUrl        - base HTTPS git URL (e.g. https://git.overleaf.com/PROJECT_ID)
#   overleaf.localClonePath - local directory to clone into
#   overleaf.gitUsername   - Overleaf account email
#   overleaf.gitPassword   - Overleaf git token / password
#   overleaf.texFiles      - array of .tex filenames expected after clone

set -euo pipefail

source "$(dirname "$0")/_ensure-jq.sh"

PROFILE="${CLAUDE_PLUGIN_ROOT:-.}/profile.json"

if [ ! -f "$PROFILE" ]; then
  echo "ERROR: profile.json not found at $PROFILE" >&2
  exit 1
fi

# Read credentials from profile.json
GIT_URL=$(jq -r '.overleaf.gitUrl // ""' "$PROFILE")
CLONE_PATH=$(jq -r '.overleaf.localClonePath // ""' "$PROFILE")
GIT_USERNAME=$(jq -r '.overleaf.gitUsername // ""' "$PROFILE")
GIT_PASSWORD=$(jq -r '.overleaf.gitPassword // ""' "$PROFILE")
TEX_FILES=$(jq -r '.overleaf.texFiles // [] | .[]' "$PROFILE")

# Validate required fields
if [ -z "$GIT_URL" ]; then
  echo "ERROR: overleaf.gitUrl is not set in profile.json" >&2
  exit 1
fi
if [ -z "$CLONE_PATH" ]; then
  echo "ERROR: overleaf.localClonePath is not set in profile.json" >&2
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

# Already cloned — tell user to pull instead
if [ -d "$CLONE_PATH" ]; then
  echo "Already cloned at $CLONE_PATH. Run overleaf-pull.sh to update."
  exit 0
fi

# URL-encode special characters in the password using python3
ENCODED_PASSWORD=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$GIT_PASSWORD" 2>/dev/null) || \
ENCODED_PASSWORD=$(perl -MURI::Escape -e 'print uri_escape($ARGV[0])' "$GIT_PASSWORD" 2>/dev/null) || {
  echo "ERROR: Could not URL-encode password (python3 or perl with URI::Escape required)" >&2
  exit 1
}

# Build authenticated URL by embedding credentials into the HTTPS URL
# Input URL format:  https://git.overleaf.com/PROJECT_ID
# Output URL format: https://username:token@git.overleaf.com/PROJECT_ID
PROTOCOL="${GIT_URL%%://*}"
REST="${GIT_URL#*://}"
ENCODED_USERNAME=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$GIT_USERNAME" 2>/dev/null) || \
ENCODED_USERNAME=$(perl -MURI::Escape -e 'print uri_escape($ARGV[0])' "$GIT_USERNAME" 2>/dev/null) || {
  echo "ERROR: Could not URL-encode username (python3 or perl with URI::Escape required)" >&2
  exit 1
}
AUTH_URL="${PROTOCOL}://${ENCODED_USERNAME}:${ENCODED_PASSWORD}@${REST}"

echo "Cloning Overleaf project to $CLONE_PATH ..."

if ! git clone "$AUTH_URL" "$CLONE_PATH"; then
  echo "ERROR: git clone failed. Check your gitUrl, gitUsername, and gitPassword in profile.json." >&2
  exit 1
fi

echo "Clone complete. Verifying expected .tex files ..."

MISSING=0
while IFS= read -r TEX_FILE; do
  [ -z "$TEX_FILE" ] && continue
  if [ ! -f "$CLONE_PATH/$TEX_FILE" ]; then
    echo "WARNING: Expected file not found in clone: $TEX_FILE" >&2
    MISSING=$((MISSING + 1))
  else
    echo "  Found: $TEX_FILE"
  fi
done <<< "$TEX_FILES"

if [ "$MISSING" -gt 0 ]; then
  echo "WARNING: $MISSING expected .tex file(s) were not found. Verify overleaf.texFiles in profile.json matches your project." >&2
fi

echo "Overleaf project cloned successfully to: $CLONE_PATH"
