#!/usr/bin/env bash
# Aggregates stats from all autopilot run files into a compact JSON summary.
# Usage: bash scripts/run-stats.sh [runs_dir]
# Output: JSON with totals, per-board breakdown, applied/failed/skipped lists, reason summaries, and recent runs.

source "$(dirname "$0")/_ensure-jq.sh"

RUNS_DIR="${1:-${CLAUDE_PLUGIN_ROOT:-.}/runs}"

if [ ! -d "$RUNS_DIR" ] || [ -z "$(ls -A "$RUNS_DIR" 2>/dev/null)" ]; then
  echo '{"totalRuns":0,"totalJobsFound":0,"totalApplied":0,"totalFailed":0,"totalSkipped":0,"successRate":"0%","byBoard":{},"applied":[],"failed":[],"skipped":[],"failReasons":{},"skipReasons":{},"recentRuns":[]}'
  exit 0
fi

jq -s '
  . as $runs |
  [.[].jobs[]?] as $allJobs |
  ($allJobs | map(select(.status == "applied"))) as $applied |
  ($allJobs | map(select(.status == "failed"))) as $failed |
  ($allJobs | map(select(.status == "skipped"))) as $skipped |
  (($applied | length) + ($failed | length)) as $attempts |
  {
    totalRuns: ($runs | length),
    totalJobsFound: ($allJobs | length),
    totalApplied: ($applied | length),
    totalFailed: ($failed | length),
    totalSkipped: ($skipped | length),
    successRate: (if $attempts > 0 then "\(($applied | length) * 100 / $attempts)%" else "0%" end),
    byBoard: ($allJobs | group_by(.board // "unknown") | map({
      key: (.[0].board // "unknown"),
      value: {
        found: length,
        applied: [.[] | select(.status == "applied")] | length,
        failed: [.[] | select(.status == "failed")] | length,
        skipped: [.[] | select(.status == "skipped")] | length
      }
    }) | from_entries),
    applied: [$runs[] | .runId as $rid | .jobs[]? | select(.status == "applied") |
      {title, company, score: .matchScore, board, appliedAt, runId: $rid, url}],
    failed: [$runs[] | .runId as $rid | .jobs[]? | select(.status == "failed") |
      {title, company, board, failReason: (.failReason // "Unknown"), retryNotes: (.retryNotes // ""), runId: $rid, url}],
    skipped: [$runs[] | .runId as $rid | .jobs[]? | select(.status == "skipped") |
      {title, company, board, skipReason: (.skipReason // "Unknown"), runId: $rid, url}],
    failReasons: ($failed | group_by(.failReason // "Unknown") | map({key: (.[0].failReason // "Unknown"), value: length}) | from_entries),
    skipReasons: ($skipped | group_by(.skipReason // "Unknown") | map({key: (.[0].skipReason // "Unknown"), value: length}) | from_entries),
    recentRuns: [$runs[] | {runId, query, status, applied: (.summary.applied // 0), failed: (.summary.failed // 0), skipped: (.summary.skipped // 0), startedAt}] | sort_by(.startedAt) | reverse
  }
' "$RUNS_DIR"/*.json 2>/dev/null || echo '{"error":"Failed to parse run files"}'
