import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePostedHoursAgo, normalizePostedWithinHours } from '../lib/search.mjs';
import { parseSearchQuery } from '../lib/config.mjs';

test('normalizePostedWithinHours rounds valid values and disables invalid ones', () => {
  assert.equal(normalizePostedWithinHours(24), 24);
  assert.equal(normalizePostedWithinHours('24.4'), 24);
  assert.equal(normalizePostedWithinHours(0), 0);
  assert.equal(normalizePostedWithinHours(-5), 0);
  assert.equal(normalizePostedWithinHours('abc'), 0);
});

test('estimatePostedHoursAgo parses common relative posting phrases', () => {
  assert.equal(estimatePostedHoursAgo({ postedText: '3 hours ago' }), 3);
  assert.equal(estimatePostedHoursAgo({ postedText: 'Yesterday' }), 24);
  assert.equal(estimatePostedHoursAgo({ postedText: '2 days ago' }), 48);
  assert.equal(estimatePostedHoursAgo({ postedText: '1 week ago' }), 168);
});

test('estimatePostedHoursAgo uses absolute datetimes when available', () => {
  const now = Date.parse('2026-04-03T12:00:00.000Z');
  const age = estimatePostedHoursAgo(
    { postedDatetime: '2026-04-02T12:00:00.000Z' },
    now
  );

  assert.equal(age, 24);
});

test('parseSearchQuery strips relative-time phrases from keyword text', () => {
  const parsed = parseSearchQuery('entry level data analyst in the past 24 hours');

  assert.equal(parsed.keywords, 'entry level data analyst');
  assert.equal(parsed.location, '');
});

test('parseSearchQuery preserves remote while stripping relative-time phrases', () => {
  const parsed = parseSearchQuery('machine learning engineer remote last 24 hours');

  assert.equal(parsed.keywords, 'machine learning engineer');
  assert.equal(parsed.location, 'remote');
  assert.equal(parsed.remote, true);
});
