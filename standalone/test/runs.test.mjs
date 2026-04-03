import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunSummary, buildRunSummaryText } from '../lib/runs.mjs';

test('buildRunSummary counts stage-specific skips and failures', () => {
  const run = {
    runId: 'run-1',
    query: 'entry level data analyst',
    status: 'completed',
    jobs: [
      {
        id: 1,
        title: 'Data Analyst',
        status: 'applied',
        stage: 'applied',
        applyUrl: 'https://jobs.lever.co/acme/123'
      },
      {
        id: 2,
        title: 'ML Engineer',
        status: 'failed',
        stage: 'tailoring_failed',
        failStage: 'tailoring',
        failReason: 'OpenAI tailoring is required for this run.'
      },
      {
        id: 3,
        title: 'Analytics Analyst',
        status: 'failed',
        stage: 'failed',
        failStage: 'application',
        failReason: 'Login is required before applying.'
      },
      {
        id: 4,
        title: 'BI Analyst',
        status: 'skipped',
        stage: 'skipped',
        skipCategory: 'no-direct-apply',
        skipReason: 'No direct external apply URL extracted from the listing'
      },
      {
        id: 5,
        title: 'Data Scientist',
        status: 'skipped',
        stage: 'skipped',
        skipCategory: 'duplicate',
        skipReason: 'Already applied'
      },
      {
        id: 6,
        title: 'Business Analyst',
        status: 'skipped',
        stage: 'skipped',
        skipCategory: 'posted-age',
        skipReason: 'Posted outside the last 24 hours'
      }
    ]
  };

  const summary = buildRunSummary(run);

  assert.equal(summary.totalFound, 6);
  assert.equal(summary.qualified, 3);
  assert.equal(summary.applied, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.skipped, 3);
  assert.equal(summary.skippedNoDirectApply, 1);
  assert.equal(summary.skippedDuplicate, 1);
  assert.equal(summary.skippedPostedAge, 1);
  assert.equal(summary.failedTailoring, 1);
  assert.equal(summary.failedApplication, 1);
  assert.equal(summary.stageCounts.applied, 1);
  assert.equal(summary.stageCounts.tailoring_failed, 1);
});

test('buildRunSummaryText includes top failure reasons and bucket totals', () => {
  const text = buildRunSummaryText({
    runId: 'run-2',
    query: 'entry level data scientist',
    status: 'completed',
    startedAt: '2026-04-03T12:00:00.000Z',
    completedAt: '2026-04-03T12:15:00.000Z',
    jobs: [
      {
        id: 1,
        title: 'Data Analyst',
        status: 'failed',
        stage: 'failed',
        failStage: 'application',
        failReason: 'Login is required before applying.',
        url: 'https://boards.greenhouse.io/acme/jobs/123'
      }
    ]
  });

  assert.match(text, /failed during application\/login\/form handling: 1/);
  assert.match(text, /skipped for being older than the configured posting window: 0/);
  assert.match(text, /Top failure causes:/);
  assert.match(text, /Login is required before applying\./);
});
