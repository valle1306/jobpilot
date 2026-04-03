#!/usr/bin/env node

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyToJob } from './lib/apply.mjs';
import {
  ensureWorkingDirs,
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
import { tailorJob } from './lib/tailor.mjs';
import { prompt, truncate, uniqueBy } from './lib/utils.mjs';

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
  node standalone/jobpilot.mjs setup [--bootstrap-overleaf]
  node standalone/jobpilot.mjs search "<query>" [--limit 12] [--headless]
  node standalone/jobpilot.mjs tailor <job-url> [--headless] [--no-download]
  node standalone/jobpilot.mjs apply <job-url> [--submit] [--tailor] [--resume resume.pdf] [--headless]
  node standalone/jobpilot.mjs autopilot "<query>" [--yes] [--submit] [--resume resume.pdf] [--headless] [--limit 10]
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
}

async function commandSearch(query, flags) {
  const { profile } = await loadProfile();
  await ensureWorkingDirs();
  const { text: resumeText } = await readResumeText(profile);
  const context = await launchBrowserContext({ headless: Boolean(flags.headless) });

  try {
    const jobs = await searchJobs({
      context,
      profile,
      query,
      limit: Number(flags.limit ?? 12),
      resumeText
    });
    console.log(`\nSearch results for "${query}"\n`);
    console.log(renderSearchTable(jobs));
    if (jobs.length > 0) {
      console.log('\nTop links:\n');
      console.log(renderSearchLinks(jobs));
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
      status: alreadyApplied ? 'skipped' : 'pending',
      skipReason: alreadyApplied ? 'Already applied' : '',
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
    console.log(`Added keywords: ${result.addedKeywords.join(', ') || 'none'}`);
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

function applyAutopilotFilters(jobs, profile, standaloneConfig = {}, minMatchScore = 6) {
  const titleKeywords = [
    ...(profile.autopilot?.skipTitleKeywords ?? []),
    ...(standaloneConfig.skipTitleKeywords ?? [])
  ].map((value) => String(value).toLowerCase());

  return jobs.map((job) => {
    if (job.status === 'skipped') {
      return job;
    }

    const normalizedTitle = String(job.title ?? '').toLowerCase();
    const blockedKeyword = titleKeywords.find((keyword) => normalizedTitle.includes(keyword));
    if (blockedKeyword) {
      return {
        ...job,
        status: 'skipped',
        skipReason: `Title contains blocked keyword: ${blockedKeyword}`
      };
    }

    if (!titleMatchesEntryLevel(job.title, standaloneConfig)) {
      return {
        ...job,
        status: 'skipped',
        skipReason: 'Filtered out by entry-level only mode'
      };
    }

    if (!yearsMatchEntryLevel(job, standaloneConfig)) {
      return {
        ...job,
        status: 'skipped',
        skipReason: `Requires more than ${resolveEntryLevelMaxYears(standaloneConfig)} years of experience`
      };
    }

    if (!locationMatches(job, standaloneConfig, profile)) {
      return {
        ...job,
        status: 'skipped',
        skipReason: 'Outside preferred locations'
      };
    }

    if (job.matchScore < minMatchScore) {
      return {
        ...job,
        status: 'skipped',
        skipReason: `Below minimum match score (${job.matchScore} < ${minMatchScore})`
      };
    }

    return {
      ...job,
      status: 'pending',
      skipReason: ''
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
    const key = job.url || `${job.board}|${job.title}|${job.company}`;
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
  resumeText
}) {
  const aggregated = [];

  for (const query of queries) {
    console.log(`Searching query: ${query}`);
    const jobs = await searchJobs({
      context,
      profile,
      query,
      limit,
      resumeText
    });

    aggregated.push(
      ...jobs.map((job) => ({
        ...job,
        sourceQueries: [query]
      }))
    );
  }

  return mergeSearchResults(aggregated);
}

async function runAutopilot(profile, query, flags, standaloneConfig = {}) {
  const { text: resumeText } = await readResumeText(profile);
  const context = await launchBrowserContext({ headless: Boolean(flags.headless) });
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

  const { runPath, run } = await createRunFile(runQuery, {
    minMatchScore,
    maxApplications: maxApplicationsConfig.unlimited ? 'all' : maxApplications,
    queries,
    searchLimitPerQuery: perQueryLimit
  });

  try {
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
          resumeText
        });

    run.jobs = applyAutopilotFilters(jobs, profile, standaloneConfig, minMatchScore);
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
      } else if (job.status === 'pending') {
        job.status = 'skipped';
        job.skipReason = 'Not selected for this run';
      }
    }

    await saveRun(runPath, run);

    for (const job of run.jobs.filter((entry) => entry.status === 'approved')) {
      job.status = 'applying';
      await saveRun(runPath, run);

      let tailoredResumePath = '';
      if (profile.overleaf?.tailorResume) {
        try {
          const tailored = await tailorJob({
            profile,
            job,
            headless: Boolean(flags.headless),
            downloadPdf: true,
            context
          });
          tailoredResumePath = tailored.tailoredResumePath;
        } catch (error) {
          job.tailorWarning = error.message;
        }
      }

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
        resumePathOverride: flags.resume ? resolveRepoPath(flags.resume) : ''
      });

      job.result = result.status;
      if (result.status === 'applied' || result.status === 'submitted-unknown') {
        job.status = 'applied';
        job.appliedAt = new Date().toISOString();
      } else if (result.status === 'cancelled') {
        job.status = 'skipped';
        job.skipReason = 'Cancelled during apply';
      } else {
        job.status = 'failed';
        job.failReason = result.status;
      }

      await saveRun(runPath, run);
    }

    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    await saveRun(runPath, run);

    console.log(`\nAutopilot run saved to ${runPath}`);
    console.log(
      run.jobs
        .map(
          (job) =>
            `${job.id}. ${truncate(job.title, 48)} | ${job.status}${job.failReason ? ` | ${job.failReason}` : ''}`
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
    'search-limit': standaloneConfig.searchLimitPerQuery ?? ''
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
