import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePostedHoursAgo, normalizePostedWithinHours } from '../lib/search.mjs';

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
