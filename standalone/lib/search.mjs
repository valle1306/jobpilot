import { getCredentialForUrl, getEnabledSearchBoards, parseSearchQuery } from './config.mjs';
import {
  attemptLogin,
  detectHumanChallenge,
  detectLoginPage,
  gotoAndSettle,
  promptForManualStep
} from './browser.mjs';
import { dedupeJobs, scoreJob } from './scoring.mjs';
import { normalizeWhitespace, truncate } from './utils.mjs';
import { wasAlreadyApplied } from './runs.mjs';

function buildSearchUrl(board, parsed) {
  const base = board.searchUrl ?? '';
  const domain = board.domain ?? '';

  if (domain.includes('linkedin.com')) {
    const url = new URL(base);
    if (parsed.keywords) {
      url.searchParams.set('keywords', parsed.keywords);
    }
    if (parsed.location) {
      url.searchParams.set('location', parsed.location);
    }
    return url.toString();
  }

  if (domain.includes('indeed.com')) {
    const url = new URL(base);
    url.searchParams.set('q', parsed.keywords || parsed.raw);
    url.searchParams.set('l', parsed.location || '');
    return url.toString();
  }

  return base;
}

async function genericSearchFill(page, parsed) {
  const textInputs = page
    .locator('input[type="text"], input[type="search"], input:not([type])')
    .filter({ hasNot: page.locator('[disabled]') });

  const count = await textInputs.count();
  if (count === 0) {
    return false;
  }

  if (count >= 1) {
    await textInputs.nth(0).fill(parsed.keywords || parsed.raw);
  }
  if (count >= 2 && parsed.location) {
    await textInputs.nth(1).fill(parsed.location);
  }

  await textInputs.nth(0).press('Enter');
  await page.waitForTimeout(2500);
  return true;
}

async function extractCandidateLinks(page, board, limit = 15) {
  const raw = await page.evaluate(
    ({ boardDomain, limit: innerLimit }) => {
      const jobPatterns = [
        /linkedin\.com\/jobs\/view/i,
        /indeed\.com\/viewjob/i,
        /greenhouse\.io/i,
        /jobs\.lever\.co/i,
        /myworkdaysite\.com/i,
        /smartrecruiters\.com/i,
        /ashbyhq\.com/i,
        /careers/i,
        /\/job\//i,
        /\/jobs\//i
      ];

      const anchors = [...document.querySelectorAll('a[href]')];
      const seen = new Set();
      const results = [];

      for (const anchor of anchors) {
        const href = anchor.href;
        const text = (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (!href || !text) {
          continue;
        }
        if (/^\d[\d,+\s]*jobs?\b/i.test(text) || /\bjobs in\b/i.test(text)) {
          continue;
        }
        if (/linkedin\.com\/jobs\/search/i.test(href) || /join linkedin/i.test(text)) {
          continue;
        }
        if (!href.includes(boardDomain) && !jobPatterns.some((pattern) => pattern.test(href))) {
          continue;
        }
        if (!jobPatterns.some((pattern) => pattern.test(href))) {
          continue;
        }
        if (seen.has(href)) {
          continue;
        }
        seen.add(href);
        results.push({
          url: href,
          title: text
        });
        if (results.length >= innerLimit) {
          break;
        }
      }

      return results;
    },
    { boardDomain: board.domain, limit }
  );

  return raw;
}

async function hydrateJob(page, candidate, board) {
  await gotoAndSettle(page, candidate.url);

  const details = await page.evaluate(() => {
    const pickText = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const value = (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
        if (value) {
          return value;
        }
      }
      return '';
    };

    const bodyCandidates = [
      ...document.querySelectorAll('main, article, [role="main"], .jobs-description, .jobsearch-JobComponent')
    ];
    const bodyText = bodyCandidates
      .map((element) => (element.innerText || '').replace(/\s+/g, ' ').trim())
      .sort((a, b) => b.length - a.length)[0] ?? document.body.innerText;

    return {
      pageTitle: document.title,
      title:
        pickText([
          'h1',
          '[data-test-job-title]',
          '.jobsearch-JobInfoHeader-title',
          '.topcard__title',
          '.posting-headline h2'
        ]) || '',
      company:
        pickText([
          '[data-company-name]',
          '.topcard__org-name-link',
          '.jobsearch-CompanyInfoWithoutHeaderImage div',
          '.posting-header h3',
          '.company'
        ]) || '',
      location:
        pickText([
          '[data-test-job-location]',
          '.topcard__flavor--bullet',
          '.jobsearch-JobInfoHeader-subtitle div',
          '.location'
        ]) || '',
      description: bodyText || ''
    };
  });

  return {
    ...candidate,
    title: details.title || candidate.title,
    company: details.company || board.name,
    location: details.location,
    description: details.description,
    board: board.name,
    boardDomain: board.domain
  };
}

export async function fetchJobDetailsFromUrl(context, url, board = { name: 'Direct', domain: '' }) {
  const page = await context.newPage();
  try {
    return await hydrateJob(
      page,
      {
        url,
        title: url
      },
      board
    );
  } finally {
    await page.close().catch(() => {});
  }
}

export async function searchJobs({
  context,
  profile,
  query,
  limit = 12,
  hydrateLimit = 8,
  resumeText
}) {
  const parsed = parseSearchQuery(query);
  const boards = getEnabledSearchBoards(profile);
  const aggregated = [];

  for (const board of boards) {
    const page = await context.newPage();
    try {
      const searchUrl = buildSearchUrl(board, parsed);
      await gotoAndSettle(page, searchUrl);

      if (await detectLoginPage(page)) {
        await attemptLogin(page, getCredentialForUrl(profile, searchUrl));
      }

      const challenge = await detectHumanChallenge(page);
      if (challenge) {
        await promptForManualStep(
          `${board.name} presented a ${challenge}. Solve it in the browser to continue searching.`
        );
      }

      if (searchUrl === board.searchUrl) {
        await genericSearchFill(page, parsed);
      }

      const candidates = await extractCandidateLinks(page, board, limit);
      let hydrated = [];

      for (const candidate of candidates.slice(0, hydrateLimit)) {
        const jobPage = await context.newPage();
        try {
          const hydratedJob = await hydrateJob(jobPage, candidate, board);
          const scored = scoreJob({
            resumeText,
            title: hydratedJob.title,
            description: hydratedJob.description,
            query
          });

          hydrated.push({
            id: aggregated.length + hydrated.length + 1,
            ...hydratedJob,
            status: 'pending',
            matchScore: scored.score,
            matchReason: scored.reason,
            matchedKeywords: scored.matchedKeywords,
            missingKeywords: scored.missingKeywords
          });
        } catch {
          // Skip links that do not resolve cleanly.
        } finally {
          await jobPage.close().catch(() => {});
        }
      }

      aggregated.push(...hydrated);
    } finally {
      await page.close().catch(() => {});
    }
  }

  const deduped = dedupeJobs(aggregated);
  const filtered = [];

  for (const job of deduped) {
    const alreadyApplied = await wasAlreadyApplied(job.url);
    filtered.push({
      ...job,
      status: alreadyApplied ? 'skipped' : 'pending',
      skipReason: alreadyApplied ? 'Already applied' : ''
    });
  }

  filtered.sort((a, b) => b.matchScore - a.matchScore);
  filtered.forEach((job, index) => {
    job.id = index + 1;
  });

  return filtered;
}

export function renderSearchTable(jobs) {
  const lines = ['# | Score | Title | Company | Location | Board'];
  for (const job of jobs) {
    lines.push(
      `${job.id} | ${job.matchScore}/10 | ${truncate(job.title, 42)} | ${truncate(job.company, 24)} | ${truncate(job.location || 'n/a', 20)} | ${job.board}`
    );
  }
  return lines.join('\n');
}

export function renderSearchLinks(jobs, count = 5) {
  return jobs
    .slice(0, count)
    .map((job) => `${job.id}. ${truncate(job.title, 64)}\n   ${job.url}`)
    .join('\n');
}
