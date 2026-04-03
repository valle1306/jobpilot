import path from 'node:path';
import {
  classifyRoleType,
  estimateYearsExperience,
  getCredentialForUrl,
  resolveRepoPath
} from './config.mjs';
import {
  attemptLogin,
  detectHumanChallenge,
  detectLoginPage,
  gotoAndSettle,
  launchBrowserContext,
  promptForManualStep,
  tryClickByText
} from './browser.mjs';
import { ensureUploadResumePath, tailorJob } from './tailor.mjs';
import { logAppliedJob } from './runs.mjs';
import { normalizeWhitespace, prompt, resolveEffectiveApplyUrl, truncate } from './utils.mjs';

function normalizeLabel(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function isWorkdayUrl(url = '') {
  const normalized = String(url ?? '').toLowerCase();
  return (
    normalized.includes('myworkdayjobs.com') ||
    normalized.includes('myworkdaysite.com') ||
    normalized.includes('workdayjobs.com') ||
    normalized.includes('/candidateexperience/')
  );
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCoverLetter(profile, job, resumeText) {
  const summary = normalizeWhitespace(
    resumeText
      .replace(/\\[a-zA-Z]+\{[^}]*\}/g, ' ')
      .replace(/[{}\\]/g, ' ')
      .slice(0, 1200)
  );

  return `Dear Hiring Team,

I am excited to apply for the ${job.title || 'role'} position at ${job.company || 'your company'}. My background in data science and analytics aligns well with the mix of problem-solving, stakeholder communication, and hands-on execution described in the posting.

Highlights from my background that map well to this role include ${truncate(summary, 260)}.

I would welcome the opportunity to contribute quickly, collaborate closely with the team, and bring a thoughtful, execution-focused approach to the role.

Thank you for your time and consideration.
`;
}

async function extractJobDetailsFromPage(page) {
  return page.evaluate(() => {
    const pickText = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const text = (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) {
          return text;
        }
      }
      return '';
    };

    const description = (
      [...document.querySelectorAll('main, article, [role="main"], body')]
        .map((element) => (element.innerText || '').replace(/\s+/g, ' ').trim())
        .sort((a, b) => b.length - a.length)[0] ?? ''
    ).slice(0, 16000);

    return {
      title: pickText(['h1', '[data-test-job-title]', '.posting-headline h2']),
      company: pickText(['[data-company-name]', '.company', '.posting-header h3']),
      location: pickText(['[data-location]', '.location', '.posting-categories', '.posting-headline .sort-by-time-posted']),
      description
    };
  });
}

async function scanFields(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!element || element.disabled) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const labelForElement = (element) => {
      const labelledBy = element.getAttribute('aria-label');
      if (labelledBy) {
        return labelledBy;
      }

      if (element.id) {
        const label = document.querySelector(`label[for="${element.id}"]`);
        if (label?.innerText) {
          return label.innerText;
        }
      }

      const parentLabel = element.closest('label');
      if (parentLabel?.innerText) {
        return parentLabel.innerText;
      }

      const surrounding = element.closest('div, fieldset, section, form');
      const text = surrounding?.querySelector('legend, label, h2, h3')?.innerText;
      if (text) {
        return text;
      }

      return element.name || element.placeholder || element.id || '';
    };

    let counter = 0;
    const elements = [
      ...document.querySelectorAll(
        'input, textarea, select, [role="combobox"], button[aria-haspopup="listbox"]'
      )
    ];
    const seen = new Set();
    const fields = [];

    for (const element of elements) {
      if (seen.has(element)) {
        continue;
      }
      seen.add(element);

      const role = (element.getAttribute('role') || '').toLowerCase();
      const type = (element.getAttribute('type') || role || element.tagName).toLowerCase();
      const isFileInput = type === 'file';
      if (!isFileInput && !isVisible(element)) {
        continue;
      }

      const isComboButton =
        element.tagName.toLowerCase() === 'button' &&
        element.getAttribute('aria-haspopup') === 'listbox';

      if (
        !isFileInput &&
        !isComboButton &&
        ['hidden', 'submit', 'button', 'image', 'reset'].includes(type)
      ) {
        continue;
      }

      element.dataset.jobpilotId ||= `jp-${Date.now()}-${++counter}`;
      const options =
        element.tagName.toLowerCase() === 'select'
          ? [...element.options].map((option) => ({
              text: (option.textContent || '').trim(),
              value: option.value
            }))
          : [];

      fields.push({
        jobpilotId: element.dataset.jobpilotId,
        tag: role || element.tagName.toLowerCase(),
        type,
        name: element.getAttribute('name') || '',
        label: labelForElement(element),
        placeholder: element.getAttribute('placeholder') || '',
        required: element.required,
        options
      });
    }

    return fields;
  });
}

function pickChoice(field, desiredValue) {
  if (!desiredValue || !field.options?.length) {
    return null;
  }

  const normalizedDesired = normalizeLabel(desiredValue);
  const exact = field.options.find(
    (option) =>
      normalizeLabel(option.text) === normalizedDesired ||
      normalizeLabel(option.value) === normalizedDesired
  );
  if (exact) {
    return exact.value;
  }

  const fuzzy = field.options.find(
    (option) =>
      normalizeLabel(option.text).includes(normalizedDesired) ||
      normalizedDesired.includes(normalizeLabel(option.text))
  );
  if (fuzzy) {
    return fuzzy.value;
  }

  return null;
}

function inferFieldAnswer(field, ctx) {
  const key = normalizeLabel(`${field.label} ${field.name} ${field.placeholder}`);
  const profile = ctx.profile;

  if (/resume|cv|upload/.test(key) && field.type === 'file') {
    return { kind: 'file', value: ctx.resumePath };
  }

  if (/how did you hear|referral source|source/.test(key)) {
    return {
      kind: field.tag === 'select' || field.tag === 'combobox' ? 'select' : 'text',
      value: 'LinkedIn'
    };
  }

  if (/cover letter|motivation|why are you interested/.test(key)) {
    return { kind: 'text', value: ctx.coverLetter };
  }

  if (/first name|given name/.test(key)) {
    return { kind: 'text', value: profile.personal.firstName };
  }
  if (/last name|family name|surname/.test(key)) {
    return { kind: 'text', value: profile.personal.lastName };
  }
  if (/full name|legal name|applicant name/.test(key)) {
    return {
      kind: 'text',
      value: `${profile.personal.firstName} ${profile.personal.lastName}`.trim()
    };
  }
  if (/email/.test(key)) {
    return { kind: 'text', value: profile.personal.email };
  }
  if (/which location are you applying for|location are you applying for|preferred work location/.test(key)) {
    return {
      kind: field.tag === 'select' ? 'select' : 'text',
      value: ctx.jobLocation || ctx.preferredLocation || ''
    };
  }
  if (/phone|mobile|cell/.test(key)) {
    return { kind: 'text', value: profile.personal.phone };
  }
  if (/current location|your location/.test(key)) {
    return {
      kind: 'text',
      value: normalizeWhitespace(`${profile.address.city || ''}, ${profile.address.state || ''}`)
    };
  }
  if (/linkedin/.test(key)) {
    return { kind: 'text', value: profile.personal.linkedin };
  }
  if (/github/.test(key)) {
    return { kind: 'text', value: profile.personal.github };
  }
  if (/portfolio|website|personal site/.test(key)) {
    return { kind: 'text', value: profile.personal.website };
  }
  if (/address/.test(key)) {
    return { kind: 'text', value: profile.address.street };
  }
  if (/city/.test(key)) {
    return { kind: 'text', value: profile.address.city };
  }
  if (/state|province|region/.test(key)) {
    return { kind: 'text', value: profile.address.state };
  }
  if (/zip|postal/.test(key)) {
    return { kind: 'text', value: profile.address.zipCode };
  }
  if (/country/.test(key)) {
    return { kind: 'text', value: profile.address.country };
  }
  if (/salary|compensation|expected pay/.test(key)) {
    return {
      kind: field.tag === 'select' ? 'select' : 'text',
      value: profile.autopilot?.salaryExpectation || ''
    };
  }
  if (/start date|available to start/.test(key)) {
    return { kind: 'text', value: profile.autopilot?.defaultStartDate || '2 weeks notice' };
  }
  if (/authorized/.test(key) && /work/.test(key)) {
    return { kind: 'boolean', value: Boolean(profile.workAuthorization?.usAuthorized) };
  }
  if (/sponsor/.test(key)) {
    return {
      kind: 'boolean',
      value: !Boolean(profile.workAuthorization?.requiresSponsorship)
    };
  }
  if (/visa/.test(key)) {
    return { kind: 'text', value: profile.workAuthorization?.visaStatus || '' };
  }
  if (/opt/.test(key)) {
    return { kind: 'text', value: profile.workAuthorization?.optExtension || '' };
  }
  if (/relocat/.test(key)) {
    return {
      kind: 'boolean',
      value: Boolean(profile.workAuthorization?.willingToRelocate)
    };
  }
  if (/gender/.test(key)) {
    return { kind: field.tag === 'select' ? 'select' : 'text', value: profile.eeo?.gender || '' };
  }
  if (/race/.test(key)) {
    return { kind: field.tag === 'select' ? 'select' : 'text', value: profile.eeo?.race || '' };
  }
  if (/ethnicity|hispanic|latino/.test(key)) {
    return {
      kind: field.tag === 'select' ? 'select' : 'text',
      value: profile.eeo?.ethnicity || profile.eeo?.hispanicOrLatino || ''
    };
  }
  if (/veteran/.test(key)) {
    return {
      kind: field.tag === 'select' ? 'select' : 'text',
      value: profile.eeo?.veteranStatus || ''
    };
  }
  if (/disability/.test(key)) {
    return {
      kind: field.tag === 'select' ? 'select' : 'text',
      value: profile.eeo?.disabilityStatus || ''
    };
  }
  if (/terms|conditions|privacy|consent|certif|acknowledg|authorize/.test(key)) {
    return { kind: 'boolean', value: true };
  }
  if (/years.*experience|experience.*years/.test(key)) {
    return { kind: 'text', value: String(ctx.yearsExperience) };
  }

  return null;
}

async function choosePopupOption(page, desiredValue) {
  if (!desiredValue) {
    return false;
  }

  const escaped = escapeRegExp(desiredValue);
  const optionLocators = [
    page.getByRole('option', { name: new RegExp(`^${escaped}$`, 'i') }).first(),
    page.getByRole('option', { name: new RegExp(escaped, 'i') }).first(),
    page.getByRole('listitem', { name: new RegExp(escaped, 'i') }).first(),
    page.locator(`[role="option"]:has-text("${desiredValue}")`).first(),
    page.locator(`text=/${escaped}/i`).first()
  ];

  for (const option of optionLocators) {
    try {
      if (await option.isVisible({ timeout: 500 })) {
        await option.click({ timeout: 2000 });
        return true;
      }
    } catch {
      // Keep trying candidates.
    }
  }

  return false;
}

async function fillCustomCombobox(page, locator, answerValue) {
  const stringValue = String(answerValue ?? '').trim();
  if (!stringValue) {
    return false;
  }

  try {
    await locator.click({ timeout: 2000 });
  } catch {
    return false;
  }

  await page.waitForTimeout(500);
  const nestedEditable = locator.locator('input, textarea').first();
  if (await nestedEditable.isVisible({ timeout: 400 }).catch(() => false)) {
    await nestedEditable.fill(stringValue).catch(() => {});
    await page.waitForTimeout(500);
  } else {
    await page.keyboard.type(stringValue).catch(() => {});
    await page.waitForTimeout(500);
  }

  if (await choosePopupOption(page, stringValue)) {
    return true;
  }

  await page.keyboard.press('ArrowDown').catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  return true;
}

async function fillField(page, field, answer) {
  const locator = page.locator(`[data-jobpilot-id="${field.jobpilotId}"]`).first();

  if (!answer || !answer.value) {
    return false;
  }

  if (answer.kind === 'file') {
    await locator.setInputFiles(answer.value);
    return true;
  }

  if (answer.kind === 'boolean') {
    if (field.tag === 'select') {
      const optionValue = pickChoice(field, answer.value ? 'yes' : 'no');
      if (optionValue) {
        await locator.selectOption(optionValue);
        return true;
      }
    }

    if (field.type === 'checkbox' || field.type === 'radio') {
      if (answer.value) {
        await locator.check().catch(async () => locator.click());
      }
      return true;
    }

    if (field.tag === 'combobox') {
      return fillCustomCombobox(page, locator, answer.value ? 'Yes' : 'No');
    }
  }

  if (field.tag === 'combobox') {
    return fillCustomCombobox(page, locator, answer.value);
  }

  if (field.tag === 'select' || answer.kind === 'select') {
    const optionValue = pickChoice(field, answer.value);
    if (optionValue) {
      await locator.selectOption(optionValue);
      return true;
    }

    if (answer.kind === 'select') {
      return fillCustomCombobox(page, locator, answer.value);
    }

    return false;
  }

  await locator.fill(String(answer.value));
  return true;
}

async function detectSuccess(page) {
  const bodyText = normalizeLabel(await page.locator('body').innerText().catch(() => ''));
  return (
    bodyText.includes('application submitted') ||
    bodyText.includes('thank you for applying') ||
    bodyText.includes('received your application') ||
    bodyText.includes('thanks for applying')
  );
}

async function chooseAction(page) {
  const actions = [
    { kind: 'submit', texts: ['submit application', 'submit', 'finish application'] },
    { kind: 'next', texts: ['next', 'continue', 'save and continue', 'review'] }
  ];

  for (const action of actions) {
    for (const text of action.texts) {
      const button = page.getByRole('button', { name: new RegExp(text, 'i') }).first();
      try {
        if (await button.isVisible({ timeout: 300 })) {
          return { kind: action.kind, locator: button, label: text };
        }
      } catch {
        // Ignore and continue.
      }
    }
  }

  return null;
}

async function ensureApplicationForm(page) {
  const clicked = await tryClickByText(page, [
    'easy apply',
    'quick apply',
    'apply now',
    'apply for this job',
    'apply'
  ]);
  if (clicked) {
    await page.waitForTimeout(2500);
  }

  if (isWorkdayUrl(page.url())) {
    const workdayChoices = [
      'apply manually',
      'continue as guest',
      'continue without an account',
      'skip autofill',
      'start application'
    ];

    for (const label of workdayChoices) {
      const handled = await tryClickByText(page, [label]);
      if (handled) {
        await page.waitForTimeout(1800);
      }
    }
  }
}

async function extractValidationIssues(page) {
  const issues = await page.evaluate(() => {
    const isVisible = (element) => {
      if (!element) {
        return false;
      }
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const texts = new Set();
    const candidates = [
      ...document.querySelectorAll(
        '[aria-invalid="true"], [role="alert"], [data-automation-id*="error"], .error, .invalid, .field-error'
      )
    ];

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const text = (candidate.innerText || candidate.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        texts.add(text);
      }
    }

    return [...texts].slice(0, 6);
  });

  return issues;
}

export async function applyToJob({
  profile,
  url,
  job = {},
  submit = false,
  autoConfirm = false,
  headless = false,
  tailoredResumePath = '',
  context = null,
  resumeText = '',
  resumePathOverride = '',
  allowManualPrompt = true,
  runId = '',
  source = 'standalone-apply'
}) {
  const ownsContext = !context;
  const browserContext = context ?? (await launchBrowserContext({ headless }));

  try {
    const page = await browserContext.newPage();
    const targetUrl = resolveEffectiveApplyUrl(job) || url;
    await gotoAndSettle(page, targetUrl);

    let jobDetails = {
      title: job.title || '',
      company: job.company || '',
      location: job.location || '',
      description: job.description || ''
    };

    const challenge = await detectHumanChallenge(page);
    if (challenge) {
      try {
        await promptForManualStep(
          `The site presented a ${challenge}. Complete it manually in the browser before continuing.`,
          { allowPrompt: allowManualPrompt }
        );
      } catch (error) {
        return {
          status: 'manual-step-required',
          job: jobDetails,
          filledFields: [],
          resumePath: '',
          failReason: error.message
        };
      }
    }

    if (await detectLoginPage(page)) {
      const loggedIn = await attemptLogin(page, getCredentialForUrl(profile, page.url()));
      await page.waitForTimeout(2000);
      if (await detectLoginPage(page)) {
        if (!allowManualPrompt) {
          return {
            status: loggedIn ? 'verification-required' : 'login-required',
            job: jobDetails,
            filledFields: [],
            resumePath: '',
            failReason: loggedIn
              ? 'Additional verification is required before applying.'
              : 'Login is required before applying.'
          };
        }

        await promptForManualStep(
          'Login is still required before the application can continue.',
          { allowPrompt: allowManualPrompt }
        );
      }
    }

    await ensureApplicationForm(page);

    if (await detectLoginPage(page)) {
      const loggedIn = await attemptLogin(page, getCredentialForUrl(profile, page.url()));
      await page.waitForTimeout(2000);
      if (await detectLoginPage(page)) {
        if (!allowManualPrompt) {
          return {
            status: loggedIn ? 'verification-required' : 'login-required',
            job: jobDetails,
            filledFields: [],
            resumePath: '',
            failReason: loggedIn
              ? 'Additional verification is required before applying.'
              : 'Login is still required after opening the application flow.'
          };
        }

        await promptForManualStep(
          'Login is still required before the application can continue.',
          { allowPrompt: allowManualPrompt }
        );
      }
    }

    const extracted = await extractJobDetailsFromPage(page);
    jobDetails = {
      title: jobDetails.title || extracted.title,
      company: jobDetails.company || extracted.company,
      location: jobDetails.location || extracted.location,
      description: jobDetails.description || extracted.description
    };

    const roleType = classifyRoleType(jobDetails.title, jobDetails.description);
    const yearsExperience = estimateYearsExperience(resumeText || jobDetails.description || '');
    let effectiveResumePath = resumePathOverride
      ? resolveRepoPath(resumePathOverride)
      : await ensureUploadResumePath({
          profile,
          roleType,
          tailoredResumePath,
          headless,
          context: browserContext
        });

    if (!effectiveResumePath && profile.overleaf?.tailorResume) {
      const tailored = await tailorJob({
        profile,
        job: { ...jobDetails, url },
        headless,
        downloadPdf: true,
        context: browserContext
      });
      effectiveResumePath = tailored.tailoredResumePath;
    }

    const coverLetter = buildCoverLetter(profile, jobDetails, jobDetails.description || '');
    const filledFields = [];

    for (let step = 0; step < 6; step += 1) {
      const stepChallenge = await detectHumanChallenge(page);
      if (stepChallenge) {
        try {
          await promptForManualStep(
            `The application presented a ${stepChallenge}. Complete it manually in the browser before continuing.`,
            { allowPrompt: allowManualPrompt }
          );
        } catch (error) {
          return {
            status: 'manual-step-required',
            job: jobDetails,
            filledFields,
            resumePath: effectiveResumePath,
            failReason: error.message
          };
        }
      }

      const fields = await scanFields(page);
      for (const field of fields) {
        const answer = inferFieldAnswer(field, {
          profile,
          yearsExperience,
          resumePath: effectiveResumePath,
          coverLetter,
          jobLocation: jobDetails.location || job.location || '',
          preferredLocation:
            profile.workAuthorization?.preferredLocations?.[0] ??
            profile.standalone?.preferredLocations?.[0] ??
            ''
        });
        if (!answer) {
          continue;
        }
        try {
          const filled = await fillField(page, field, answer);
          if (filled) {
            filledFields.push({
              label: field.label || field.name || field.placeholder || field.type,
              kind: answer.kind
            });
          }
        } catch {
          // Keep going field-by-field.
        }
      }

      const action = await chooseAction(page);
      if (!action) {
        break;
      }

      if (action.kind === 'submit') {
        if (!submit) {
          return {
            status: 'ready',
            job: jobDetails,
            filledFields,
            resumePath: effectiveResumePath
          };
        }

        if (!autoConfirm) {
          const answer = await prompt(
            `Ready to submit ${jobDetails.title || 'this application'} at ${jobDetails.company || 'the company'}? [y/N] `
          );
          if (!/^y(es)?$/i.test(answer)) {
            return {
              status: 'cancelled',
              job: jobDetails,
              filledFields,
              resumePath: effectiveResumePath
            };
          }
        }

        await action.locator.click();
        await page.waitForTimeout(3000);
        const success = await detectSuccess(page);
        if (success) {
          await logAppliedJob({
            url: targetUrl,
            title: jobDetails.title || 'Unknown title',
            company: jobDetails.company || 'Unknown company',
            source,
            runId
          });
          return {
            status: 'applied',
            job: jobDetails,
            filledFields,
            resumePath: effectiveResumePath
          };
        }

        return {
          status: 'submitted-unknown',
          job: jobDetails,
          filledFields,
          resumePath: effectiveResumePath
        };
      }

      await action.locator.click();
      await page.waitForTimeout(2500);
    }

    const validationIssues = await extractValidationIssues(page);
    const incompleteReason = validationIssues.length
      ? `The application flow stalled before reaching a submit-ready state. Visible validation issues: ${validationIssues.join(' | ')}`
      : `The application flow stalled before reaching a submit-ready state on ${page.url()}.`;

    return {
      status: 'incomplete',
      job: jobDetails,
      filledFields,
      resumePath: effectiveResumePath,
      failReason: incompleteReason
    };
  } finally {
    if (ownsContext) {
      await browserContext.close().catch(() => {});
    }
  }
}
