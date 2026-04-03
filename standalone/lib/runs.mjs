import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from './config.mjs';
import { nowIso, readJson, slugify, writeJson } from './utils.mjs';

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
      remaining: 0
    }
  };
  await writeJson(runPath, run);
  return { runId, runPath, run };
}

export async function saveRun(runPath, run) {
  run.updatedAt = nowIso();
  run.summary = {
    totalFound: run.jobs.length,
    qualified: run.jobs.filter((job) => !['pending', 'skipped'].includes(job.status)).length,
    applied: run.jobs.filter((job) => job.status === 'applied').length,
    failed: run.jobs.filter((job) => job.status === 'failed').length,
    skipped: run.jobs.filter((job) => job.status === 'skipped').length,
    remaining: run.jobs.filter((job) => ['approved', 'applying'].includes(job.status)).length
  };
  await writeJson(runPath, run);
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
