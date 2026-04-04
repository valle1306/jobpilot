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
  resolveCodexRunGuidanceConfig,
  resolveRepoPath,
  resolveStandaloneExecutionConfig
} from './lib/config.mjs';
import { launchBrowserContext } from './lib/browser.mjs';
import { shouldUseCodexApplyAssist } from './lib/codex-apply.mjs';
import { reviewAutopilotJobsWithCodexCli } from './lib/codex-review.mjs';
import {
  buildRunCompletionOverview,
  saveRun,
  createRunFile,
  wasAlreadyApplied
} from './lib/runs.mjs';
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
  node standalone/jobpilot.mjs search "<query>" [--limit 12] [--headless] [--browser chrome|edge] [--search-mode direct-ats-first] [--posted-within-hours 24]
  node standalone/jobpilot.mjs tailor <job-url> [--headless] [--browser chrome|edge] [--no-download]
  node standalone/jobpilot.mjs apply <job-url> [--submit] [--tailor] [--resume resume.pdf] [--headless] [--browser chrome|edge] [--execution-mode supervised|unattended-safe]
  node standalone/jobpilot.mjs autopilot "<query>" [--yes] [--submit] [--resume resume.pdf] [--headless] [--browser chrome|edge] [--execution-mode supervised|unattended-safe] [--limit 10] [--search-mode direct-ats-first] [--apply-surface-policy external-only] [--posted-within-hours 24]
  node standalone/jobpilot.mjs autopilot "manual batch" --file jobs-to-apply.txt [--yes] [--submit] [--resume resume.pdf]
  node standalone/jobpilot.mjs autorun
`);
}

function launchConfiguredBrowserContext(profile, flags = {}, overrides = {}) {
  const execution = resolveStandaloneExecutionConfig(profile, flags);
  return {
    execution,
    contextPromise: launchBrowserContext({
      headless:
        typeof overrides.headless === 'boolean' ? overrides.headless : execution.headless,
      browserName: overrides.browserName ?? execution.browserName,
      userDataDir: overrides.browserUserDataDir ?? execution.browserUserDataDir,
      profileDirectory:
        overrides.browserProfileDirectory ?? execution.browserProfileDirectory
    })
  };
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
  const { contextPromise, execution } = launchConfiguredBrowserContext(profile, flags, {
    headless: typeof flags.headless === 'boolean' ? Boolean(flags.headless) : false
  });
  const context = await contextPromise;

  try {
    await bootstrapOverleafSession({
      profile,
      headless: execution.headless,
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
  const { contextPromise } = launchConfiguredBrowserContext(profile, {}, { headless: false });
  const context = await contextPromise;

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
  const { contextPromise } = launchConfiguredBrowserContext(profile, flags);
  const context = await contextPromise;
  const standaloneConfig = profile.standalone ?? {};
  const postedWithinHours = resolvePostedWithinHours(standaloneConfig, flags);

  try {
    const jobs = await searchJobs({
      context,
      profile,
      query,
      limit: Number(flags.limit ?? 12),
      postedWithinHours,
      resumeText
    });
    const rankedJobs = rankSearchResults(
      jobs,
      flags['search-mode'] ?? standaloneConfig.searchMode,
      resolvePreferredAtsDomains(standaloneConfig)
    );
    const visibleJobs = rankedJobs.filter(
      (job) => !['duplicate', 'posted-age'].includes(job.skipCategory || '')
    );
    const hiddenOlderCount = rankedJobs.filter((job) => job.skipCategory === 'posted-age').length;
    const hiddenDuplicateCount = rankedJobs.filter((job) => job.skipCategory === 'duplicate').length;
    console.log(`\nSearch results for "${query}"\n`);
    if (postedWithinHours > 0) {
      console.log(`Filter: jobs posted within the last ${postedWithinHours} hours\n`);
    }
    if (hiddenOlderCount > 0 || hiddenDuplicateCount > 0) {
      console.log(
        `Hidden from the table: ${hiddenOlderCount} older than the posting window, ${hiddenDuplicateCount} already applied.\n`
      );
    }
    console.log(renderSearchTable(visibleJobs));
    if (visibleJobs.length > 0) {
      console.log('\nTop links:\n');
      console.log(renderSearchLinks(visibleJobs));
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
  const { contextPromise, execution } = launchConfiguredBrowserContext(profile, flags);
  const context = await contextPromise;

  try {
    const job = await loadJobFromInput(context, input);
    const result = await tailorJob({
      profile,
      job,
      headless: execution.headless,
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
  const { contextPromise, execution } = launchConfiguredBrowserContext(profile, flags);
  const context = await contextPromise;
  const standaloneConfig = profile.standalone ?? {};
  const requiredTailoringProvider = resolveRequiredTailoringProvider(standaloneConfig, flags);

  try {
    const job = await loadJobFromInput(context, input);
    let tailoredResumePath = '';
    if (flags.tailor || profile.overleaf?.tailorResume) {
      const tailored = await tailorJob({
        profile,
        job,
        headless: execution.headless,
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
      headless: execution.headless,
      tailoredResumePath,
      context,
      resumeText,
      resumePathOverride: flags.resume ? resolveRepoPath(flags.resume) : '',
      allowManualPrompt: execution.allowManualPrompt
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

function resolvePostedWithinHours(standaloneConfig = {}, flags = {}) {
  const value = Number(
    flags['posted-within-hours'] ?? standaloneConfig.postedWithinHours ?? 0
  );
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(value));
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

function hostMatchesPatterns(host = '', patterns = []) {
  const normalizedHost = String(host ?? '').trim().toLowerCase();
  if (!normalizedHost) {
    return false;
  }

  return patterns.some((pattern) => normalizedHost.includes(String(pattern ?? '').toLowerCase()));
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

function compareGuidedPriority(left, right) {
  const leftPriority = Number.isFinite(Number(left?.guidedPriority))
    ? Number(left.guidedPriority)
    : Number.MAX_SAFE_INTEGER;
  const rightPriority = Number.isFinite(Number(right?.guidedPriority))
    ? Number(right.guidedPriority)
    : Number.MAX_SAFE_INTEGER;

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return (right?.matchScore ?? 0) - (left?.matchScore ?? 0);
}

function buildAutopilotEligibility(job, profile, standaloneConfig = {}, minMatchScore = 6, options = {}) {
  const preferredDomains = options.preferredAtsDomains ?? [];
  const requireDirectApply = Boolean(options.requireDirectApply);
  const applySurfacePolicy = options.applySurfacePolicy ?? 'external-only';
  const unattendedSafeHostsOnly = Boolean(options.unattendedSafeHostsOnly);
  const unattendedSafeApplyHosts = options.unattendedSafeApplyHosts ?? [];
  const titleKeywords = [
    ...(profile.autopilot?.skipTitleKeywords ?? []),
    ...(standaloneConfig.skipTitleKeywords ?? [])
  ].map((value) => String(value).toLowerCase());

  const enrichedJob = withJobApplyMetadata(job, preferredDomains);
  if (job.status === 'skipped') {
    return {
      job: enrichedJob,
      hardBlocked: true,
      hardBlockCategory: job.skipCategory || 'skipped',
      hardBlockReason: job.skipReason || 'Skipped before autopilot review.',
      softWarnings: []
    };
  }

  const normalizedTitle = String(job.title ?? '').toLowerCase();
  const blockedKeyword = titleKeywords.find((keyword) => normalizedTitle.includes(keyword));
  const titleOk = !blockedKeyword && titleMatchesEntryLevel(job.title, standaloneConfig);
  const yearsOk = yearsMatchEntryLevel(job, standaloneConfig);
  const locationOk = locationMatches(job, standaloneConfig, profile);
  const scoreOk = (job.matchScore ?? 0) >= minMatchScore;
  const hasDirectApply = Boolean(enrichedJob.applyUrl);
  const codexAssistEligible = hasDirectApply
    ? shouldUseCodexApplyAssist(enrichedJob.applyUrl, profile)
    : false;
  const hostAllowed =
    !unattendedSafeHostsOnly ||
    !hasDirectApply ||
    hostMatchesPatterns(enrichedJob.applyHost, unattendedSafeApplyHosts) ||
    codexAssistEligible;

  let hardBlockReason = '';
  let hardBlockCategory = '';
  if ((applySurfacePolicy === 'external-only' || requireDirectApply) && !hasDirectApply) {
    hardBlockReason = 'No direct external apply URL extracted from the listing';
    hardBlockCategory = 'no-direct-apply';
  } else if (unattendedSafeHostsOnly && hasDirectApply && !hostAllowed) {
    hardBlockReason = `Apply host is outside the unattended-safe allowlist: ${enrichedJob.applyHost || 'unknown host'}`;
    hardBlockCategory = 'unattended-safe-host';
  }

  const softWarnings = [];
  if (blockedKeyword) {
    softWarnings.push(`Title contains blocked keyword: ${blockedKeyword}`);
  }
  if (!titleOk && !blockedKeyword) {
    softWarnings.push('Title looks above entry level');
  }
  if (!yearsOk) {
    softWarnings.push(
      `Requires more than ${resolveEntryLevelMaxYears(standaloneConfig)} years of experience`
    );
  }
  if (!locationOk) {
    softWarnings.push('Outside preferred locations');
  }
  if (!scoreOk) {
    softWarnings.push(`Below minimum heuristic match score (${job.matchScore ?? 0} < ${minMatchScore})`);
  }
  if (hasDirectApply && codexAssistEligible) {
    softWarnings.push('Needs Codex-assisted apply on a harder ATS host');
  }

  return {
    job: enrichedJob,
    hardBlocked: Boolean(hardBlockReason),
    hardBlockCategory,
    hardBlockReason,
    softWarnings,
    blockedKeyword,
    titleOk,
    yearsOk,
    locationOk,
    scoreOk,
    codexAssistEligible
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
  const preferredDomains = options.preferredAtsDomains ?? [];
  return jobs.map((job) => {
    const eligibility = buildAutopilotEligibility(
      job,
      profile,
      standaloneConfig,
      minMatchScore,
      options
    );

    if (eligibility.hardBlocked) {
      return buildSkippedJob(
        eligibility.job,
        eligibility.hardBlockReason,
        eligibility.hardBlockCategory || 'filters',
        preferredDomains
      );
    }

    if (eligibility.blockedKeyword) {
      return buildSkippedJob(
        eligibility.job,
        `Title contains blocked keyword: ${eligibility.blockedKeyword}`,
        'filters',
        preferredDomains
      );
    }

    if (!eligibility.titleOk) {
      return buildSkippedJob(
        eligibility.job,
        'Filtered out by entry-level only mode',
        'filters',
        preferredDomains
      );
    }

    if (!eligibility.yearsOk) {
      return buildSkippedJob(
        eligibility.job,
        `Requires more than ${resolveEntryLevelMaxYears(standaloneConfig)} years of experience`,
        'filters',
        preferredDomains
      );
    }

    if (!eligibility.locationOk) {
      return buildSkippedJob(
        eligibility.job,
        'Outside preferred locations',
        'filters',
        preferredDomains
      );
    }

    if (!eligibility.scoreOk) {
      return buildSkippedJob(
        eligibility.job,
        `Below minimum match score (${job.matchScore} < ${minMatchScore})`,
        'filters',
        preferredDomains
      );
    }

    return {
      ...eligibility.job,
      status: 'pending',
      stage: 'qualified',
      skipReason: '',
      skipCategory: '',
      failStage: '',
      failReason: ''
    };
  });
}

async function applyCodexGuidedSelection(
  jobs,
  profile,
  standaloneConfig = {},
  minMatchScore = 6,
  options = {}
) {
  const preferredDomains = options.preferredAtsDomains ?? [];
  const searchMode = options.searchMode ?? 'balanced';
  const maxApplications = Number(options.maxApplications ?? 5);
  const queryLabel = options.queryLabel ?? 'autorun';
  const resumeText = options.resumeText ?? '';
  const executionMode = options.executionMode ?? 'unattended-safe';
  const postedWithinHours = Number(options.postedWithinHours ?? 0);
  const guidanceConfig = options.guidanceConfig ?? { enabled: false };

  if (!guidanceConfig.enabled) {
    return {
      jobs: rankSearchResults(
        applyAutopilotFilters(jobs, profile, standaloneConfig, minMatchScore, options),
        searchMode,
        preferredDomains
      ),
      guidanceSummary: '',
      guidanceProvider: 'deterministic'
    };
  }

  const assessed = jobs.map((job) =>
    buildAutopilotEligibility(job, profile, standaloneConfig, minMatchScore, options)
  );
  const reviewable = rankSearchResults(
    assessed
      .filter((entry) => !entry.hardBlocked)
      .filter((entry) => (entry.job.matchScore ?? 0) >= guidanceConfig.rescueMinScore)
      .map((entry) => ({
        ...entry.job,
        hardBlocked: false,
        hardBlockReason: '',
        hardBlockCategory: '',
        softWarnings: entry.softWarnings,
        codexAssistEligible: entry.codexAssistEligible
      })),
    searchMode,
    preferredDomains
  ).slice(0, guidanceConfig.maxReviewJobs);

  if (reviewable.length === 0) {
    return {
      jobs: rankSearchResults(
        applyAutopilotFilters(jobs, profile, standaloneConfig, minMatchScore, options),
        searchMode,
        preferredDomains
      ),
      guidanceSummary: 'Codex-guided review had no reviewable jobs after hard safety checks.',
      guidanceProvider: 'deterministic'
    };
  }

  const reviewableIds = new Set(reviewable.map((job) => job.id));
  try {
    const review = await reviewAutopilotJobsWithCodexCli({
      profile,
      query: queryLabel,
      jobs: reviewable,
      resumeText,
      standaloneConfig,
      maxApplications,
      minMatchScore,
      executionMode,
      postedWithinHours,
      guidanceConfig
    });

    const selectedEntries = review.selected
      .filter((entry) => reviewableIds.has(entry.id))
      .sort((left, right) => left.priority - right.priority || left.id - right.id)
      .slice(0, maxApplications);
    const selectedIds = new Set(selectedEntries.map((entry) => entry.id));
    const selectedById = new Map(selectedEntries.map((entry) => [entry.id, entry]));

    const guidedJobs = assessed.map((entry) => {
      if (entry.hardBlocked) {
        return buildSkippedJob(
          entry.job,
          entry.hardBlockReason,
          entry.hardBlockCategory || 'filters',
          preferredDomains
        );
      }

      if (!reviewableIds.has(entry.job.id)) {
        return buildSkippedJob(
          entry.job,
          `Skipped before Codex-guided review because it ranked below the top ${guidanceConfig.maxReviewJobs} review candidates.`,
          'guidance-review-limit',
          preferredDomains
        );
      }

      if (!selectedIds.has(entry.job.id)) {
        return buildSkippedJob(
          entry.job,
          'Not selected by Codex-guided review for this run.',
          'guidance-skip',
          preferredDomains
        );
      }

      const decision = selectedById.get(entry.job.id);
      return {
        ...entry.job,
        status: 'pending',
        stage: 'qualified',
        skipReason: '',
        skipCategory: '',
        failStage: '',
        failReason: '',
        guidedPriority: decision?.priority ?? Number.MAX_SAFE_INTEGER,
        guidedReason: decision?.reason ?? '',
        guidanceProvider: 'codex-cli'
      };
    });

    return {
      jobs: rankSearchResults(guidedJobs, searchMode, preferredDomains),
      guidanceSummary: review.summary || 'Codex-guided review selected jobs for this run.',
      guidanceProvider: review.method || 'codex-cli'
    };
  } catch (error) {
    return {
      jobs: rankSearchResults(
        applyAutopilotFilters(jobs, profile, standaloneConfig, minMatchScore, options),
        searchMode,
        preferredDomains
      ),
      guidanceSummary: `Codex-guided review failed and the run fell back to deterministic filters: ${error.message}`,
      guidanceProvider: 'deterministic'
    };
  }
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
  postedWithinHours = 0,
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
      postedWithinHours,
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
    const eligibleJobs = rankedJobs.filter(
      (job) => !['duplicate', 'posted-age'].includes(job.skipCategory || '')
    );
    const tooOldCount = rankedJobs.filter((job) => job.skipCategory === 'posted-age').length;
    const duplicateCount = rankedJobs.filter((job) => job.skipCategory === 'duplicate').length;
    const directApplyCount = eligibleJobs.filter((job) => Boolean(job.applyUrl)).length;
    const preferredAtsCount = eligibleJobs.filter(
      (job) => getDirectApplyTier(resolveEffectiveApplyUrl(job), preferredAtsDomains) >= 3
    ).length;
    console.log(
      `  Query summary: ${eligibleJobs.length} candidates after board dedupe, ${directApplyCount} with direct external apply targets, ${preferredAtsCount} on preferred ATS hosts${tooOldCount > 0 ? `, ${tooOldCount} older than the posting window` : ''}${duplicateCount > 0 ? `, ${duplicateCount} already applied` : ''}`
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
  const execution = resolveStandaloneExecutionConfig(profile, flags);
  const { contextPromise } = launchConfiguredBrowserContext(profile, flags, {
    headless: execution.headless,
    browserName: execution.browserName,
    browserUserDataDir: execution.browserUserDataDir,
    browserProfileDirectory: execution.browserProfileDirectory
  });
  const context = await contextPromise;
  const allowManualPrompt = execution.allowManualPrompt;
  console.log(
    `Browser mode: ${execution.browserName}, ${execution.headless ? 'headless' : 'visible'} (${execution.executionMode})`
  );
  if (execution.headless) {
    console.log('Browser window will stay hidden because standalone.headless is true.');
  }
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
  const postedWithinHours = resolvePostedWithinHours(standaloneConfig, flags);
  const guidanceConfig = resolveCodexRunGuidanceConfig(profile);

  const { runPath, run } = await createRunFile(runQuery, {
    minMatchScore,
    maxApplications: maxApplicationsConfig.unlimited ? 'all' : maxApplications,
    queries,
    searchLimitPerQuery: perQueryLimit,
    allowManualPrompt,
    executionMode: execution.executionMode,
    browserName: execution.browserName,
    headless: execution.headless,
    runLoopMode,
    failurePolicy,
    requireDirectApply,
    applySurfacePolicy,
    searchMode,
    postedWithinHours,
    preferredAtsDomains,
    requiredTailoringProvider,
    guidanceProvider: guidanceConfig.provider,
    codexGuidedMaxReviewJobs: guidanceConfig.maxReviewJobs,
    codexGuidedRescueMinScore: guidanceConfig.rescueMinScore,
    unattendedSafeHostsOnly: execution.unattendedSafeHostsOnly,
    unattendedSafeApplyHosts: execution.unattendedSafeApplyHosts
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
          postedWithinHours,
          resumeText,
          allowManualPrompt,
          searchMode,
          preferredAtsDomains
        });

    const guidanceResult = await applyCodexGuidedSelection(
      jobs,
      profile,
      standaloneConfig,
      minMatchScore,
      {
        requireDirectApply,
        applySurfacePolicy,
        preferredAtsDomains,
        unattendedSafeHostsOnly: execution.unattendedSafeHostsOnly,
        unattendedSafeApplyHosts: execution.unattendedSafeApplyHosts,
        searchMode,
        maxApplications: Math.min(maxApplications, guidanceConfig.maxReviewJobs),
        queryLabel: runQuery,
        resumeText,
        executionMode: execution.executionMode,
        postedWithinHours,
        guidanceConfig
      }
    );
    run.jobs = guidanceResult.jobs;
    run.guidanceProvider = guidanceResult.guidanceProvider;
    run.guidanceSummary = guidanceResult.guidanceSummary;
    await saveRun(runPath, run);

    if (run.guidanceSummary) {
      console.log(`Codex-guided review: ${run.guidanceSummary}`);
    }

    const pendingCandidates = run.jobs
      .filter((job) => job.status === 'pending')
      .sort(compareGuidedPriority);
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
    if (execution.executionMode === 'unattended-safe' && execution.unattendedSafeHostsOnly) {
      console.log(
        `Unattended-safe mode: only hosts in the safe allowlist will be auto-applied.`
      );
    }
    if (postedWithinHours > 0) {
      console.log(`Recency filter: only jobs from the last ${postedWithinHours} hours are eligible when posting age is available.`);
    }

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

    const approvedJobs = run.jobs
      .filter((entry) => entry.status === 'approved')
      .sort(compareGuidedPriority);
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
            headless: execution.headless,
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
        headless: execution.headless,
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
    console.log('');
    console.log(buildRunCompletionOverview(run));
  } finally {
    await context.close().catch(() => {});
  }
}

async function commandAutopilot(query, flags) {
  const { profile } = await loadProfile();
  await runAutopilot(profile, query, flags, profile.standalone ?? {});
}

async function commandAutorun(flagOverrides = {}) {
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
    'execution-mode': standaloneConfig.executionMode ?? '',
    browser: standaloneConfig.browserName ?? '',
    'browser-user-data-dir': standaloneConfig.browserUserDataDir ?? '',
    'browser-profile-directory': standaloneConfig.browserProfileDirectory ?? '',
    limit:
      standaloneConfig.maxApplicationsPerRun ??
      profile.autopilot?.maxApplicationsPerRun ??
      5,
    file: standaloneConfig.mode === 'file' ? standaloneConfig.filePath : '',
    resume: standaloneConfig.resumePath ?? '',
    'search-limit': standaloneConfig.searchLimitPerQuery ?? '',
    'posted-within-hours': standaloneConfig.postedWithinHours ?? '',
    'search-mode': standaloneConfig.searchMode ?? '',
    'apply-surface-policy': standaloneConfig.applySurfacePolicy ?? '',
    'run-loop-mode': standaloneConfig.runLoopMode ?? '',
    'failure-policy': standaloneConfig.failurePolicy ?? '',
    'require-openai-tailoring': standaloneConfig.requireOpenAITailoring ?? '',
    'require-tailoring-provider': standaloneConfig.requireTailoringProvider ?? ''
  };

  if (typeof standaloneConfig.headless === 'boolean') {
    flags.headless = standaloneConfig.headless;
  }

  for (const [key, value] of Object.entries(flagOverrides)) {
    flags[key] = value;
  }

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
      await commandAutorun(flags);
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
