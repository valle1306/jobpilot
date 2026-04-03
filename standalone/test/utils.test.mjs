import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeJobs } from '../lib/scoring.mjs';
import {
  canonicalizeJobUrl,
  cleanJobTitle,
  extractExternalJobUrl,
  getDirectApplyTier,
  extractKnownDirectJobUrl,
  isAggregatorUrl,
  resolveEffectiveApplyUrl
} from '../lib/utils.mjs';

test('extractExternalJobUrl decodes redirected apply links', () => {
  const redirected =
    'https://www.linkedin.com/jobs/view/externalApply?url=https%3A%2F%2Fjobs.lever.co%2Facme%2F123%3Futm_source%3Dlinkedin';

  assert.equal(
    extractExternalJobUrl(redirected),
    'https://jobs.lever.co/acme/123?utm_source=linkedin'
  );
});

test('canonicalizeJobUrl strips tracking parameters from LinkedIn job URLs', () => {
  const tracked =
    'https://www.linkedin.com/jobs/view/analyst-business-intelligence-at-forbes-4387419891?position=6&pageNum=0&refId=abc&trackingId=def';

  assert.equal(
    canonicalizeJobUrl(tracked),
    'https://www.linkedin.com/jobs/view/analyst-business-intelligence-at-forbes-4387419891'
  );
});

test('isAggregatorUrl identifies aggregator job surfaces', () => {
  assert.equal(isAggregatorUrl('https://www.linkedin.com/jobs/view/123'), true);
  assert.equal(isAggregatorUrl('https://jobright.ai/jobs/info/abc123'), true);
  assert.equal(isAggregatorUrl('https://click.appcast.io/t/example'), true);
  assert.equal(isAggregatorUrl('https://jobs.lever.co/acme/123'), false);
});

test('extractKnownDirectJobUrl finds ATS links embedded in escaped page HTML', () => {
  const html =
    '<script>window.__JOB__ = {"applyUrl":"https:\\/\\/www.linkedin.com\\/jobs\\/view\\/externalApply?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F123%3Fgh_src%3Dlinkedin"};</script>';

  assert.equal(
    extractKnownDirectJobUrl(html),
    'https://boards.greenhouse.io/acme/jobs/123?gh_src=linkedin'
  );
});

test('getDirectApplyTier prioritizes preferred ATS domains ahead of generic external sites', () => {
  assert.equal(getDirectApplyTier('https://boards.greenhouse.io/acme/jobs/123'), 3);
  assert.equal(getDirectApplyTier('https://jobs.lever.co/acme/123'), 3);
  assert.equal(getDirectApplyTier('https://ibmglobal.avature.net/en_US/careers/JobDetail?jobId=87026'), 2);
  assert.equal(getDirectApplyTier('https://company.example/jobs/123'), 1);
  assert.equal(getDirectApplyTier('https://www.linkedin.com/jobs/view/123/apply/'), 0);
});

test('resolveEffectiveApplyUrl prefers non-aggregator apply URLs and falls back to direct source URLs', () => {
  assert.equal(
    resolveEffectiveApplyUrl({
      url: 'https://www.linkedin.com/jobs/view/123',
      applyUrl: 'https://jobs.lever.co/acme/123?utm_source=linkedin'
    }),
    'https://jobs.lever.co/acme/123'
  );

  assert.equal(
    resolveEffectiveApplyUrl({
      url: 'https://careers.acme.com/jobs/data-analyst-1',
      applyUrl: ''
    }),
    'https://careers.acme.com/jobs/data-analyst-1'
  );
});

test('cleanJobTitle removes LinkedIn verification suffixes and duplicate titles', () => {
  assert.equal(
    cleanJobTitle(
      'Data Scientist Associate - Payments Data Scientist Associate - Payments with verification'
    ),
    'Data Scientist Associate - Payments'
  );
});

test('dedupeJobs prefers canonical direct apply URLs across duplicate search results', () => {
  const jobs = [
    {
      url: 'https://www.linkedin.com/jobs/view/example-1?trackingId=abc',
      applyUrl:
        'https://www.linkedin.com/jobs/view/externalApply?url=https%3A%2F%2Fjobs.lever.co%2Facme%2F123',
      company: 'Acme',
      title: 'Data Analyst',
      description: 'short'
    },
    {
      url: 'https://www.indeed.com/viewjob?jk=987&from=shareddesktop',
      applyUrl: 'https://jobs.lever.co/acme/123?utm_source=indeed',
      company: 'Acme',
      title: 'Data Analyst',
      description: 'a much longer description'
    }
  ];

  const deduped = dedupeJobs(jobs);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].description, 'a much longer description');
});
