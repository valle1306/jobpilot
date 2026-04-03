import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== null) {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value, 'utf8');
}

function decodeUrlCandidate(value) {
  if (!value) {
    return '';
  }

  try {
    const decoded = decodeURIComponent(value);
    if (/^https?:\/\//i.test(decoded)) {
      return decoded;
    }
  } catch {
    // Fall back to the raw value below.
  }

  return /^https?:\/\//i.test(value) ? value : '';
}

function decodeEmbeddedText(value) {
  return String(value ?? '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
}

function trimTrailingUrlPunctuation(value) {
  return String(value ?? '').replace(/[)\]}",.;]+$/g, '');
}

const preferredAtsHostPatterns = [
  /(?:^|\.)greenhouse\.io$/i,
  /(?:^|\.)lever\.co$/i,
  /(?:^|\.)myworkdayjobs\.com$/i,
  /(?:^|\.)myworkdaysite\.com$/i,
  /(?:^|\.)workdayjobs\.com$/i
];

const atsHostPatterns = [
  ...preferredAtsHostPatterns,
  /(?:^|\.)ashbyhq\.com$/i,
  /(?:^|\.)smartrecruiters\.com$/i,
  /(?:^|\.)workable\.com$/i,
  /(?:^|\.)jobvite\.com$/i,
  /(?:^|\.)icims\.com$/i,
  /(?:^|\.)avature\.net$/i,
  /(?:^|\.)oraclecloud\.com$/i,
  /(?:^|\.)contacthr\.com$/i,
  /(?:^|\.)successfactors\.com$/i,
  /(?:^|\.)dayforcehcm\.com$/i,
  /(?:^|\.)bamboohr\.com$/i,
  /(?:^|\.)paylocity\.com$/i,
  /(?:^|\.)paycomonline\.net$/i,
  /(?:^|\.)taleo\.net$/i,
  /(?:^|\.)ultipro\.com$/i,
  /(?:^|\.)csod\.com$/i
];

export function extractExternalJobUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  try {
    const url = new URL(String(rawUrl).trim());
    const candidateKeys = [
      'url',
      'dest',
      'destination',
      'destinationUrl',
      'redirect',
      'redirectUrl',
      'redirect_uri',
      'target',
      'targetUrl',
      'applicationUrl',
      'externalJobUrl'
    ];

    for (const key of candidateKeys) {
      const candidate = decodeUrlCandidate(url.searchParams.get(key));
      if (candidate) {
        return candidate;
      }
    }

    return url.toString();
  } catch {
    return String(rawUrl).trim();
  }
}

export function getUrlHostname(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  try {
    const url = new URL(extractExternalJobUrl(rawUrl));
    return url.hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function extractKnownDirectJobUrl(rawText) {
  if (!rawText) {
    return '';
  }

  const text = decodeEmbeddedText(rawText);
  const patterns = [
    /https?:\/\/www\.linkedin\.com\/jobs\/view\/externalApply\?[^"'<>\\\s]+/gi,
    /https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/[^"'<>\\\s]+/gi,
    /https?:\/\/jobs\.lever\.co\/[^"'<>\\\s]+/gi,
    /https?:\/\/[a-z0-9.-]+(?:myworkdaysite\.com|myworkdayjobs\.com|workdayjobs\.com)\/[^"'<>\\\s]+/gi,
    /https?:\/\/jobs\.ashbyhq\.com\/[^"'<>\\\s]+/gi,
    /https?:\/\/careers\.smartrecruiters\.com\/[^"'<>\\\s]+/gi,
    /https?:\/\/apply\.workable\.com\/[^"'<>\\\s]+/gi,
    /https?:\/\/jobs\.jobvite\.com\/[^"'<>\\\s]+/gi,
    /https?:\/\/[a-z0-9.-]+\.icims\.com\/jobs\/[^"'<>\\\s]+/gi
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern)?.[0];
    if (!match) {
      continue;
    }

    const candidate = extractExternalJobUrl(trimTrailingUrlPunctuation(match));
    if (candidate && !isAggregatorUrl(candidate)) {
      return candidate;
    }
  }

  return '';
}

export function canonicalizeJobUrl(rawUrl) {
  if (!rawUrl) {
    return '';
  }

  const resolvedExternalUrl = extractExternalJobUrl(rawUrl);

  try {
    const url = new URL(resolvedExternalUrl);
    const hostname = url.hostname.toLowerCase();

    if (hostname.includes('linkedin.com') && url.pathname.includes('/jobs/view')) {
      return `${url.origin}${url.pathname}`;
    }

    if (hostname.includes('indeed.com') && url.pathname.includes('/viewjob')) {
      const jk = url.searchParams.get('jk');
      return jk ? `${url.origin}${url.pathname}?jk=${jk}` : `${url.origin}${url.pathname}`;
    }

    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'ref',
      'refId',
      'trackingId',
      'trk',
      'gh_src',
      'gh_jid'
    ];

    for (const key of trackingParams) {
      url.searchParams.delete(key);
    }

    url.hash = '';
    const query = url.searchParams.toString();
    return query ? `${url.origin}${url.pathname}?${query}` : `${url.origin}${url.pathname}`;
  } catch {
    return String(resolvedExternalUrl).trim();
  }
}

export function isAggregatorUrl(rawUrl) {
  if (!rawUrl) {
    return false;
  }

  try {
    const url = new URL(String(rawUrl).trim());
    const hostname = url.hostname.toLowerCase();
    return (
      hostname.includes('linkedin.com') ||
      hostname.includes('indeed.com') ||
      hostname.includes('glassdoor.com') ||
      hostname.includes('hiring.cafe')
    );
  } catch {
    return false;
  }
}

export function isPreferredAtsHost(hostname = '', preferredDomains = []) {
  const normalized = String(hostname ?? '').toLowerCase();
  if (!normalized) {
    return false;
  }

  const configured = preferredDomains.some((domain) => {
    const normalizedDomain = String(domain ?? '').toLowerCase().trim();
    return normalizedDomain && normalized.includes(normalizedDomain);
  });
  if (configured) {
    return true;
  }

  return preferredAtsHostPatterns.some((pattern) => pattern.test(normalized));
}

export function isAtsHost(hostname = '') {
  const normalized = String(hostname ?? '').toLowerCase();
  if (!normalized) {
    return false;
  }

  return atsHostPatterns.some((pattern) => pattern.test(normalized));
}

export function getDirectApplyTier(rawUrl, preferredDomains = []) {
  if (!rawUrl) {
    return 0;
  }

  if (isAggregatorUrl(rawUrl)) {
    return 0;
  }

  const hostname = getUrlHostname(rawUrl);
  if (!hostname) {
    return 0;
  }

  if (isPreferredAtsHost(hostname, preferredDomains)) {
    return 3;
  }

  if (isAtsHost(hostname)) {
    return 2;
  }

  return 1;
}

function collapseRepeatedLeadingPhrase(value) {
  const normalized = normalizeWhitespace(value);
  const repeated = normalized.match(/^(.{6,}?)\s+\1(?:\s+|$)(.*)$/i);
  if (!repeated) {
    return normalized;
  }

  const suffix = normalizeWhitespace(repeated[2] || '');
  return normalizeWhitespace(`${repeated[1]} ${suffix}`);
}

export function cleanJobTitle(value) {
  let normalized = normalizeWhitespace(value)
    .replace(/\bwith verification\b/gi, '')
    .replace(/\bverified job\b/gi, '')
    .replace(/\s+\|\s+linkedin$/i, '')
    .replace(/\s+on linkedin$/i, '')
    .trim();

  normalized = collapseRepeatedLeadingPhrase(normalized);
  return normalizeWhitespace(normalized);
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function nowIso() {
  return new Date().toISOString();
}

export function dateSlug() {
  return nowIso().slice(0, 10);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function prompt(question) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

export function truncate(value, length = 180) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= length) {
    return normalized;
  }
  return `${normalized.slice(0, length - 3)}...`;
}
