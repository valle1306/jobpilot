#!/usr/bin/env bash
# Logs a successfully applied job to the persistent applied-jobs.json database.
# Usage: bash scripts/log-applied.sh <url> <title> <company> <source> [runId]
# Source: "autopilot", "apply", or other skill name that triggered the application.

source "$(dirname "$0")/_ensure-jq.sh"

URL="$1"
TITLE="$2"
COMPANY="$3"
SOURCE="$4"
RUN_ID="${5:-}"
DB="${CLAUDE_PLUGIN_ROOT:-.}/applied-jobs.json"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ -z "$URL" ] || [ -z "$TITLE" ] || [ -z "$COMPANY" ] || [ -z "$SOURCE" ]; then
  echo "Usage: bash scripts/log-applied.sh <url> <title> <company> <source> [runId]"
  exit 1
fi

# Initialize file if it doesn't exist
if [ ! -f "$DB" ]; then
  echo "[]" > "$DB"
fi

# Append entry
RESULT=$(jq --arg url "$URL" --arg title "$TITLE" --arg company "$COMPANY" \
  --arg source "$SOURCE" --arg runId "$RUN_ID" --arg appliedAt "$NOW" \
  '. += [{url: $url, title: $title, company: $company, source: $source, runId: $runId, appliedAt: $appliedAt}]' \
  "$DB") && echo "$RESULT" > "$DB" && echo "OK" || { echo "Error: Failed to log application"; exit 1; }
