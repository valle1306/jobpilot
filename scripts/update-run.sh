#!/usr/bin/env bash
# Updates a specific job or field in a run file without reading the full JSON.
# Usage:
#   bash scripts/update-run.sh <run-file> job <job-id> <field> <value>
#   bash scripts/update-run.sh <run-file> status <new-status>
#   bash scripts/update-run.sh <run-file> summary
#   bash scripts/update-run.sh <run-file> add-job <json-object>
#
# Examples:
#   bash scripts/update-run.sh runs/my-run.json job 3 status applied
#   bash scripts/update-run.sh runs/my-run.json job 3 appliedAt "2026-03-22T14:00:00Z"
#   bash scripts/update-run.sh runs/my-run.json job 3 failReason "CAPTCHA required"
#   bash scripts/update-run.sh runs/my-run.json job 3 retryNotes "Try direct careers page"
#   bash scripts/update-run.sh runs/my-run.json status completed
#   bash scripts/update-run.sh runs/my-run.json summary   # recalculates summary from jobs
#   bash scripts/update-run.sh runs/my-run.json add-job '{"id":1,"title":"Dev","company":"Co","status":"pending"}'

source "$(dirname "$0")/_ensure-jq.sh"

RUN_FILE="$1"
ACTION="$2"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ ! -f "$RUN_FILE" ]; then
  echo "Error: Run file not found: $RUN_FILE"
  exit 1
fi

case "$ACTION" in
  job)
    JOB_ID="$3"
    FIELD="$4"
    VALUE="${*:5}"
    # Auto-detect value type
    case "$VALUE" in
      true|false|null) FILTER=".jobs |= map(if (.id|tostring) == \"$JOB_ID\" then .$FIELD = $VALUE else . end) | .updatedAt = \"$NOW\"" ;;
      ''|*[!0-9]*) FILTER=".jobs |= map(if (.id|tostring) == \"$JOB_ID\" then .$FIELD = \"$VALUE\" else . end) | .updatedAt = \"$NOW\"" ;;
      *) FILTER=".jobs |= map(if (.id|tostring) == \"$JOB_ID\" then .$FIELD = $VALUE else . end) | .updatedAt = \"$NOW\"" ;;
    esac
    RESULT=$(jq "$FILTER" "$RUN_FILE") && echo "$RESULT" > "$RUN_FILE" && echo "OK" || { echo "Error: Failed to update job"; exit 1; }
    ;;
  status)
    NEW_STATUS="$3"
    if [ "$NEW_STATUS" = "completed" ]; then
      FILTER=".status = \"$NEW_STATUS\" | .updatedAt = \"$NOW\" | .completedAt = \"$NOW\""
    else
      FILTER=".status = \"$NEW_STATUS\" | .updatedAt = \"$NOW\""
    fi
    RESULT=$(jq "$FILTER" "$RUN_FILE") && echo "$RESULT" > "$RUN_FILE" && echo "OK" || { echo "Error: Failed to update status"; exit 1; }
    ;;
  summary)
    FILTER='
      .summary = {
        totalFound: (.jobs | length),
        qualified: [.jobs[] | select(.status != "skipped" and .status != "pending")] | length,
        applied: [.jobs[] | select(.status == "applied")] | length,
        failed: [.jobs[] | select(.status == "failed")] | length,
        skipped: [.jobs[] | select(.status == "skipped")] | length,
        remaining: [.jobs[] | select(.status == "approved" or .status == "applying")] | length
      } | .updatedAt = "'"$NOW"'"
    '
    RESULT=$(jq "$FILTER" "$RUN_FILE") && echo "$RESULT" > "$RUN_FILE" && echo "OK" || { echo "Error: Failed to update summary"; exit 1; }
    ;;
  add-job)
    JOB_JSON="$3"
    RESULT=$(jq --argjson job "$JOB_JSON" '.jobs += [$job] | .updatedAt = "'"$NOW"'"' "$RUN_FILE") && echo "$RESULT" > "$RUN_FILE" && echo "OK" || { echo "Error: Failed to add job"; exit 1; }
    ;;
  *)
    echo "Unknown action: $ACTION"
    exit 1
    ;;
esac
