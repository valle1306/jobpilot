#!/usr/bin/env bash
# Clones your Overleaf project via Git Bridge (one-time setup).
# Usage: bash scripts/overleaf-clone.sh
#
# Reads from profile.json:
#   overleaf.gitUrl        - base HTTPS git URL (e.g. https://git.overleaf.com/PROJECT_ID)
#   overleaf.localClonePath - local directory to clone into
#   overleaf.gitToken      - Overleaf Git token (preferred; falls back to legacy gitPassword)
#   overleaf.texFiles      - object map of role type to .tex filename

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
GIT_TOKEN=$(jq -r '.overleaf.gitToken // .overleaf.gitPassword // ""' "$PROFILE")
HAS_LEGACY_GIT_PASSWORD=$(jq -r 'if (.overleaf.gitPassword // "") != "" and (.overleaf.gitToken // "") == "" then "true" else "false" end' "$PROFILE")
TEX_FILES=$(jq -r '.overleaf.texFiles // {} | .[]' "$PROFILE")

# Validate required fields
if [ -z "$GIT_URL" ]; then
  echo "ERROR: overleaf.gitUrl is not set in profile.json" >&2
  exit 1
fi
if [ -z "$CLONE_PATH" ]; then
  echo "ERROR: overleaf.localClonePath is not set in profile.json" >&2
  exit 1
fi
if [ -z "$GIT_TOKEN" ]; then
  echo "ERROR: overleaf.gitToken is not set in profile.json" >&2
  exit 1
fi

# Already cloned — tell user to pull instead
if [ -d "$CLONE_PATH" ]; then
  echo "Already cloned at $CLONE_PATH. Run overleaf-pull.sh to update."
  exit 0
fi

if [ "$HAS_LEGACY_GIT_PASSWORD" = "true" ]; then
  echo "WARNING: overleaf.gitPassword is deprecated. Rename it to overleaf.gitToken in profile.json." >&2
fi

# URL-encode special characters in the token using python3
ENCODED_TOKEN=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$GIT_TOKEN" 2>/dev/null) || \
ENCODED_TOKEN=$(perl -MURI::Escape -e 'print uri_escape($ARGV[0])' "$GIT_TOKEN" 2>/dev/null) || {
  echo "ERROR: Could not URL-encode token (python3 or perl with URI::Escape required)" >&2
  exit 1
}

# Build authenticated URL by embedding credentials into the HTTPS URL.
# Overleaf token auth uses the fixed username "git".
# Input URL format:  https://git.overleaf.com/PROJECT_ID
# Output URL format: https://git:token@git.overleaf.com/PROJECT_ID
PROTOCOL="${GIT_URL%%://*}"
REST="${GIT_URL#*://}"
ENCODED_USERNAME="git"
AUTH_URL="${PROTOCOL}://${ENCODED_USERNAME}:${ENCODED_TOKEN}@${REST}"

echo "Cloning Overleaf project to $CLONE_PATH ..."

if ! git clone "$AUTH_URL" "$CLONE_PATH"; then
  echo "ERROR: git clone failed. Check overleaf.gitUrl and overleaf.gitToken in profile.json. Overleaf Git Bridge token auth uses the username 'git'." >&2
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
