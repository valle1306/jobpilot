import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRoleType } from '../lib/config.mjs';
import { scoreJob } from '../lib/scoring.mjs';

test('classifyRoleType prefers product data science keywords', () => {
  const roleType = classifyRoleType(
    'Senior Product Data Scientist',
    'Lead experimentation, growth analytics, and retention analysis.'
  );
  assert.equal(roleType, 'product-ds');
});

test('classifyRoleType detects machine learning roles', () => {
  const roleType = classifyRoleType(
    'Machine Learning Scientist',
    'Build PyTorch models and lead clinical AI research.'
  );
  assert.equal(roleType, 'ml-ds');
});

test('scoreJob rewards overlap between resume and job text', () => {
  const scored = scoreJob({
    resumeText: 'Python SQL experimentation dashboards retention product analytics',
    title: 'Product Data Scientist',
    description: 'Own experimentation, SQL analysis, and dashboard insights.',
    query: 'product data scientist remote'
  });

  assert.ok(scored.score >= 6);
  assert.ok(scored.matchedKeywords.includes('experimentation'));
});
