#!/usr/bin/env node

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyToJob } from './lib/apply.mjs';
import {
  ensureWorkingDirs,
  getEnabledSearchBoards,
  loadProfile,
  readResumeText,
  repoRoot,
  resolveRepoPath
} from './lib/config.mjs';
import { launchBrowserContext } from './lib/browser.mjs';
import { saveRun, createRunFile, wasAlreadyApplied } from './lib/runs.mjs';
import { scoreJob } from './lib/scoring.mjs';
import {
  renderSearchLinks,
  renderSearchTable,
  searchJobs,
  fetchJobDetailsFromUrl
} from './lib/search.mjs';
import { bootstrapOverleafSession, tailorJob } from './lib/tailor.mjs';
import {
  canonicalizeJobUrl,
  getDirectApplyTier,
  getUrlHostname,
  normalizeWhitespace,
  prompt,
  resolveEffectiveApplyUrl,
  truncate,
  uniqueBy
} from './lib/utils.mjs';

const execFileAsync = promisify(execFile);

function parseCliArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { positional, flags };
}

function printHelp() {
  console.log(`Standalone JobPilot CLI

Usage:
  node standalone/jobpilot.mjs setup [--bootstrap-overleaf] [--bootstrap-codex]
  node standalone/jobpilot.mjs overleaf-login
  node standalone/jobpilot.mjs search-bootstrap
  node standalone/jobpilot.mjs search "<query>" [--limit 12] [--headless] [--search-mode direct-ats-first]
  node standalone/jobpilot.mjs tailor <job-url> [--headless] [--no-download]
  node standalone/jobpilot.mjs apply <job-url> [--submit] [--tailor] [--resume resume.pdf] [--headless]
  node standalone/jobpilot.mjs autopilot "<query>" [--yes] [--submit] [--resume resume.pdf] [--headless] [--limit 10] [--search-mode direct-ats-first] [--apply-surface-policy external-only]
  node standalone/jobpilot.mjs autopilot "manual batch" --file jobs-to-apply.txt [--yes] [--submit] [--resume resume.pdf]
  node standalone/jobpilot.mjs autorun
`);
}

async function runPowerShellScript(scriptName) {
  const scriptPath = path.join(repoRoot, 'scripts', scriptName);
  await execFileAsync('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    cwd: repoRoot
  });
}

async function loadJobFromInput(context, input) {
  if (/^https?:\/\//i.test(input)) {
    return fetchJobDetailsFromUrl(context, input);
  }

  throw new Error('Only URL input is supported in standalone mode right now.');
}

async function commandSetup(flags) {
  await ensureWorkingDirs();
  await runPowerShellScript('check-setup.ps1');
  if (flags['bootstrap-overleaf']) {
    await runPowerShellScript('overleaf-bootstrap.ps1');
  }
  if (flags['bootstrap-codex']) {
    await runPowerShellScript('codex-bootstrap.ps1');
  }
}

async function commandOverleafLogin(flags) {
  const { profile } = await loadProfile();
  const context = await launchBrowserContext({ headless: Boolean(flags.headless) });

  try {
    await bootstrapOverleafSession({
      profile,
      headless: Boolean(flags.headless),
      context,
      allowManualPrompt: true
    });
    console.log('\nOverleaf session is ready in the persistent browser profile.');
  } finally {
    await context.close().catch(() => {});
  }
}

async function commandSearchBootstrap() {
  const { profile } = await loadProfile();
  const boards = getEnabledSearchBoards(profile);
  const context = await launchBrowserContext({ headless: false });

  try {
    for (const board of boards) {
      if (!board.searchUrl) {
        continue;
      }

      const page = await context.newPage();
      await page.goto(board.searchUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      console.log(`Opened ${board.name}: ${board.searchUrl}`);
    }

    console.log('\nComplete any login or bot-verification steps in the opened browser tabs.');
    console.log('When the search sites look normal, close the browser window to finish bootstrap.');

    await new Promise((resolve) => context.browser()?.once('disconnected', resolve));
  } finally {
    await context.close().catch(() => {});
  }
}

async function commandSearch(query, flags) {
  const { profile } = await loadProfile();
  await ensureWorkingDirs();
  const { text: resumeText } = await readResumeText(profile);
  const context = await launchBrowserContext({ headless: Boolean(flags.headless) });
  const standaloneConfig = profile.standalone ?? {};

  try {
    const jobs = await searchJobs({
      context,
      profile,
      query,
      limit: Number(flags.limit ?? 12),
      resumeText
    });
    const rankedJobs = rankSearchResults(
      jobs,
      flags['search-mode'] ?? standaloneConfig.searchMode,
      resolvePreferredAtsDomains(standaloneConfig)
    );
    console.log(`\nSearch results for "${query}"\n`);
    console.log(renderSearchTable(rankedJobs));
    if (rankedJobs.length > 0) {
      console.log('\nTop links:\n');
      console.log(renderSearchLinks(rankedJobs));
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function loadJobsFromUrlFile({ context, filePath, resumeText, query }) {
  const resolvedPath = resolveRepoPath(filePath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const urls = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const jobs = [];
  for (const url of urls) {
    const job = await fetchJobDetailsFromUrl(context, url);
    const scored = scoreJob({
      resumeText,
      title: job.title,
      description: job.description,
      query
    });
    const alreadyApplied = await wasAlreadyApplied(url);
    jobs.push({
      id: jobs.length + 1,
      ...job,
      sourceUrl: job.sourceUrl || url,
      status: alreadyApplied ? 'skipped' : 'pending',
      stage: alreadyApplied ? 'skipped' : 'discovered',
      skipReason: alreadyApplied ? 'Already applied' : '',
      skipCategory: alreadyApplied ? 'duplicate' : '',
      matchScore: scored.score,
      matchReason: scored.reason,
      matchedKeywords: scored.matchedKeywords,
      missingKeywords: scored.missingKeywords
    });
  }

  jobs.sort((a, b) => b.matchScore - a.matchScore);
  jobs.forEach((job, index) => {
    job.id = index + 1;
  });
  return jobs;
}

async function commandTailor(input, flags) {
  const { profile } = await loadProfile();
  const context = await launchBrowserContext({ headless: Boolean(flags.headless) });

  try {
    const job = await loadJobFromInput(context, input);
    const result = await tailorJob({
      profile,
      job,
      headless: Boolean(flags.headless),
      downloadPdf: !Boolean(flags['no-download']),
      context
    });

    console.log(`\nTailored ${job.title} at ${job.company}`);
    console.log(`Role type: ${result.roleType}`);
    console.log(`Template: ${result.texFile}`);
    console.log(
      `Tailoring method: ${result.tailoringMethod}${result.modelUsed ? ` (${result.modelUsed})` : ''}`
    );
    console.log(`Added keywords: ${result.addedKeywords.join(', ') || 'none'}`);
    if (result.tailoringSummary) {
      console.log(`Tailoring summary: ${result.tailoringSummary}`);
    }
    if (result.tailoringWarning) {
      console.log(`Tailoring warning: ${result.tailoringWarning}`);
    }
    console.log(`Tag: ${result.tag}`);
    if (result.tailoredResumePath) {
      console.log(`PDF: ${result.tailoredResumePath}`);
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function commandApply(input, flags) {
  const { profile } = await loadProfile();
  const { text: resumeText } = await readResumeText(profile);
  const context = await launchBrowserContext({ headless: Boolean(flags.headless) });
  const standaloneConfig = profile.standalone ?? {};
  const requiredTailoringProvider = resolveRequiredTailoringProvider(standaloneConfig, flags);

  try {
    const job = await loadJobFromInput(context, input);
    let tailoredResumePath = '';
    if (flags.tailor || profile.overleaf?.tailorResume) {
      const tailored = await tailorJob({
        profile,
        job,
        headless: Boolean(flags.headless),
        downloadPdf: true,
        context
      });
      const tailoringCheck = validateTailoringForApply(tailored, requiredTailoringProvider);
      if (!tailoringCheck.ok) {
        throw new Error(tailoringCheck.message);
      }
      tailoredResumePath = tailored.tailoredResumePath;
    }

    const result = await applyToJob({
      profile,
      url: input,
      job,
      submit: Boolean(flags.submit),
      autoConfirm: false,
      headless: Boolean(flags.headless),
      tailoredResumePath,
      context,
      resumeText,
      resumePathOverride: flags.resume ? resolveRepoPath(flags.resume) : ''
    });

    console.log(`\nApply status: ${result.status}`);
    console.log(`Role: ${result.job.title || 'unknown'}`);
    console.log(`Company: ${result.job.company || 'unknown'}`);
    console.log(`Resume: ${result.resumePath || 'none'}`);
    console.log(`Filled fields: ${result.filledFields.length}`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function promptForApproval(jobs) {
  console.log(`\nTop matches:\n`);
  console.log(renderSearchTable(jobs));
  const answer = await prompt(
    '\nApprove jobs with "go", "go 1,3", or "stop": '
  );
  return answer;
}

function resolveEntryLevelMaxYears(standaloneConfig = {}) {
  const value = Number(standaloneConfig.entryLevelMaxYears ?? 3);
  if (!Number.isFinite(value) || value < 0) {
    return 3;
  }

  return value;
}

function extractRequiredYears(description = '') {
  const normalized = String(description ?? '').toLowerCase();
  const matches = [
    ...normalized.matchAll(
      /(\d+)(?:\s*(?:-|\bto\b)\s*(\d+))?\s*\+?\s+years?(?:\s+of)?\s+experience/gi
    )
  ];

  if (matches.length === 0) {
    return null;
  }

  return Math.max(
    ...matches.map((match) =>
      Math.max(Number(match[1] ?? 0), Number(match[2] ?? match[1] ?? 0))
    )
  );
}

function titleMatchesEntryLevel(title, standaloneConfig = {}) {
  if (!standaloneConfig.entryLevelOnly) {
    return true;
  }

  const normalized = String(title ?? '').toLowerCase();
  const blockedPatterns = [
    /\bsenior\b/i,
    /\bsr\.?\b/i,
    /\bstaff\b/i,
    /\bprincipal\b/i,
    /\blead\b/i,
    /\bmanager\b/i,
    /\bdirector\b/i,
    /\bhead\b/i,
    /\bvice president\b/i,
    /\bvp\b/i,
    /\bmid[-\s]?level\b/i,
    /\blevel\s*[2-9]\b/i,
    /\bii\b/i,
    /\biii\b/i,
    /\biv\b/i
  ];

  return !blockedPatterns.some((pattern) => pattern.test(normalized));
}

function yearsMatchEntryLevel(job, standaloneConfig = {}) {
  if (!standaloneConfig.entryLevelOnly) {
    return true;
  }

  const requiredYears = extractRequiredYears(job.description);
  if (requiredYears === null) {
    return true;
  }

  return requiredYears <= resolveEntryLevelMaxYears(standaloneConfig);
}

function locationMatches(job, standaloneConfig = {}, profile = {}) {
  const preferred =
    standaloneConfig.preferredLocations ??
    profile.workAuthorization?.preferredLocations ??
    [];

  if (!preferred || preferred.length === 0 || preferred.includes('Anywhere')) {
    return true;
  }

  const normalizedLocation = String(job.location ?? '').toLowerCase();
  if (!normalizedLocation) {
    return true;
  }
  if (normalizedLocation.includes('remote')) {
    return true;
  }

  return preferred.some((location) =>
    normalizedLocation.includes(String(location).toLowerCase())
  );
}

function resolveRequireDirectApply(standaloneConfig = {}, flags = {}) {
  if (typeof standaloneConfig.requireDirectApply === 'boolean') {
    return standaloneConfig.requireDirectApply;
  }

  return Boolean(flags.submit) || Boolean(flags.headless) || Boolean(flags.yes);
}

function resolveApplySurfacePolicy(standaloneConfig = {}, flags = {}) {
  const configured = String(
    flags['apply-surface-policy'] ?? standaloneConfig.applySurfacePolicy ?? 'external-only'
  )
    .trim()
    .toLowerCase();

  if (configured === 'external-only') {
    return 'external-only';
  }

  if (configured === 'any-direct') {
    return 'any-direct';
  }

  return 'external-only';
}

function resolveSearchMode(rawValue = 'balanced') {
  const normalized = String(rawValue ?? 'balanced').trim().toLowerCase();
  if (normalized === 'direct-ats-first') {
    return 'direct-ats-first';
  }

  return 'balanced';
}

function resolvePreferredAtsDomains(standaloneConfig = {}) {
  const configured = Array.isArray(standaloneConfig.preferredAtsDomains)
    ? standaloneConfig.preferredAtsDomains
    : [];

  if (configured.length > 0) {
    return configured
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter(Boolean);
  }

  return [
    'greenhouse.io',
    'lever.co',
    'myworkdayjobs.com',
    'myworkdaysite.com',
    'workdayjobs.com'
  ];
}

function resolveRequiredTailoringProvider(standaloneConfig = {}, flags = {}) {
  const explicit = String(
    flags['require-tailoring-provider'] ??
      standaloneConfig.requireTailoringProvider ??
      ''
  )
    .trim()
    .toLowerCase();

  if (['codex-cli', 'openai', 'ai-agent'].includes(explicit)) {
    return explicit;
  }

  if (typeof flags['require-openai-tailoring'] === 'boolean') {
    return Boolean(flags['require-openai-tailoring']) ? 'ai-agent' : '';
  }

  if (typeof standaloneConfig.requireOpenAITailoring === 'boolean') {
    return standaloneConfig.requireOpenAITailoring ? 'ai-agent' : '';
  }

  return '';
}

function resolveRunLoopMode(standaloneConfig = {}, flags = {}) {
  const configured = String(flags['run-loop-mode'] ?? standaloneConfig.runLoopMode ?? 'one-pass')
    .trim()
    .toLowerCase();

  return configured === 'one-pass' ? 'one-pass' : 'one-pass';
}

function resolveFailurePolicy(standaloneConfig = {}, flags = {}) {
  const configured = String(
    flags['failure-policy'] ?? standaloneConfig.failurePolicy ?? 'continue-and-log'
  )
    .trim()
    .toLowerCase();

  return configured === 'continue-and-log' ? 'continue-and-log' : 'continue-and-log';
}

function withJobApplyMetadata(job, preferredDomains = []) {
  const applyUrl = resolveEffectiveApplyUrl(job);
  return {
    ...job,
    applyUrl,
    applyTier: getDirectApplyTier(applyUrl, preferredDomains),
    applyHost: getUrlHostname(applyUrl)
  };
}

function buildSkippedJob(job, reason, skipCategory = 'filters', preferredDomains = []) {
  const enriched = withJobApplyMetadata(job, preferredDomains);
  return {
    ...enriched,
    status: 'skipped',
    stage: 'skipped',
    skipReason: reason,
    skipCategory,
    failStage: '',
    failReason: ''
  };
}

function classifyTailoringFailureStage(errorMessage = '') {
  const normalized = String(errorMessage ?? '').toLowerCase();
  if (
    normalized.includes('did not produce a pdf') ||
    normalized.includes('compiled pdf') ||
    normalized.includes('download the compiled pdf') ||
    normalized.includes('overleaf editor did not finish loading') ||
    normalized.includes('overleaf website login requires manual verification')
  ) {
    return 'pdf_generation';
  }

  return 'tailoring';
}

function classifyApplyFailureStage(result = {}) {
  return 'application';
}

function classifyHostBlockReason(result = {}) {
  const status = String(result.status ?? '').toLowerCase();
  const failReason = String(result.failReason ?? result.status ?? '').trim();

  if (['verification-required', 'manual-step-required', 'login-required'].includes(status)) {
    return failReason || 'Manual verification or login is required on this host.';
  }

  if (status === 'incomplete') {
    return 'The unattended application flow stalled as incomplete on this host.';
  }

  return '';
}

function validateTailoringForApply(tailored, requiredProvider = '') {
  if (!tailored) {
    return {
      ok: false,
      message: 'Resume tailoring did not return a result.'
    };
  }

  if (!tailored.tailoredResumePath) {
    return {
      ok: false,
      message: 'Resume tailoring did not produce a PDF.'
    };
  }

  if (!requiredProvider) {
    return {
      ok: true,
      message: ''
    };
  }

  const method = String(tailored.tailoringMethod ?? '').toLowerCase();
  const providerSatisfied =
    requiredProvider === 'ai-agent'
      ? method === 'openai' || method === 'codex-cli'
      : method === requiredProvider;

  if (!providerSatisfied) {
    const warning = tailored.tailoringWarning ? ` ${tailored.tailoringWarning}` : '';
    return {
      ok: false,
      message: `${requiredProvider} tailoring is required for this run, but the result used ${tailored.tailoringMethod}.${warning}`.trim()
    };
  }

  return {
    ok: true,
    message: ''
  };
}

function rankSearchResults(jobs, rawSearchMode = 'balanced', preferredDomains = []) {
  const searchMode = resolveSearchMode(rawSearchMode);
  const enrichedJobs = jobs.map((job) => withJobApplyMetadata(job, preferredDomains));
  if (searchMode !== 'direct-ats-first') {
    return enrichedJobs;
  }

  return [...enrichedJobs]
    .sort((left, right) => {
      const tierDiff = (right.applyTier ?? 0) - (left.applyTier ?? 0);
      if (tierDiff !== 0) {
        return tierDiff;
      }

      const scoreDiff = (right.matchScore ?? 0) - (left.matchScore ?? 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return String(left.title ?? '').localeCompare(String(right.title ?? ''));
    })
    .map((job, index) => ({
      ...job,
      id: index + 1
    }));
}

function applyAutopilotFilters(
  jobs,
  profile,
  standaloneConfig = {},
  minMatchScore = 6,
  options = {}
) {
  const titleKeywords = [
    ...(profile.autopilot?.skipTitleKeywords ?? []),
    ...(standaloneConfig.skipTitleKeywords ?? [])
  ].map((value) => String(value).toLowerCase());
  const requireDirectApply = Boolean(options.requireDirectApply);
  const applySurfacePolicy = options.applySurfacePolicy ?? 'external-only';
  const preferredDomains = options.preferredAtsDomains ?? [];

  return jobs.map((job) => {
    if (job.status === 'skipped') {
      return withJobApplyMetadata(job, preferredDomains);
    }

    const enrichedJob = withJobApplyMetadata(job, preferredDomains);
    const normalizedTitle = String(job.title ?? '').toLowerCase();
    const blockedKeyword = titleKeywords.find((keyword) => normalizedTitle.includes(keyword));
    if (blockedKeyword) {
      return buildSkippedJob(
        enrichedJob,
        `Title contains blocked keyword: ${blockedKeyword}`,
        'filters',
        preferredDomains
      );
    }

    if (!titleMatchesEntryLevel(job.title, standaloneConfig)) {
      return buildSkippedJob(
        enrichedJob,
        'Filtered out by entry-level only mode',
        'filters',
        preferredDomains
      );
    }

    if (!yearsMatchEntryLevel(job, standaloneConfig)) {
      return buildSkippedJob(
        enrichedJob,
        `Requires more than ${resolveEntryLevelMaxYears(standaloneConfig)} years of experience`,
        'filters',
        preferredDomains
      );
    }

    if (!locationMatches(job, standaloneConfig, profile)) {
      return buildSkippedJob(
        enrichedJob,
        'Outside preferred locations',
        'filters',
        preferredDomains
      );
    }

    if (
      (applySurfacePolicy === 'external-only' || requireDirectApply) &&
      !enrichedJob.applyUrl
    ) {
      return buildSkippedJob(
        enrichedJob,
        'No direct external apply URL extracted from the listing',
        'no-direct-apply',
        preferredDomains
      );
    }

    if (job.matchScore < minMatchScore) {
      return buildSkippedJob(
        enrichedJob,
        `Below minimum match score (${job.matchScore} < ${minMatchScore})`,
        'filters',
        preferredDomains
      );
    }

    return {
      ...enrichedJob,
      status: 'pending',
      stage: 'qualified',
      skipReason: '',
      skipCategory: '',
      failStage: '',
      failReason: ''
    };
  });
}

function normalizeQueries(value) {
  if (Array.isArray(value)) {
    return uniqueBy(
      value
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean),
      (entry) => entry.toLowerCase()
    );
  }

  const single = String(value ?? '').trim();
  return single ? [single] : [];
}

function defaultAutorunQueries() {
  return [
    'entry level data scientist',
    'entry level data analyst',
    'entry level product analyst',
    'entry level business analyst',
    'entry level analytics analyst',
    'early career machine learning engineer'
  ];
}

function resolveAutorunQueries(standaloneConfig = {}) {
  const configured = normalizeQueries(standaloneConfig.queries);
  if (configured.length > 0) {
    return configured;
  }

  const fallback = normalizeQueries(standaloneConfig.query);
  if (fallback.length > 0) {
    return fallback;
  }

  return defaultAutorunQueries();
}

function resolveMaxApplications(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return { unlimited: false, value: 5 };
  }

  if (value <= 0) {
    return { unlimited: true, value: Number.MAX_SAFE_INTEGER };
  }

  return { unlimited: false, value };
}

function resolvePerQuerySearchLimit(rawValue, maxApplications) {
  const explicit = Number(rawValue);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  if (!Number.isFinite(maxApplications) || maxApplications >= Number.MAX_SAFE_INTEGER) {
    return 12;
  }

  return Math.max(maxApplications + 4, 12);
}

function mergeSearchResults(jobs) {
  const byUrl = new Map();

  for (const job of jobs) {
    const canonicalPrimaryUrl = canonicalizeJobUrl(resolveEffectiveApplyUrl(job) || job.url);
    const canonicalSourceUrl = canonicalizeJobUrl(job.sourceUrl || job.url);
    const companyKey = normalizeWhitespace(job.company || 'unknown').toLowerCase();
    const titleKey = normalizeWhitespace(job.title || job.url).toLowerCase();
    const key = canonicalPrimaryUrl || canonicalSourceUrl || `${companyKey}::${titleKey}`;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, {
        ...job,
        sourceQueries: normalizeQueries(job.sourceQueries)
      });
      continue;
    }

    const mergedQueries = uniqueBy(
      [...normalizeQueries(existing.sourceQueries), ...normalizeQueries(job.sourceQueries)],
      (value) => value.toLowerCase()
    );
    const preferred = (job.matchScore ?? 0) > (existing.matchScore ?? 0) ? job : existing;

    byUrl.set(key, {
      ...preferred,
      sourceQueries: mergedQueries
    });
  }

  return [...byUrl.values()]
    .sort((left, right) => (right.matchScore ?? 0) - (left.matchScore ?? 0))
    .map((job, index) => ({
      ...job,
      id: index + 1
    }));
}

async function searchAcrossQueries({
  context,
  profile,
  queries,
  limit,
  resumeText,
  allowManualPrompt = true,
  searchMode = 'balanced',
  preferredAtsDomains = []
}) {
  const aggregated = [];

  for (const query of queries) {
    console.log(`Searching query: ${query}`);
    const jobs = await searchJobs({
      context,
      profile,
      query,
      limit,
      resumeText,
      allowManualPrompt,
      onProgress: (event) => {
        if (event.type === 'board-complete') {
          console.log(`  ${event.board}: ${event.count} hydrated jobs`);
        } else if (event.type === 'board-error') {
          console.log(`  ${event.board}: skipped (${event.error})`);
        }
      }
    });

    const rankedJobs = rankSearchResults(jobs, searchMode, preferredAtsDomains);
    const directApplyCount = rankedJobs.filter((job) => Boolean(job.applyUrl)).length;
    const preferredAtsCount = rankedJobs.filter(
      (job) => getDirectApplyTier(resolveEffectiveApplyUrl(job), preferredAtsDomains) >= 3
    ).length;
    console.log(
      `  Query summary: ${rankedJobs.length} candidates after board dedupe, ${directApplyCount} with direct external apply targets, ${preferredAtsCount} on preferred ATS hosts`
    );

    aggregated.push(
      ...rankedJobs.map((job) => ({
        ...job,
        sourceQueries: [query]
      }))
    );
  }

  return rankSearchResults(mergeSearchResults(aggregated), searchMode, preferredAtsDomains);
}

async function runAutopilot(profile, query, flags, standaloneConfig = {}) {
  const { text: resumeText } = await readResumeText(profile);
  const context = await launchBrowserContext({ headless: Boolean(flags.headless) });
  const allowManualPrompt = !(
    Boolean(flags.headless) &&
    Boolean(flags.submit) &&
    Boolean(flags.yes)
  );
  const maxApplicationsConfig = resolveMaxApplications(
    flags.limit ??
      standaloneConfig.maxApplicationsPerRun ??
      profile.autopilot?.maxApplicationsPerRun ??
      5
  );
  const maxApplications = maxApplicationsConfig.value;
  const minMatchScore = Number(profile.autopilot?.minMatchScore ?? 6);
  const queries = normalizeQueries(query);
  const runQuery =
    flags.file || queries.length === 1
      ? queries[0] || 'autorun'
      : `multi-query autorun (${queries.length} queries)`;
  const perQueryLimit = resolvePerQuerySearchLimit(
    flags['search-limit'] ?? standaloneConfig.searchLimitPerQuery,
    maxApplications
  );
  const requireDirectApply = resolveRequireDirectApply(standaloneConfig, flags);
  const applySurfacePolicy = resolveApplySurfacePolicy(standaloneConfig, flags);
  const searchMode = resolveSearchMode(flags['search-mode'] ?? standaloneConfig.searchMode);
  const preferredAtsDomains = resolvePreferredAtsDomains(standaloneConfig);
  const requiredTailoringProvider = resolveRequiredTailoringProvider(standaloneConfig, flags);
  const runLoopMode = resolveRunLoopMode(standaloneConfig, flags);
  const failurePolicy = resolveFailurePolicy(standaloneConfig, flags);

  const { runPath, run } = await createRunFile(runQuery, {
    minMatchScore,
    maxApplications: maxApplicationsConfig.unlimited ? 'all' : maxApplications,
    queries,
    searchLimitPerQuery: perQueryLimit,
    allowManualPrompt,
    runLoopMode,
    failurePolicy,
    requireDirectApply,
    applySurfacePolicy,
    searchMode,
    preferredAtsDomains,
    requiredTailoringProvider
  });

  try {
    const blockedApplyHosts = new Map();
    const jobs = flags.file
      ? await loadJobsFromUrlFile({
          context,
          filePath: flags.file,
          resumeText,
          query: runQuery
        })
      : await searchAcrossQueries({
          context,
          profile,
          queries,
          limit: perQueryLimit,
          resumeText,
          allowManualPrompt,
          searchMode,
          preferredAtsDomains
        });

    run.jobs = rankSearchResults(
      applyAutopilotFilters(jobs, profile, standaloneConfig, minMatchScore, {
        requireDirectApply,
        applySurfacePolicy,
        preferredAtsDomains
      }),
      searchMode,
      preferredAtsDomains
    );
    await saveRun(runPath, run);

    const pendingCandidates = run.jobs.filter((job) => job.status === 'pending');
    const approvedCandidates = maxApplicationsConfig.unlimited
      ? pendingCandidates
      : pendingCandidates.slice(0, maxApplications);

    if (approvedCandidates.length === 0) {
      console.log('No jobs met the current autopilot filters.');
      run.status = 'completed';
      run.completedAt = new Date().toISOString();
      await saveRun(runPath, run);
      return;
    }

    const directApplyCount = approvedCandidates.filter((job) => Boolean(job.applyUrl)).length;
    const preferredAtsCount = approvedCandidates.filter((job) => (job.applyTier ?? 0) >= 3).length;
    console.log(
      `Qualified ${approvedCandidates.length} jobs for apply. ${directApplyCount} have direct external apply targets, ${preferredAtsCount} are on preferred ATS hosts.`
    );

    let approvedIds = approvedCandidates.map((job) => job.id);
    if (!flags.yes) {
      const answer = await promptForApproval(approvedCandidates);
      if (/^stop$/i.test(answer)) {
        run.status = 'paused';
        await saveRun(runPath, run);
        console.log(`Run paused: ${runPath}`);
        return;
      }
      const subsetMatch = answer.match(/^go\s+(.+)$/i);
      if (subsetMatch) {
        approvedIds = subsetMatch[1]
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isFinite(value));
      }
    }

    for (const job of run.jobs) {
      if (approvedIds.includes(job.id) && job.status === 'pending') {
        job.status = 'approved';
        job.stage = 'qualified';
      } else if (job.status === 'pending') {
        job.status = 'skipped';
        job.stage = 'skipped';
        job.skipReason = 'Not selected for this run';
        job.skipCategory = 'not-selected';
      }
    }

    await saveRun(runPath, run);

    const approvedJobs = run.jobs.filter((entry) => entry.status === 'approved');
    for (const [index, job] of approvedJobs.entries()) {
      const applyTargetUrl = resolveEffectiveApplyUrl(job);
      const applyHost = getUrlHostname(applyTargetUrl);
      if (applyHost && blockedApplyHosts.has(applyHost)) {
        job.status = 'skipped';
        job.stage = 'skipped';
        job.skipCategory = 'host-blocked';
        job.skipReason = `Skipped because ${applyHost} already failed in unattended mode: ${blockedApplyHosts.get(applyHost)}`;
        await saveRun(runPath, run);
        console.log(
          `Skipping ${truncate(job.title, 56)} at ${truncate(job.company, 32)} because ${applyHost} was already blocked earlier in this run.`
        );
        continue;
      }

      console.log(
        `Applying ${index + 1}/${approvedJobs.length}: ${truncate(job.title, 56)} at ${truncate(job.company, 32)}`
      );
      if (applyTargetUrl) {
        job.applyUrl = applyTargetUrl;
        console.log(`  Apply target URL: ${applyTargetUrl}`);
        if (applyHost) {
          job.applyHost = applyHost;
          console.log(`  Apply host: ${applyHost}`);
        }
      } else {
        console.log(`  Source URL: ${job.url}`);
      }

      job.status = 'applying';
      job.stage = 'tailoring_started';
      job.failStage = '';
      job.failReason = '';
      await saveRun(runPath, run);

      let tailoredResumePath = '';
      if (profile.overleaf?.tailorResume) {
        try {
          console.log('  Tailoring resume...');
          const tailored = await tailorJob({
            profile,
            job,
            headless: Boolean(flags.headless),
            downloadPdf: true,
            context,
            allowManualPrompt
          });
          const tailoringCheck = validateTailoringForApply(tailored, requiredTailoringProvider);
          if (!tailoringCheck.ok) {
            throw new Error(tailoringCheck.message);
          }
          tailoredResumePath = tailored.tailoredResumePath;
          job.tailoringMethod = tailored.tailoringMethod;
          job.modelUsed = tailored.modelUsed || '';
          job.tailoringSummary = tailored.tailoringSummary || '';
          job.tailoredResumePath = tailored.tailoredResumePath || '';
          job.tailorWarning = tailored.tailoringWarning || '';
          job.stage = 'pdf_ready';
          await saveRun(runPath, run);
          console.log(
            `  Tailor complete: ${tailored.roleType}, ${tailored.addedKeywords.length} keyword updates, ${tailored.tailoringMethod}${tailored.modelUsed ? ` (${tailored.modelUsed})` : ''}`
          );
          if (tailored.tailoringWarning) {
            console.log(`  Tailor warning: ${tailored.tailoringWarning}`);
          }
        } catch (error) {
          job.tailorWarning = error.message;
          console.log(`  Tailor warning: ${error.message}`);
          job.status = 'failed';
          job.stage = 'tailoring_failed';
          job.failStage = classifyTailoringFailureStage(error.message);
          job.failReason = error.message;
          await saveRun(runPath, run);
          continue;
        }
      }

      console.log('  Filling application...');
      job.stage = 'apply_started';
      await saveRun(runPath, run);
      const result = await applyToJob({
        profile,
        url: job.url,
        job,
        submit: Boolean(flags.submit),
        autoConfirm: true,
        headless: Boolean(flags.headless),
        tailoredResumePath,
        context,
        resumeText,
        resumePathOverride: flags.resume ? resolveRepoPath(flags.resume) : '',
        allowManualPrompt,
        runId: run.runId,
        source: 'standalone-autorun'
      });

      job.result = result.status;
      job.tailoredResumePath ||= result.resumePath || '';
      if (result.status === 'applied' || result.status === 'submitted-unknown') {
        job.status = 'applied';
        job.stage = 'applied';
        job.appliedAt = new Date().toISOString();
        job.failStage = '';
        job.failReason = '';
        console.log(`  Result: ${result.status}`);
      } else if (result.status === 'cancelled') {
        job.status = 'skipped';
        job.stage = 'skipped';
        job.skipReason = 'Cancelled during apply';
        job.skipCategory = 'cancelled';
        console.log('  Result: cancelled');
      } else {
        job.status = 'failed';
        job.stage = 'failed';
        job.failStage = classifyApplyFailureStage(result);
        job.failReason = result.failReason || result.status;
        const hostBlockReason = applyHost ? classifyHostBlockReason(result) : '';
        if (applyHost && hostBlockReason) {
          blockedApplyHosts.set(applyHost, hostBlockReason);
        }
        console.log(`  Result: failed (${job.failReason})`);
      }

      await saveRun(runPath, run);
    }

    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    await saveRun(runPath, run);

    console.log(`\nAutopilot run saved to ${runPath}`);
    console.log(
      `Summary: discovered ${run.summary.totalFound}, qualified ${run.summary.qualified}, applied ${run.summary.applied}, failed ${run.summary.failed}, skipped ${run.summary.skipped}`
    );
    console.log(
      run.jobs
        .map(
          (job) =>
            `${job.id}. ${truncate(job.title, 48)} | ${job.status} | ${job.stage}${job.failReason ? ` | ${job.failReason}` : ''}`
        )
        .join('\n')
    );
  } finally {
    await context.close().catch(() => {});
  }
}

async function commandAutopilot(query, flags) {
  const { profile } = await loadProfile();
  await runAutopilot(profile, query, flags, profile.standalone ?? {});
}

async function commandAutorun() {
  const { profile } = await loadProfile();
  const standaloneConfig = profile.standalone ?? {};

  if (standaloneConfig.enabled === false) {
    throw new Error('profile.json standalone.enabled is false.');
  }

  const query =
    standaloneConfig.mode === 'file'
      ? normalizeQueries(standaloneConfig.query ?? 'manual batch')
      : resolveAutorunQueries(standaloneConfig);

  const flags = {
    yes: standaloneConfig.autoApprove ?? true,
    submit: standaloneConfig.autoSubmit ?? true,
    headless: standaloneConfig.headless ?? true,
    limit:
      standaloneConfig.maxApplicationsPerRun ??
      profile.autopilot?.maxApplicationsPerRun ??
      5,
    file: standaloneConfig.mode === 'file' ? standaloneConfig.filePath : '',
    resume: standaloneConfig.resumePath ?? '',
    'search-limit': standaloneConfig.searchLimitPerQuery ?? '',
    'search-mode': standaloneConfig.searchMode ?? '',
    'apply-surface-policy': standaloneConfig.applySurfacePolicy ?? '',
    'run-loop-mode': standaloneConfig.runLoopMode ?? '',
    'failure-policy': standaloneConfig.failurePolicy ?? '',
    'require-openai-tailoring': standaloneConfig.requireOpenAITailoring ?? '',
    'require-tailoring-provider': standaloneConfig.requireTailoringProvider ?? ''
  };

  await runAutopilot(profile, query, flags, standaloneConfig);
}

async function main() {
  const [, , command = 'help', ...rest] = process.argv;
  const { positional, flags } = parseCliArgs(rest);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    case 'setup':
      await commandSetup(flags);
      break;
    case 'search':
      if (positional.length === 0) {
        throw new Error('search requires a query string');
      }
      await commandSearch(positional.join(' '), flags);
      break;
    case 'search-bootstrap':
      await commandSearchBootstrap();
      break;
    case 'overleaf-login':
      await commandOverleafLogin(flags);
      break;
    case 'tailor':
      if (positional.length === 0) {
        throw new Error('tailor requires a job URL');
      }
      await commandTailor(positional[0], flags);
      break;
    case 'apply':
      if (positional.length === 0) {
        throw new Error('apply requires a job URL');
      }
      await commandApply(positional[0], flags);
      break;
    case 'autopilot':
      if (positional.length === 0) {
        throw new Error('autopilot requires a search query');
      }
      await commandAutopilot(positional.join(' '), flags);
      break;
    case 'autorun':
      await commandAutorun();
      break;
    default:
      printHelp();
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`\nStandalone JobPilot error: ${error.message}`);
  process.exitCode = 1;
});
