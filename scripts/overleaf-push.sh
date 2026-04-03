#!/usr/bin/env bash
# Commits, optionally tags, and pushes changes back to Overleaf via Git Bridge.
# Usage: bash scripts/overleaf-push.sh "<commit_message>" [<tag_name>]
#
# Arguments:
#   $1 - commit message  (e.g. "Tailored for Analytics Engineer at Stripe")
#   $2 - tag name        (optional; e.g. "product-ds/stripe-analytics-engineer-2026-04-03")
#
# Reads from profile.json:
#   overleaf.localClonePath - local directory of the cloned Overleaf project

set -euo pipefail

source "$(dirname "$0")/_ensure-jq.sh"

COMMIT_MSG="${1:-}"
TAG_NAME="${2:-}"

if [ -z "$COMMIT_MSG" ]; then
  echo "Usage: bash scripts/overleaf-push.sh \"<commit_message>\" [<tag_name>]" >&2
  exit 1
fi

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
  echo "ERROR: Overleaf clone directory not found at $CLONE_PATH. Run: bash scripts/overleaf-clone.sh" >&2
  exit 1
fi

cd "$CLONE_PATH"

echo "Staging all changes ..."
if ! git add -A; then
  echo "ERROR: git add failed." >&2
  exit 1
fi

echo "Committing: $COMMIT_MSG"
if ! git commit -m "$COMMIT_MSG"; then
  echo "ERROR: git commit failed. There may be nothing to commit, or a git config issue." >&2
  exit 1
fi

# Create annotated tag if provided
if [ -n "$TAG_NAME" ]; then
  echo "Tagging: $TAG_NAME"
  if ! git tag -a "$TAG_NAME" -m "$COMMIT_MSG"; then
    echo "ERROR: git tag failed. Tag '$TAG_NAME' may already exist." >&2
    exit 1
  fi
fi

echo "Pushing to Overleaf (origin master) ..."
if ! git push origin master; then
  echo "ERROR: git push failed. Check your network connection and Overleaf credentials." >&2
  exit 1
fi

# Push tag separately (Overleaf Git Bridge requires tags pushed explicitly)
if [ -n "$TAG_NAME" ]; then
  echo "Pushing tag: $TAG_NAME"
  if ! git push origin "$TAG_NAME"; then
    echo "WARNING: Tag push failed for '$TAG_NAME'. Commit was pushed successfully." >&2
  fi
  echo "Pushed to Overleaf and tagged: $TAG_NAME"
else
  echo "Pushed to Overleaf (no tag)"
fi
