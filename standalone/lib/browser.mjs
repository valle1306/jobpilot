import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { repoRoot } from './config.mjs';
import { prompt, sleep } from './utils.mjs';

const edgeCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

export function getEdgeExecutablePath() {
  for (const candidate of edgeCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return edgeCandidates[0];
}

export async function launchBrowserContext({ headless = false } = {}) {
  const executablePath = getEdgeExecutablePath();
  const userDataDir = path.join(repoRoot, '.playwright-standalone');

  return chromium.launchPersistentContext(userDataDir, {
    executablePath,
    acceptDownloads: true,
    headless,
    viewport: { width: 1440, height: 1024 },
    args: ['--disable-blink-features=AutomationControlled']
  });
}

export async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
}

export async function promptForManualStep(message, options = {}) {
  const { allowPrompt = true } = options;
  if (!allowPrompt) {
    throw new Error(message);
  }

  await prompt(`${message}\nPress Enter once you're ready to continue.`);
}

export async function tryClickByText(page, texts) {
  for (const text of texts) {
    const candidates = [
      page.getByRole('button', { name: new RegExp(text, 'i') }).first(),
      page.getByRole('link', { name: new RegExp(text, 'i') }).first(),
      page.locator(`text=/${text}/i`).first()
    ];

    for (const candidate of candidates) {
      try {
        if (await candidate.isVisible({ timeout: 500 })) {
          await candidate.click({ timeout: 2000 });
          await sleep(1200);
          return true;
        }
      } catch {
        // Try the next candidate.
      }
    }
  }

  return false;
}

export async function detectLoginPage(page) {
  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase();
  return (
    bodyText.includes('sign in') ||
    bodyText.includes('log in') ||
    bodyText.includes('login') ||
    (await page.locator('input[type="password"]').count()) > 0
  );
}

export async function attemptLogin(page, credentials) {
  if (!credentials) {
    return false;
  }

  const emailInput = page
    .locator(
      'input[type="email"], input[name*="email" i], input[name*="username" i], input[autocomplete="username"]'
    )
    .first();
  const passwordSelector =
    'input[type="password"], input[name*="password" i], input[autocomplete="current-password"]';

  try {
    let touchedForm = false;

    if (await emailInput.isVisible({ timeout: 700 }).catch(() => false)) {
      await emailInput.fill(credentials.email);
      touchedForm = true;

      const passwordBeforeContinue = page.locator(passwordSelector).first();
      const hasVisiblePasswordBeforeContinue = await passwordBeforeContinue
        .isVisible({ timeout: 400 })
        .catch(() => false);

      if (!hasVisiblePasswordBeforeContinue) {
        await tryClickByText(page, ['continue with email', 'continue', 'next', 'sign in', 'log in']);
        await page.waitForTimeout(1200);
      }
    }

    const passwordInput = page.locator(passwordSelector).first();
    if (!(await passwordInput.isVisible({ timeout: 1500 }).catch(() => false))) {
      return touchedForm;
    }

    await passwordInput.fill(credentials.password);
    touchedForm = true;

    const submitted = await tryClickByText(page, ['sign in', 'log in', 'continue', 'submit']);
    if (!submitted) {
      await passwordInput.press('Enter');
    }

    await page.waitForTimeout(2500);
    return touchedForm;
  } catch {
    return false;
  }
}

export async function detectHumanChallenge(page) {
  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase();

  if (bodyText.includes('captcha') || bodyText.includes('recaptcha')) {
    return 'captcha';
  }

  if (
    bodyText.includes('verification code') ||
    bodyText.includes('2-factor') ||
    bodyText.includes('two-factor') ||
    bodyText.includes('authentication code')
  ) {
    return 'verification';
  }

  return null;
}
