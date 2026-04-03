import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, normalizeWhitespace } from './utils.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(currentDir, '..', '..');
let repoEnvLoaded = false;

function parseEnvLine(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) {
    return null;
  }

  let [, key, value] = match;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

export async function loadRepoEnv() {
  if (repoEnvLoaded) {
    return;
  }

  const envPath = path.join(repoRoot, '.env');
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) {
        continue;
      }

      const parsed = parseEnvLine(line);
      if (!parsed) {
        continue;
      }

      // Prefer repo-local .env values for this standalone project so stale
      // user-level Windows environment variables do not override the repo setup.
      process.env[parsed.key] = parsed.value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  repoEnvLoaded = true;
}

export function resolveRepoPath(pathValue) {
  if (!pathValue) {
    return null;
  }

  if (path.isAbsolute(pathValue)) {
    return pathValue;
  }

  return path.resolve(repoRoot, pathValue);
}

export async function loadProfile() {
  await loadRepoEnv();
  const profilePath = path.join(repoRoot, 'profile.json');
  const raw = await fs.readFile(profilePath, 'utf8');
  const profile = JSON.parse(raw);
  return { profilePath, profile };
}

export async function readResumeText(profile, roleKey = 'default') {
  const roleValue =
    profile?.personal?.resumes?.[roleKey] ??
    profile?.personal?.resumes?.default;

  if (!roleValue) {
    throw new Error(`personal.resumes.${roleKey} is not set in profile.json`);
  }

  const resolvedPath = resolveRepoPath(roleValue);
  const text = await fs.readFile(resolvedPath, 'utf8');
  return { resolvedPath, text };
}

export function classifyRoleType(title = '', description = '') {
  const haystack = `${title} ${description}`.toLowerCase();

  const productKeywords = [
    'product',
    'analytics',
    'experimentation',
    'a/b',
    'growth',
    'funnel',
    'retention',
    'business intelligence',
    'insights',
    'data analyst',
    'product analyst',
    'dashboard',
    'kpi',
    'metrics'
  ];

  if (productKeywords.some((keyword) => haystack.includes(keyword))) {
    return 'product-ds';
  }

  const mlKeywords = [
    'machine learning',
    'ml engineer',
    'deep learning',
    'neural',
    'research scientist',
    'healthcare ai',
    'clinical',
    'pytorch',
    'model training',
    'llm',
    'nlp scientist',
    'computer vision',
    'reinforcement learning'
  ];

  if (mlKeywords.some((keyword) => haystack.includes(keyword))) {
    return 'ml-ds';
  }

  return 'general-ds';
}

export function getEnabledSearchBoards(profile) {
  return (profile.jobBoards ?? []).filter(
    (board) => board.enabled && board.type === 'search'
  );
}

export function getCredentialForUrl(profile, targetUrl) {
  const match = (profile.jobBoards ?? []).find((board) => {
    if (!board.domain) {
      return false;
    }
    return targetUrl.includes(board.domain);
  });

  if (match?.email && match?.password) {
    return {
      email: match.email,
      password: match.password
    };
  }

  if (profile.credentials?.default?.email && profile.credentials?.default?.password) {
    return {
      email: profile.credentials.default.email,
      password: profile.credentials.default.password
    };
  }

  return null;
}

export function preferredResumePath(profile, roleType, tailoredResumePath = '') {
  if (tailoredResumePath) {
    return resolveRepoPath(tailoredResumePath);
  }

  const candidate =
    profile.personal?.resumes?.[roleType] ??
    profile.personal?.resumes?.default;

  return resolveRepoPath(candidate);
}

export function resolveOpenAIConfig(profile = {}) {
  const openai = profile.openai ?? {};
  const apiKeyEnvVar = String(openai.apiKeyEnvVar ?? 'OPENAI_API_KEY').trim() || 'OPENAI_API_KEY';
  const model = String(openai.model ?? 'gpt-5.4-mini').trim() || 'gpt-5.4-mini';
  const reasoningEffort = String(openai.reasoningEffort ?? 'medium').trim() || 'medium';
  const maxBulletEdits = Math.max(1, Number(openai.maxBulletEdits ?? 4) || 4);
  const maxBulletsPerEntry = Math.max(1, Number(openai.maxBulletsPerEntry ?? 2) || 2);
  const maxExtraCharsPerBullet = Math.max(10, Number(openai.maxExtraCharsPerBullet ?? 36) || 36);
  const maxTotalAddedChars = Math.max(20, Number(openai.maxTotalAddedChars ?? 120) || 120);

  return {
    enabled: openai.enabled === true,
    apiKeyEnvVar,
    apiKey: process.env[apiKeyEnvVar] ?? '',
    model,
    reasoningEffort,
    maxBulletEdits,
    maxBulletsPerEntry,
    maxExtraCharsPerBullet,
    maxTotalAddedChars
  };
}

export async function ensureWorkingDirs() {
  await ensureDir(path.join(repoRoot, 'runs'));
  await ensureDir(path.join(repoRoot, 'resumes', 'tailored'));
}

export function estimateYearsExperience(resumeText) {
  const years = [...resumeText.matchAll(/\b(20\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= 2000 && year <= new Date().getFullYear());

  if (years.length === 0) {
    return 3;
  }

  const earliest = Math.min(...years);
  return Math.max(1, new Date().getFullYear() - earliest);
}

export function parseSearchQuery(query) {
  const normalized = normalizeWhitespace(query);
  const remoteMatch = /\bremote\b/i.test(normalized);
  const parts = normalized.split(/\s+/);
  const locationTokens = [];
  const keywordTokens = [];

  for (const token of parts) {
    if (/^(remote|ny|nj|ca|ma|me|tx|wa)$/i.test(token)) {
      locationTokens.push(token);
    } else {
      keywordTokens.push(token);
    }
  }

  return {
    raw: normalized,
    keywords: normalizeWhitespace(
      keywordTokens.filter((token) => !/^remote$/i.test(token)).join(' ')
    ),
    location: remoteMatch
      ? 'remote'
      : normalizeWhitespace(locationTokens.join(' ')),
    remote: remoteMatch
  };
}
