import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { repoRoot } from './config.mjs';
import { prompt, sleep } from './utils.mjs';

const edgeCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const chromeCandidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function pickExecutable(candidates, fallback) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return fallback;
}

export function getEdgeExecutablePath() {
  return pickExecutable(edgeCandidates, edgeCandidates[0]);
}

export function getChromeExecutablePath() {
  return pickExecutable(chromeCandidates, chromeCandidates[0]);
}

function isDirectProfileLaunchBlocked(error) {
  const message = String(error?.message || '');
  const normalized = message.toLowerCase();

  return (
    normalized.includes('spawn eperm') ||
    normalized.includes('profile appears to be in use') ||
    normalized.includes('user data directory is already in use') ||
    normalized.includes('process singleton') ||
    normalized.includes('target page, context or browser has been closed') ||
    normalized.includes('process did exit: exitcode=21') ||
    normalized.includes('exitcode=21')
  );
}

function normalizeFsPath(value = '') {
  return path.resolve(String(value || '')).replace(/[\\/]+/g, '\\').toLowerCase();
}

function getSystemUserDataDir(browserName = 'edge') {
  const localAppData = process.env.LOCALAPPDATA || '';
  if (!localAppData) {
    return '';
  }

  return browserName === 'chrome'
    ? path.join(localAppData, 'Google', 'Chrome', 'User Data')
    : path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
}

export function shouldMirrorSystemUserDataDir(userDataDir = '', browserName = 'edge') {
  if (!userDataDir) {
    return false;
  }

  const systemDir = getSystemUserDataDir(browserName);
  if (!systemDir) {
    return false;
  }

  return normalizeFsPath(userDataDir) === normalizeFsPath(systemDir);
}

function normalizeProfileStrategy(value = '') {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'direct' || normalized === 'mirror') {
    return normalized;
  }

  return 'auto';
}

export function resolveBrowserLaunchPlan({
  browserName = 'edge',
  userDataDir = '',
  profileDirectory = '',
  headless = false,
  profileStrategy = 'auto'
} = {}) {
  const normalizedBrowser = String(browserName ?? 'edge').trim().toLowerCase() === 'chrome'
    ? 'chrome'
    : 'edge';
  const defaultAutomationDir = path.join(
    repoRoot,
    normalizedBrowser === 'chrome'
      ? '.playwright-standalone-chrome'
      : '.playwright-standalone-edge'
  );
  const resolvedUserDataDir = userDataDir
    ? path.isAbsolute(userDataDir)
      ? userDataDir
      : path.resolve(repoRoot, userDataDir)
    : defaultAutomationDir;
  const resolvedProfileDirectory = profileDirectory || 'Default';
  const systemProfileRequested = shouldMirrorSystemUserDataDir(
    resolvedUserDataDir,
    normalizedBrowser
  );
  const normalizedProfileStrategy = normalizeProfileStrategy(profileStrategy);
  const directSystemProfile =
    systemProfileRequested &&
    (normalizedProfileStrategy === 'direct' ||
      (normalizedProfileStrategy === 'auto' && !headless));
  const mirroredFromSystem = systemProfileRequested && !directSystemProfile;

  return {
    browserName: normalizedBrowser,
    userDataDir: resolvedUserDataDir,
    launchUserDataDir: mirroredFromSystem ? defaultAutomationDir : resolvedUserDataDir,
    profileDirectory: resolvedProfileDirectory,
    sourceUserDataDir: mirroredFromSystem ? resolvedUserDataDir : '',
    sourceProfileDirectory: mirroredFromSystem ? resolvedProfileDirectory : '',
    mirroredFromSystem,
    directSystemProfile,
    profileStrategy: normalizedProfileStrategy
  };
}

function getMirrorRootDir(browserName = 'edge') {
  return path.join(
    repoRoot,
    browserName === 'chrome'
      ? '.playwright-standalone-chrome-mirror'
      : '.playwright-standalone-edge-mirror'
  );
}

const browserStateRootEntries = ['Local State'];
const browserStateProfileEntries = [
  'Preferences',
  'Secure Preferences',
  'Bookmarks',
  'Login Data',
  'Login Data For Account',
  'Web Data',
  'History',
  'Favicons',
  'Sessions',
  'Cookies',
  'Network',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'WebStorage',
  'Service Worker',
  'Extension State',
  'Extensions',
  'Local Extension Settings',
  'Sync Extension Settings'
];

function shouldSkipMirroredPath(candidatePath) {
  const normalizedParts = path
    .normalize(candidatePath)
    .split(path.sep)
    .filter(Boolean)
    .map((part) => part.toLowerCase());

  return normalizedParts.some((part) =>
    [
      'cache',
      'cache_data',
      'code cache',
      'gpucache',
      'grshadercache',
      'shadercache',
      'dawncache',
      'crashpad',
      'browsermetrics',
      'optimizationhints',
      'safe browsing'
    ].includes(part) ||
    part.startsWith('singleton') ||
    part === 'lockfile' ||
    part === 'lock'
  );
}

function copyBrowserStatePath(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return true;
  }

  try {
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: true,
      filter: (candidate) => !shouldSkipMirroredPath(candidate)
    });
    return true;
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (
      error?.code === 'EBUSY' ||
      error?.code === 'EPERM' ||
      message.includes('being used by another process') ||
      message.includes('resource busy or locked')
    ) {
      return false;
    }

    throw error;
  }
}

function removeChromiumLockFiles(userDataDir, profileDirectory) {
  const candidates = [
    path.join(userDataDir, 'SingletonLock'),
    path.join(userDataDir, 'SingletonCookie'),
    path.join(userDataDir, 'SingletonSocket'),
    path.join(userDataDir, 'lockfile'),
    path.join(userDataDir, profileDirectory, 'LOCK'),
    path.join(userDataDir, profileDirectory, 'lockfile')
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { force: true });
      }
    } catch {
      // Ignore stale lock cleanup failures.
    }
  }
}

function syncSystemBrowserProfile(plan) {
  if (!plan.mirroredFromSystem) {
    return { lockedPaths: [] };
  }

  const sourceUserDataDir = plan.sourceUserDataDir;
  const sourceProfileDirectory = plan.sourceProfileDirectory;
  const targetUserDataDir = plan.userDataDir;
  const targetProfileDirectory = plan.profileDirectory;
  const sourceProfileDir = path.join(sourceUserDataDir, sourceProfileDirectory);
  const targetProfileDir = path.join(targetUserDataDir, targetProfileDirectory);

  if (!fs.existsSync(sourceProfileDir)) {
    throw new Error(
      `Configured browser profile directory was not found: ${sourceProfileDir}`
    );
  }

  fs.mkdirSync(targetUserDataDir, { recursive: true });
  fs.mkdirSync(targetProfileDir, { recursive: true });
  const lockedPaths = [];

  for (const entry of browserStateRootEntries) {
    const copied = copyBrowserStatePath(
      path.join(sourceUserDataDir, entry),
      path.join(targetUserDataDir, entry)
    );
    if (!copied) {
      lockedPaths.push(path.join(sourceUserDataDir, entry));
    }
  }

  for (const entry of browserStateProfileEntries) {
    const copied = copyBrowserStatePath(
      path.join(sourceProfileDir, entry),
      path.join(targetProfileDir, entry)
    );
    if (!copied) {
      lockedPaths.push(path.join(sourceProfileDir, entry));
    }
  }

  removeChromiumLockFiles(targetUserDataDir, targetProfileDirectory);
  return { lockedPaths };
}

function cloneSeedProfileToLaunchDir({
  seedUserDataDir,
  profileDirectory,
  launchUserDataDir
}) {
  fs.mkdirSync(launchUserDataDir, { recursive: true });
  fs.mkdirSync(path.join(launchUserDataDir, profileDirectory), { recursive: true });

  for (const entry of browserStateRootEntries) {
    copyBrowserStatePath(
      path.join(seedUserDataDir, entry),
      path.join(launchUserDataDir, entry)
    );
  }

  for (const entry of browserStateProfileEntries) {
    copyBrowserStatePath(
      path.join(seedUserDataDir, profileDirectory, entry),
      path.join(launchUserDataDir, profileDirectory, entry)
    );
  }

  removeChromiumLockFiles(launchUserDataDir, profileDirectory);
}

function persistLaunchProfileToSeedDir({
  launchUserDataDir,
  seedUserDataDir,
  profileDirectory
}) {
  fs.mkdirSync(seedUserDataDir, { recursive: true });
  fs.mkdirSync(path.join(seedUserDataDir, profileDirectory), { recursive: true });

  for (const entry of browserStateRootEntries) {
    copyBrowserStatePath(
      path.join(launchUserDataDir, entry),
      path.join(seedUserDataDir, entry)
    );
  }

  for (const entry of browserStateProfileEntries) {
    copyBrowserStatePath(
      path.join(launchUserDataDir, profileDirectory, entry),
      path.join(seedUserDataDir, profileDirectory, entry)
    );
  }

  removeChromiumLockFiles(seedUserDataDir, profileDirectory);
}

function prepareMirrorLaunchDir(browserName = 'edge') {
  const mirrorRootDir = getMirrorRootDir(browserName);
  fs.mkdirSync(mirrorRootDir, { recursive: true });

  try {
    for (const entry of fs.readdirSync(mirrorRootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidate = path.join(mirrorRootDir, entry.name);
      const stats = fs.statSync(candidate);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs > 24 * 60 * 60 * 1000) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore best-effort cleanup failures.
  }

  return fs.mkdtempSync(path.join(mirrorRootDir, 'run-'));
}

export async function launchBrowserContext({
  headless = false,
  browserName = 'edge',
  userDataDir = '',
  profileDirectory = '',
  profileStrategy = 'auto'
} = {}) {
  const plan = resolveBrowserLaunchPlan({
    browserName,
    userDataDir,
    profileDirectory,
    headless,
    profileStrategy
  });
  const normalizedBrowser = plan.browserName;
  const executablePath =
    normalizedBrowser === 'chrome' ? getChromeExecutablePath() : getEdgeExecutablePath();
  let launchUserDataDir = plan.launchUserDataDir;

  if (plan.mirroredFromSystem) {
    const syncResult = syncSystemBrowserProfile({
      ...plan,
      userDataDir: plan.launchUserDataDir
    });
    launchUserDataDir = prepareMirrorLaunchDir(normalizedBrowser);
    cloneSeedProfileToLaunchDir({
      seedUserDataDir: plan.launchUserDataDir,
      profileDirectory: plan.profileDirectory,
      launchUserDataDir
    });
    console.log(
      `Using mirrored ${normalizedBrowser} profile from ${plan.sourceProfileDirectory} via ${plan.userDataDir} into ${launchUserDataDir}`
    );
    if (syncResult.lockedPaths.length > 0) {
      console.log(
        `Some live ${normalizedBrowser} profile files were locked, so JobPilot reused the last mirrored automation state for them.`
      );
    }
  }

  const args = ['--disable-blink-features=AutomationControlled'];
  if (plan.profileDirectory) {
    args.push(`--profile-directory=${plan.profileDirectory}`);
  }

  try {
    const context = await chromium.launchPersistentContext(launchUserDataDir, {
      executablePath,
      acceptDownloads: true,
      headless,
      viewport: { width: 1440, height: 1024 },
      args
    });

    if (plan.mirroredFromSystem) {
      const originalClose = context.close.bind(context);
      let persisted = false;
      context.close = async (...closeArgs) => {
        let closeError = null;
        try {
          await originalClose(...closeArgs);
        } catch (error) {
          closeError = error;
        }

        if (!persisted) {
          persisted = true;
          try {
            persistLaunchProfileToSeedDir({
              launchUserDataDir,
              seedUserDataDir: plan.launchUserDataDir,
              profileDirectory: plan.profileDirectory
            });
          } catch (error) {
            if (!closeError) {
              closeError = error;
            } else {
              console.warn(
                `Warning: JobPilot could not persist the mirrored ${normalizedBrowser} browser state after this run. ${error.message}`
              );
            }
          }

          try {
            fs.rmSync(launchUserDataDir, { recursive: true, force: true });
          } catch {
            // Ignore best-effort cleanup failures.
          }
        }

        if (
          closeError &&
          !String(closeError?.message || '').toLowerCase().includes('target page, context or browser has been closed')
        ) {
          throw closeError;
        }
      };
    }

    return context;
  } catch (error) {
    const directLaunchBlocked =
      plan.directSystemProfile && isDirectProfileLaunchBlocked(error);

    if (directLaunchBlocked && plan.profileStrategy === 'auto') {
      console.log(
        `Direct ${normalizedBrowser} profile launch was blocked, so JobPilot is falling back to the mirrored automation profile.`
      );
      return launchBrowserContext({
        headless,
        browserName,
        userDataDir,
        profileDirectory,
        profileStrategy: 'mirror'
      });
    }

    if (String(error?.message || '').includes('spawn EPERM') && plan.mirroredFromSystem) {
      throw new Error(
        `JobPilot could not launch ${normalizedBrowser} even after mirroring your signed-in browser profile into ${launchUserDataDir}. Close all ${normalizedBrowser} windows and try again.`
      );
    }

    if (directLaunchBlocked && plan.profileStrategy === 'direct') {
      throw new Error(
        `JobPilot could not launch the live ${normalizedBrowser} profile directly. Close all ${normalizedBrowser} windows or switch standalone.browserProfileStrategy back to "mirror".`
      );
    }

    throw error;
  }
}

function isTransientNewPageError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('target.createtarget') ||
    message.includes('failed to open a new tab') ||
    message.includes('failed to create target')
  );
}

async function closeBlankPages(context) {
  if (!context || typeof context.pages !== 'function') {
    return;
  }

  for (const page of context.pages()) {
    try {
      if (!page || page.isClosed?.()) {
        continue;
      }

      if (page.url() === 'about:blank') {
        await page.close({ runBeforeUnload: false }).catch(() => {});
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export async function openContextPage(
  context,
  { label = 'browser page', attempts = 3, retryDelayMs = 1200 } = {}
) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await context.newPage();
    } catch (error) {
      lastError = error;
      if (!isTransientNewPageError(error) || attempt === attempts) {
        throw error;
      }

      console.warn(
        `Warning: JobPilot could not open ${label} on attempt ${attempt}/${attempts}. Retrying...`
      );
      await closeBlankPages(context);
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError ?? new Error(`JobPilot could not open ${label}.`);
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

export async function detectRegistrationPage(page) {
  const url = page.url().toLowerCase();
  if (
    url.includes('/account/register') ||
    url.includes('/register?') ||
    url.includes('/register/') ||
    url.includes('create-account') ||
    url.includes('createaccount') ||
    url.includes('/signup') ||
    url.includes('sign-up') ||
    url.includes('candidate/register')
  ) {
    return true;
  }

  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase()
    .slice(0, 5000);

  return (
    bodyText.includes('create an account') ||
    bodyText.includes('create account') ||
    bodyText.includes('register to apply') ||
    bodyText.includes('register to continue') ||
    bodyText.includes('already have an account') ||
    bodyText.includes('confirm password')
  );
}

export async function detectLoginPage(page) {
  if (await detectRegistrationPage(page)) {
    return false;
  }

  const url = page.url().toLowerCase();
  if (
    /\/(login|log-in|signin|sign-in)(\/|$|\?)/i.test(url) ||
    url.includes('auth') ||
    url.includes('session')
  ) {
    return true;
  }

  if ((await page.locator('input[type="password"]').count().catch(() => 0)) > 0) {
    return true;
  }

  const emailCount = await page
    .locator(
      'input[type="email"], input[name*="email" i], input[name*="username" i], input[autocomplete="username"]'
    )
    .count()
    .catch(() => 0);

  if (emailCount === 0) {
    return false;
  }

  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase()
    .slice(0, 5000);

  return (
    bodyText.includes('log in') ||
    bodyText.includes('login') ||
    bodyText.includes('sign in') ||
    bodyText.includes('continue with email') ||
    bodyText.includes('sign into your account') ||
    bodyText.includes('forgot password')
  );
}

export function detectLinkedInAuthwallSignals({ url = '', title = '', bodyText = '' } = {}) {
  const normalizedUrl = String(url ?? '').toLowerCase();
  const normalizedTitle = String(title ?? '').toLowerCase();
  const normalizedBodyText = String(bodyText ?? '').toLowerCase();

  return (
    normalizedUrl.includes('linkedin.com/authwall') ||
    normalizedTitle.includes('sign up | linkedin') ||
    normalizedBodyText.includes('join linkedin to see more jobs') ||
    normalizedBodyText.includes('sign in to see more jobs') ||
    normalizedBodyText.includes('sign in to see who you already know') ||
    normalizedBodyText.includes('continue with email') && normalizedBodyText.includes('new to linkedin? join now')
  );
}

export function detectLinkedInSignInPromptText(bodyText = '') {
  const normalizedBodyText = String(bodyText ?? '').toLowerCase();
  return (
    normalizedBodyText.includes('new to linkedin? join now') ||
    normalizedBodyText.includes('sign in with email') ||
    normalizedBodyText.includes('sign in to see who you already know')
  );
}

export async function dismissLinkedInSignInPrompt(page) {
  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase()
    .slice(0, 6000);

  if (!detectLinkedInSignInPromptText(bodyText)) {
    return false;
  }

  const selectors = [
    'button[aria-label*="Dismiss" i]',
    'button[aria-label*="Close" i]',
    'button[aria-label*="close modal" i]',
    '.artdeco-modal__dismiss',
    '.contextual-sign-in-modal__modal-dismiss-icon',
    '.contextual-sign-in-modal button[aria-label]'
  ];

  for (const selector of selectors) {
    try {
      const candidate = page.locator(selector).first();
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        await candidate.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(1000);
        return true;
      }
    } catch {
      // Try next selector.
    }
  }

  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  } catch {
    // Ignore.
  }

  const afterText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase()
    .slice(0, 6000);
  return !detectLinkedInSignInPromptText(afterText);
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

    const hasVisibleEmail = await emailInput.isVisible({ timeout: 700 }).catch(() => false);
    const hasVisiblePassword = await page
      .locator(passwordSelector)
      .first()
      .isVisible({ timeout: 700 })
      .catch(() => false);

    if (!hasVisibleEmail && !hasVisiblePassword) {
      const openedLogin = await tryClickByText(page, ['log in', 'sign in', 'continue with email']);
      if (openedLogin) {
        await page.waitForTimeout(1800);
      }
    }

    if (await emailInput.isVisible({ timeout: 1200 }).catch(() => false)) {
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
    if (!(await passwordInput.isVisible({ timeout: 2000 }).catch(() => false))) {
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
