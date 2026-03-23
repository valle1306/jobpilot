#!/usr/bin/env bash
# Checks if a job URL has already been applied to.
# Usage: bash scripts/check-applied.sh <url>
# Exit code 0 = already applied, exit code 1 = not applied
# Also checks run files as a fallback.

source "$(dirname "$0")/_ensure-jq.sh"

URL="$1"
DB="${CLAUDE_PLUGIN_ROOT:-.}/applied-jobs.json"
RUNS_DIR="${CLAUDE_PLUGIN_ROOT:-.}/runs"

if [ -z "$URL" ]; then
  echo "Usage: bash scripts/check-applied.sh <url>"
  exit 1
fi

# Check applied-jobs.json first
if [ -f "$DB" ]; then
  FOUND=$(jq --arg url "$URL" '[.[] | select(.url == $url)] | length' "$DB" 2>/dev/null)
  if [ "$FOUND" != "0" ] && [ -n "$FOUND" ]; then
    echo "already-applied"
    exit 0
  fi
fi

# Fallback: check run files
if [ -d "$RUNS_DIR" ] && [ -n "$(ls -A "$RUNS_DIR" 2>/dev/null)" ]; then
  FOUND=$(jq --arg url "$URL" '[.jobs[]? | select(.status == "applied" and .url == $url)] | length' "$RUNS_DIR"/*.json 2>/dev/null | jq -s 'add')
  if [ "$FOUND" != "0" ] && [ -n "$FOUND" ]; then
    echo "already-applied"
    exit 0
  fi
fi

echo "not-applied"
exit 1
