import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeJobs } from '../lib/scoring.mjs';
import {
  canonicalizeJobUrl,
  extractExternalJobUrl,
  extractKnownDirectJobUrl,
  isAggregatorUrl
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
