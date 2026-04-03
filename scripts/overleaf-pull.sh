#!/usr/bin/env bash
# Pulls the latest changes from Overleaf via Git Bridge.
# Usage: bash scripts/overleaf-pull.sh
#
# Reads from profile.json:
#   overleaf.localClonePath - local directory of the cloned Overleaf project

set -euo pipefail

source "$(dirname "$0")/_ensure-jq.sh"

PROFILE="${CLAUDE_PLUGIN_ROOT:-.}/profile.json"

if [ ! -f "$PROFILE" ]; then
  echo "ERROR: profile.json not found at $PROFILE" >&2
  exit 1
fi

CLONE_PATH=$(jq -r '.overleaf.localClonePath // ""' "$PROFILE")

if [ -z "$CLONE_PATH" ]; then
  echo "ERROR: overleaf.localClonePath is not set in profile.json" >&2
  exit 1
fi

if [ ! -d "$CLONE_PATH" ]; then
  echo "Overleaf not cloned yet. Run: bash scripts/overleaf-clone.sh"
  exit 1
fi

echo "Pulling latest from Overleaf at $CLONE_PATH ..."

if ! (cd "$CLONE_PATH" && git pull origin master); then
  echo "ERROR: git pull failed. Check your network connection and Overleaf credentials." >&2
  exit 1
fi

echo "Pulled latest from Overleaf"
