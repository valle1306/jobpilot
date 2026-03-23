#!/usr/bin/env bash
# Exports all applied/failed jobs from run history to CSV.
# Usage: bash scripts/export-csv.sh [runs_dir] [output_file]
# Output: CSV file with headers: status,title,company,location,board,score,url,appliedAt,failReason,runId,query

source "$(dirname "$0")/_ensure-jq.sh"

RUNS_DIR="${1:-${CLAUDE_PLUGIN_ROOT:-.}/runs}"
OUTPUT="${2:-${CLAUDE_PLUGIN_ROOT:-.}/job-applications.csv}"

if [ ! -d "$RUNS_DIR" ] || [ -z "$(ls -A "$RUNS_DIR" 2>/dev/null)" ]; then
  echo "No run files found in $RUNS_DIR"
  exit 0
fi

{
  echo "status,title,company,location,board,score,url,appliedAt,failReason,runId,query"
  jq -r '
    .runId as $rid | .query as $query |
    .jobs[]? | select(.status == "applied" or .status == "failed") |
    [
      .status,
      (.title // "" | gsub(","; " ")),
      (.company // "" | gsub(","; " ")),
      (.location // "" | gsub(","; " ")),
      (.board // ""),
      (.matchScore // "" | tostring),
      (.url // ""),
      (.appliedAt // ""),
      (.failReason // ""),
      $rid,
      ($query // "" | gsub(","; " "))
    ] | join(",")
  ' "$RUNS_DIR"/*.json 2>/dev/null
} > "$OUTPUT"

COUNT=$(tail -n +2 "$OUTPUT" | wc -l | tr -d ' ')
echo "Exported $COUNT jobs to $OUTPUT"
