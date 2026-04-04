import { getEnabledSearchBoards, parseSearchQuery } from './config.mjs';
import {
  attemptLogin,
  detectHumanChallenge,
  detectLinkedInAuthwallSignals,
  detectLoginPage,
  dismissLinkedInSignInPrompt,
  gotoAndSettle,
  promptForManualStep
} from './browser.mjs';
import { dedupeJobs, scoreJob } from './scoring.mjs';
import {
  canonicalizeJobUrl,
  cleanJobTitle,
  extractExternalJobUrl,
  extractKnownDirectJobUrl,
  getDirectApplyTier,
  isAggregatorUrl,
  normalizeWhitespace,
  resolveEffectiveApplyUrl,
  truncate
} from './utils.mjs';
import { wasAlreadyApplied } from './runs.mjs';

function getBoardSearchCredentials(board) {
  if (!board?.email || !board?.password) {
    return null;
  }

  return {
    email: board.email,
    password: board.password
  };
}

export function normalizePostedWithinHours(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.max(1, Math.round(numeric));
}

export function estimatePostedHoursAgo({ postedText = '', postedDatetime = '' } = {}, nowMs = Date.now()) {
  const normalizedText = normalizeWhitespace(String(postedText ?? '').toLowerCase());
  const normalizedDatetime = String(postedDatetime ?? '').trim();

  if (normalizedDatetime) {
    const parsedTime = Date.parse(normalizedDatetime);
    if (Number.isFinite(parsedTime)) {
      const deltaMs = Math.max(0, nowMs - parsedTime);
      return deltaMs / 3_600_000;
    }
  }

  if (!normalizedText) {
    return null;
  }

  if (
    normalizedText.includes('just now') ||
    normalizedText.includes('today') ||
    normalizedText.includes('moments ago')
  ) {
    return 0;
  }

  if (normalizedText.includes('yesterday')) {
    return 24;
  }

  const patterns = [
    { regex: /(\d+)\s*(?:seconds?|secs?|s)\b/i, multiplier: 0 },
    { regex: /(\d+)\s*(?:minutes?|mins?|m)\b/i, multiplier: 1 / 60 },
    { regex: /(\d+)\s*(?:hours?|hrs?|h)\b/i, multiplier: 1 },
    { regex: /(\d+)\s*(?:days?|d)\b/i, multiplier: 24 },
    { regex: /(\d+)\s*(?:weeks?|wks?|w)\b/i, multiplier: 24 * 7 },
    { regex: /(\d+)\s*(?:months?|mos?|mo)\b/i, multiplier: 24 * 30 }
  ];

  for (const pattern of patterns) {
    const match = normalizedText.match(pattern.regex);
    if (!match) {
      continue;
    }

    return Number(match[1]) * pattern.multiplier;
  }

  return null;
}

function extractRelativePostedTextFromDescription(description = '') {
  const normalized = normalizeWhitespace(String(description ?? ''));
  if (!normalized) {
    return '';
  }

  const snippet = normalized.slice(0, 500);
  const match = snippet.match(
    /\b(?:just now|today|yesterday|\d+\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s+ago)\b/i
  );

  return match ? normalizeWhitespace(match[0]) : '';
}

export function resolvePostedMetadata({
  detailPostedText = '',
  detailPostedDatetime = '',
  candidatePostedText = '',
  candidatePostedDatetime = '',
  description = ''
} = {}) {
  const inferredPostedText = extractRelativePostedTextFromDescription(description);
  const detailAge = estimatePostedHoursAgo({
    postedText: detailPostedText,
    postedDatetime: detailPostedDatetime
  });
  const candidateAge = estimatePostedHoursAgo({
    postedText: candidatePostedText,
    postedDatetime: candidatePostedDatetime
  });
  const inferredAge = estimatePostedHoursAgo({ postedText: inferredPostedText });

  // LinkedIn detail pages sometimes expose a stale absolute date while the search
  // result card or the top-of-page text still shows the current relative posting time.
  if (detailAge !== null && detailAge <= 48) {
    return {
      postedText: detailPostedText,
      postedDatetime: detailPostedDatetime,
      postedHoursAgo: detailAge
    };
  }

  if (candidateAge !== null && candidateAge <= 48) {
    return {
      postedText: candidatePostedText,
      postedDatetime: candidatePostedDatetime,
      postedHoursAgo: candidateAge
    };
  }

  if (inferredAge !== null && inferredAge <= 48) {
    return {
      postedText: inferredPostedText,
      postedDatetime: '',
      postedHoursAgo: inferredAge
    };
  }

  if (detailAge !== null) {
    return {
      postedText: detailPostedText,
      postedDatetime: detailPostedDatetime,
      postedHoursAgo: detailAge
    };
  }

  if (candidateAge !== null) {
    return {
      postedText: candidatePostedText,
      postedDatetime: candidatePostedDatetime,
      postedHoursAgo: candidateAge
    };
  }

  if (inferredAge !== null) {
    return {
      postedText: inferredPostedText,
      postedDatetime: '',
      postedHoursAgo: inferredAge
    };
  }

  return {
    postedText: detailPostedText || candidatePostedText || inferredPostedText || '',
    postedDatetime: detailPostedDatetime || candidatePostedDatetime || '',
    postedHoursAgo: null
  };
}

function buildSearchUrl(board, parsed, postedWithinHours = 0) {
  const base = board.searchUrl ?? '';
  const domain = board.domain ?? '';
  const normalizedPostedWithinHours = normalizePostedWithinHours(postedWithinHours);

  if (domain.includes('linkedin.com')) {
    const url = new URL(base);
    if (parsed.keywords) {
      url.searchParams.set('keywords', parsed.keywords);
    }
    if (parsed.location) {
      url.searchParams.set('location', parsed.location);
    }
    if (normalizedPostedWithinHours > 0) {
      url.searchParams.set('f_TPR', `r${normalizedPostedWithinHours * 3600}`);
      url.searchParams.set('sortBy', 'DD');
    }
    return url.toString();
  }

  if (domain.includes('indeed.com')) {
    const url = new URL(base);
    url.searchParams.set('q', parsed.keywords || parsed.raw);
    url.searchParams.set('l', parsed.location || '');
    if (normalizedPostedWithinHours > 0) {
      url.searchParams.set('fromage', String(Math.max(1, Math.ceil(normalizedPostedWithinHours / 24))));
      url.searchParams.set('sort', 'date');
    }
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
  if (board.domain.includes('linkedin.com')) {
    const rawLinkedIn = await page.evaluate((innerLimit) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const anchors = [...document.querySelectorAll('a[href*="/jobs/view/"]')];
      const seen = new Set();
      const results = [];

      for (const anchor of anchors) {
        const href = anchor.href;
        const text = normalize(anchor.innerText || anchor.textContent || '');
        const container =
          anchor.closest('li') ||
          anchor.closest('.jobs-search-results__list-item') ||
          anchor.closest('.job-card-container') ||
          anchor.parentElement;
        const timeElement = container?.querySelector('time');
        const postedText = normalize(
          timeElement?.innerText ||
            timeElement?.textContent ||
            container?.querySelector('.job-search-card__listdate')?.textContent ||
            container?.querySelector('.job-search-card__footer-wrapper')?.textContent ||
            ''
        );
        const postedDatetime = normalize(timeElement?.getAttribute('datetime') || '');
        if (!href || !text || seen.has(href)) {
          continue;
        }
        if (href.includes('/jobs/collections/')) {
          continue;
        }

        seen.add(href);
        results.push({ url: href, title: text, postedText, postedDatetime });
        if (results.length >= innerLimit) {
          break;
        }
      }

      return results;
    }, limit);

    if (rawLinkedIn.length > 0) {
      return rawLinkedIn;
    }
  }

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
        if (/^jobs$/i.test(text)) {
          continue;
        }
        if (/^\d[\d,+\s]*jobs?\b/i.test(text) || /\bjobs in\b/i.test(text)) {
          continue;
        }
        if (/\/jobs\/?$/.test(new URL(href, window.location.href).pathname)) {
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

async function detectSearchBlockReason(page, board) {
  const url = page.url().toLowerCase();
  const title = (await page.title().catch(() => '')).toLowerCase();
  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase()
    .slice(0, 4000);

  if (board.domain.includes('linkedin.com')) {
    if (
      detectLinkedInAuthwallSignals({
        url,
        title,
        bodyText
      })
    ) {
      return 'LinkedIn authwall blocked unauthenticated job search.';
    }
  }

  if (bodyText.includes('request blocked') || bodyText.includes('ray id for this request')) {
    return `${board.name} blocked this browser session.`;
  }

  if (
    bodyText.includes('performing security verification') ||
    bodyText.includes('please solve the challenge below') ||
    bodyText.includes('complete the following challenge to confirm this search was made by a human') ||
    bodyText.includes('just a moment')
  ) {
    return `${board.name} presented a bot or security verification challenge.`;
  }

  if (title.includes('404') || bodyText.includes('404')) {
    return `${board.name} search route returned 404.`;
  }

  return '';
}

async function ensureLinkedInSearchReady(page, searchUrl, allowManualPrompt = true) {
  await dismissLinkedInSignInPrompt(page).catch(() => false);
  let blockReason = await detectSearchBlockReason(page, {
    name: 'LinkedIn',
    domain: 'linkedin.com'
  });

  if (
    blockReason === 'LinkedIn authwall blocked unauthenticated job search.' &&
    allowManualPrompt
  ) {
    await promptForManualStep(
      'LinkedIn is not signed in inside the JobPilot browser yet. Sign in to LinkedIn in this browser window, then continue.',
      { allowPrompt: true }
    );
    await gotoAndSettle(page, searchUrl);
    await dismissLinkedInSignInPrompt(page).catch(() => false);
    blockReason = await detectSearchBlockReason(page, {
      name: 'LinkedIn',
      domain: 'linkedin.com'
    });
  }

  return blockReason;
}

async function probeDirectApplyUrl(page) {
  const candidates = [
    page.getByRole('link', { name: /apply|easy apply|quick apply|apply now/i }).first(),
    page.getByRole('button', { name: /apply|easy apply|quick apply|apply now/i }).first(),
    page.locator('a[href*="externalApply"], a[href*="greenhouse"], a[href*="lever"], a[href*="workday"], a[href*="ashby"], a[href*="smartrecruiters"]').first()
  ];

  for (const candidate of candidates) {
    try {
      if (!(await candidate.isVisible({ timeout: 400 }))) {
        continue;
      }

      const popupPromise = page.context().waitForEvent('page', { timeout: 2500 }).catch(() => null);
      await candidate.click({ timeout: 1500, noWaitAfter: true }).catch(() => {});
      await page.waitForTimeout(1800);

      const popup = await popupPromise;
      const popupUrl = popup ? canonicalizeJobUrl(popup.url()) : '';
      if (popup && popupUrl && !isAggregatorUrl(popupUrl)) {
        await popup.close().catch(() => {});
        return popupUrl;
      }
      if (popup) {
        await popup.close().catch(() => {});
      }

      const navigatedUrl = canonicalizeJobUrl(page.url());
      if (navigatedUrl && !isAggregatorUrl(navigatedUrl)) {
        return navigatedUrl;
      }
    } catch {
      // Keep probing other candidates.
    }
  }

  return '';
}

async function hydrateJob(page, candidate, board, allowManualPrompt = true) {
  await gotoAndSettle(page, candidate.url);
  if (board.domain.includes('linkedin.com') || String(candidate.url).includes('linkedin.com')) {
    await dismissLinkedInSignInPrompt(page).catch(() => false);
    const title = await page.title().catch(() => '');
    const bodyText = (await page.locator('body').innerText().catch(() => ''))
      .slice(0, 5000);
    const linkedInBlocked = detectLinkedInAuthwallSignals({
      url: page.url(),
      title,
      bodyText
    });
    if (linkedInBlocked && allowManualPrompt) {
      await promptForManualStep(
        'LinkedIn opened an authwall instead of the job details. Sign in to LinkedIn in this JobPilot browser, then continue.',
        { allowPrompt: true }
      );
      await gotoAndSettle(page, candidate.url);
      await dismissLinkedInSignInPrompt(page).catch(() => false);
    }
  }

  const details = await page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
    const pickText = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const value = normalize(element?.innerText || element?.textContent || '');
        if (value) {
          return value;
        }
      }
      return '';
    };

    const pickAttribute = (selectors, attribute) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const value = normalize(element?.getAttribute(attribute) || '');
        if (value) {
          return value;
        }
      }
      return '';
    };

    const decodeRedirect = (href) => {
      if (!href) {
        return '';
      }

      try {
        const url = new URL(href, window.location.href);
        const keys = [
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

        for (const key of keys) {
          const candidate = url.searchParams.get(key);
          if (!candidate) {
            continue;
          }
          try {
            const decoded = decodeURIComponent(candidate);
            if (/^https?:\/\//i.test(decoded)) {
              return decoded;
            }
          } catch {
            if (/^https?:\/\//i.test(candidate)) {
              return candidate;
            }
          }
        }

        return url.toString();
      } catch {
        return href;
      }
    };

    const bodyCandidates = [
      ...document.querySelectorAll('main, article, [role="main"], .jobs-description, .jobsearch-JobComponent')
    ];
    const bodyText = bodyCandidates
      .map((element) => normalize(element.innerText || ''))
      .sort((a, b) => b.length - a.length)[0] ?? document.body.innerText;

    const currentHost = window.location.hostname.replace(/^www\./, '');
    const applyCandidates = [...document.querySelectorAll('a[href], button, [role="button"]')]
      .map((element) => {
        const text = normalize(
          element.innerText ||
            element.textContent ||
            element.getAttribute('aria-label') ||
            element.getAttribute('title') ||
            ''
        );
        const hrefAttr = element.getAttribute('href') || '';
        const href = hrefAttr ? decodeRedirect(hrefAttr) : '';
        return { text, href };
      })
      .filter(
        (candidate) =>
          candidate.href &&
          /apply|easy apply|quick apply|submit application|external apply/i.test(candidate.text)
      );

    const externalApply = applyCandidates.find((candidate) => {
      try {
        const url = new URL(candidate.href);
        const host = url.hostname.replace(/^www\./, '');
        return (
          host !== currentHost &&
          !host.includes('linkedin.com') &&
          !host.includes('indeed.com') &&
          !host.includes('glassdoor.com') &&
          !host.includes('hiring.cafe')
        );
      } catch {
        return false;
      }
    });
    const internalApply = applyCandidates.find((candidate) => candidate.href);

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
      postedText:
        pickText([
          '.posted-time-ago__text',
          '.jobs-unified-top-card__subtitle-secondary-grouping time',
          '.jobs-unified-top-card__tertiary-description time',
          '.jobsearch-JobMetadataFooter',
          '.sort-by-time-posted',
          'time'
        ]) || '',
      postedDatetime:
        pickAttribute(
          [
            '.jobs-unified-top-card__subtitle-secondary-grouping time',
            '.jobs-unified-top-card__tertiary-description time',
            '.posted-time-ago__text',
            'time'
          ],
          'datetime'
        ) || '',
      description: bodyText || '',
      applyUrl: externalApply?.href || internalApply?.href || '',
      applySurface: externalApply ? 'external' : internalApply ? 'internal' : 'none'
    };
  });

  const canonicalSourceUrl = canonicalizeJobUrl(candidate.url);
  let resolvedApplyUrl = details.applyUrl
    ? extractExternalJobUrl(details.applyUrl)
    : '';

  if (!resolvedApplyUrl) {
    const rawHtml = await page.content().catch(() => '');
    resolvedApplyUrl = extractKnownDirectJobUrl(rawHtml);
  }
  if (!resolvedApplyUrl && isAggregatorUrl(candidate.url)) {
    resolvedApplyUrl = await probeDirectApplyUrl(page);
  }
  const canonicalApplyUrl = canonicalizeJobUrl(resolvedApplyUrl);
  const fallbackDirectSourceUrl =
    canonicalSourceUrl && !isAggregatorUrl(canonicalSourceUrl) ? canonicalSourceUrl : '';
  const effectiveApplyUrl = canonicalApplyUrl || fallbackDirectSourceUrl;
  const posted = resolvePostedMetadata({
    detailPostedText: details.postedText,
    detailPostedDatetime: details.postedDatetime,
    candidatePostedText: candidate.postedText,
    candidatePostedDatetime: candidate.postedDatetime,
    description: details.description
  });

  return {
    ...candidate,
    url: canonicalSourceUrl || candidate.url,
    sourceUrl: candidate.url,
    title: cleanJobTitle(details.title || candidate.title),
    company: details.company || board.name,
    location: details.location,
    postedText: posted.postedText,
    postedDatetime: posted.postedDatetime,
    postedHoursAgo: posted.postedHoursAgo,
    description: details.description,
    applyUrl: effectiveApplyUrl || '',
    applySurface: effectiveApplyUrl
      ? 'direct'
      : isAggregatorUrl(candidate.url)
        ? 'aggregator'
        : details.applySurface,
    applyTier: getDirectApplyTier(effectiveApplyUrl),
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
  postedWithinHours = 0,
  resumeText,
  allowManualPrompt = true,
  onProgress = null
}) {
  const parsed = parseSearchQuery(query);
  const normalizedPostedWithinHours = normalizePostedWithinHours(postedWithinHours);
  const boards = getEnabledSearchBoards(profile);
  const aggregated = [];

  for (const board of boards) {
    const page = await context.newPage();
    try {
      onProgress?.({ type: 'board-start', board: board.name, query });
      const searchUrl = buildSearchUrl(board, parsed, normalizedPostedWithinHours);
      await gotoAndSettle(page, searchUrl);

      if (board.domain.includes('linkedin.com')) {
        const linkedInReadyError = await ensureLinkedInSearchReady(
          page,
          searchUrl,
          allowManualPrompt
        );
        if (linkedInReadyError) {
          throw new Error(linkedInReadyError);
        }
      }

      const boardCredentials = getBoardSearchCredentials(board);
      if (boardCredentials && (await detectLoginPage(page))) {
        await attemptLogin(page, boardCredentials);
      }

      const challenge = await detectHumanChallenge(page);
      if (challenge) {
        await promptForManualStep(
          `${board.name} presented a ${challenge}. Solve it in the browser to continue searching.`,
          { allowPrompt: allowManualPrompt }
        );
      }

      if (searchUrl === board.searchUrl) {
        await genericSearchFill(page, parsed);
      }

      const blockReason = await detectSearchBlockReason(page, board);
      if (blockReason) {
        throw new Error(blockReason);
      }

      const candidates = await extractCandidateLinks(page, board, limit);
      if (candidates.length === 0) {
        const emptyReason = await detectSearchBlockReason(page, board);
        if (emptyReason) {
          throw new Error(emptyReason);
        }
      }
      let hydrated = [];

      for (const candidate of candidates.slice(0, hydrateLimit)) {
        const jobPage = await context.newPage();
        try {
          const hydratedJob = await hydrateJob(jobPage, candidate, board, allowManualPrompt);
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
      onProgress?.({
        type: 'board-complete',
        board: board.name,
        query,
        count: hydrated.length
      });
    } catch (error) {
      onProgress?.({
        type: 'board-error',
        board: board.name,
        query,
        error: error.message
      });
    } finally {
      await page.close().catch(() => {});
    }
  }

  const deduped = dedupeJobs(aggregated);
  const filtered = [];

  for (const job of deduped) {
    const alreadyApplied =
      (job.applyUrl && (await wasAlreadyApplied(job.applyUrl))) ||
      (await wasAlreadyApplied(job.url));
    const effectiveApplyUrl = resolveEffectiveApplyUrl(job);
    const postedOutsideWindow =
      normalizedPostedWithinHours > 0 &&
      Number.isFinite(job.postedHoursAgo) &&
      job.postedHoursAgo > normalizedPostedWithinHours;
    filtered.push({
      ...job,
      applyUrl: effectiveApplyUrl || '',
      status: alreadyApplied || postedOutsideWindow ? 'skipped' : 'pending',
      stage: alreadyApplied || postedOutsideWindow ? 'skipped' : 'discovered',
      skipReason: alreadyApplied
        ? 'Already applied'
        : postedOutsideWindow
          ? `Posted outside the last ${normalizedPostedWithinHours} hours`
          : '',
      skipCategory: alreadyApplied
        ? 'duplicate'
        : postedOutsideWindow
          ? 'posted-age'
          : ''
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
    .map((job) => `${job.id}. ${truncate(job.title, 64)}\n   ${job.applyUrl || job.url}`)
    .join('\n');
}
