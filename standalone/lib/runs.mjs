import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './config.mjs';
import { nowIso, readJson, slugify, truncate, writeJson, writeText } from './utils.mjs';

const runsDir = path.join(repoRoot, 'runs');
const appliedDbPath = path.join(repoRoot, 'applied-jobs.json');

export function createRunId(query) {
  const timestamp = nowIso().replace(/[:.]/g, '-');
  return `${timestamp}_${slugify(query)}`;
}

export async function createRunFile(query, config = {}) {
  const runId = createRunId(query);
  const runPath = path.join(runsDir, `${runId}.json`);
  const run = {
    runId,
    query,
    config,
    status: 'in_progress',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
    jobs: [],
    summary: {
      totalFound: 0,
      qualified: 0,
      applied: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      skippedNoDirectApply: 0,
      skippedDuplicate: 0,
      failedTailoring: 0,
      failedPdfGeneration: 0,
      failedApplication: 0,
      stageCounts: {},
      topFailureReasons: []
    }
  };
  await writeJson(runPath, run);
  return { runId, runPath, run };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!key) {
      continue;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function buildRunSummary(run) {
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  const stageCounts = countBy(jobs, (job) => job.stage || '');
  const topFailureReasons = Object.entries(
    countBy(
      jobs.filter((job) => job.status === 'failed'),
      (job) => job.failReason || job.result || 'Unknown failure'
    )
  )
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));

  return {
    totalFound: jobs.length,
    qualified: jobs.filter((job) => ['qualified', 'tailoring_started', 'tailoring_failed', 'pdf_ready', 'apply_started', 'applied', 'failed'].includes(job.stage)).length,
    applied: jobs.filter((job) => job.status === 'applied').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
    skipped: jobs.filter((job) => job.status === 'skipped').length,
    remaining: jobs.filter((job) => ['approved', 'applying'].includes(job.status)).length,
    skippedNoDirectApply: jobs.filter((job) => job.skipCategory === 'no-direct-apply').length,
    skippedDuplicate: jobs.filter((job) => job.skipCategory === 'duplicate').length,
    failedTailoring: jobs.filter((job) => job.status === 'failed' && job.failStage === 'tailoring').length,
    failedPdfGeneration: jobs.filter((job) => job.status === 'failed' && job.failStage === 'pdf_generation').length,
    failedApplication: jobs.filter((job) => job.status === 'failed' && job.failStage === 'application').length,
    stageCounts,
    topFailureReasons
  };
}

function buildFailureSection(summary) {
  if (!summary.topFailureReasons.length) {
    return 'Top failure causes:\n- none';
  }

  return [
    'Top failure causes:',
    ...summary.topFailureReasons.map((entry) => `- ${entry.count}x ${truncate(entry.reason, 140)}`)
  ].join('\n');
}

export function buildRunSummaryText(run) {
  const summary = buildRunSummary(run);
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  const stageLines = Object.entries(summary.stageCounts)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([stage, count]) => `- ${stage}: ${count}`);
  const jobLines = jobs.map((job) => {
    const targetUrl = job.applyUrl || job.url || '';
    const reason = job.failReason || job.skipReason || '';
    return `${job.id ?? '?'} | ${truncate(job.title || 'Untitled role', 54)} | ${job.status} | ${job.stage || 'n/a'}${reason ? ` | ${truncate(reason, 120)}` : ''}${targetUrl ? ` | ${truncate(targetUrl, 120)}` : ''}`;
  });

  return [
    `Run: ${run.runId ?? 'unknown'}`,
    `Query: ${run.query ?? 'unknown'}`,
    `Status: ${run.status ?? 'unknown'}`,
    `Started: ${run.startedAt ?? 'unknown'}`,
    `Completed: ${run.completedAt ?? 'in progress'}`,
    '',
    'Totals:',
    `- discovered: ${summary.totalFound}`,
    `- qualified: ${summary.qualified}`,
    `- applied: ${summary.applied}`,
    `- failed: ${summary.failed}`,
    `- skipped: ${summary.skipped}`,
    `- remaining: ${summary.remaining}`,
    '',
    'Skip and failure buckets:',
    `- skipped for no direct apply URL: ${summary.skippedNoDirectApply}`,
    `- skipped as duplicate/already applied: ${summary.skippedDuplicate}`,
    `- failed during tailoring: ${summary.failedTailoring}`,
    `- failed during pdf generation: ${summary.failedPdfGeneration}`,
    `- failed during application/login/form handling: ${summary.failedApplication}`,
    '',
    'Stage counts:',
    ...(stageLines.length ? stageLines : ['- none']),
    '',
    buildFailureSection(summary),
    '',
    'Jobs:',
    ...(jobLines.length ? jobLines : ['- none']),
    ''
  ].join('\n');
}

function getRunSummaryPath(runPath) {
  return runPath.replace(/\.json$/i, '.summary.txt');
}

export async function saveRun(runPath, run) {
  run.updatedAt = nowIso();
  run.summary = buildRunSummary(run);
  await writeJson(runPath, run);
  await writeText(getRunSummaryPath(runPath), buildRunSummaryText(run));
}

export async function wasAlreadyApplied(url) {
  const appliedJobs = await readJson(appliedDbPath, []);
  if (appliedJobs.some((job) => job.url === url)) {
    return true;
  }

  try {
    const files = await fs.readdir(runsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const run = await readJson(path.join(runsDir, file), { jobs: [] });
      if ((run.jobs ?? []).some((job) => job.url === url && job.status === 'applied')) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

export async function logAppliedJob({ url, title, company, source, runId = '' }) {
  const current = await readJson(appliedDbPath, []);
  if (current.some((entry) => entry.url === url)) {
    return;
  }

  current.push({
    url,
    title,
    company,
    source,
    runId,
    appliedAt: nowIso()
  });

  await writeJson(appliedDbPath, current);
}
