import { normalizeWhitespace, uniqueBy } from './utils.mjs';

const stopwords = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'you',
  'our',
  'are',
  'will',
  'have',
  'has',
  'had',
  'who',
  'how',
  'what',
  'where',
  'when',
  'their',
  'about',
  'using',
  'able',
  'role',
  'team',
  'jobs',
  'job',
  'work',
  'experience',
  'years',
  'year',
  'required',
  'preferred',
  'plus',
  'across',
  'more',
  'than',
  'build',
  'building',
  'strong',
  'high',
  'highly',
  'can',
  'should',
  'must',
  'not',
  'all',
  'any',
  'one',
  'two',
  'three',
  'new'
]);

export function tokenize(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9+#./-]+/)
    .filter((token) => token.length >= 2 && !stopwords.has(token));
}

export function topKeywords(text, limit = 16) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([token]) => token);
}

export function scoreJob({ resumeText, title, description, query }) {
  const resumeTokens = new Set(tokenize(resumeText));
  const jobKeywords = uniqueBy(
    [...topKeywords(title, 8), ...topKeywords(description, 24)],
    (token) => token
  );
  const queryKeywords = topKeywords(query, 8);

  const matched = jobKeywords.filter((token) => resumeTokens.has(token));
  const queryMatched = queryKeywords.filter((token) => resumeTokens.has(token));

  const overlapRatio = jobKeywords.length
    ? matched.length / jobKeywords.length
    : 0;
  const queryRatio = queryKeywords.length
    ? queryMatched.length / queryKeywords.length
    : 0;

  let score = 3 + Math.round(overlapRatio * 5) + Math.round(queryRatio * 2);
  score = Math.max(1, Math.min(10, score));

  const missing = jobKeywords.filter((token) => !resumeTokens.has(token)).slice(0, 6);
  const reasonParts = [];
  if (queryMatched.length > 0) {
    reasonParts.push(`query overlap: ${queryMatched.slice(0, 4).join(', ')}`);
  }
  if (matched.length > 0) {
    reasonParts.push(`resume overlap: ${matched.slice(0, 5).join(', ')}`);
  }
  if (missing.length > 0) {
    reasonParts.push(`missing: ${missing.slice(0, 4).join(', ')}`);
  }

  return {
    score,
    matchedKeywords: matched.slice(0, 8),
    missingKeywords: missing,
    reason: reasonParts.join(' | ')
  };
}

export function dedupeJobs(jobs) {
  const seen = new Map();

  for (const job of jobs) {
    const key = `${normalizeWhitespace(job.company || 'unknown').toLowerCase()}::${normalizeWhitespace(job.title || job.url).toLowerCase()}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, job);
      continue;
    }

    const existingLength = (existing.description || '').length;
    const nextLength = (job.description || '').length;
    if (nextLength > existingLength) {
      seen.set(key, job);
    }
  }

  return [...seen.values()];
}
