import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  classifyRoleType,
  preferredResumePath,
  resolveCodexConfig,
  resolveOpenAIConfig,
  resolveRepoPath
} from './config.mjs';
import { dateSlug, ensureDir, fileExists, slugify, sleep, truncate, writeText } from './utils.mjs';
import {
  gotoAndSettle,
  launchBrowserContext,
  promptForManualStep,
  detectHumanChallenge,
  attemptLogin,
  tryClickByText
} from './browser.mjs';
import { tailorResumeWithCodexCli } from './codex-tailor.mjs';
import { tailorResumeWithOpenAI } from './openai-tailor.mjs';
import { topKeywords } from './scoring.mjs';

const execFileAsync = promisify(execFile);

const categoryMap = {
  programming: ['python', 'r', 'sql', 'java', 'scala', 'javascript', 'typescript', 'c++'],
  ml: ['spark', 'pytorch', 'tensorflow', 'scikit-learn', 'llm', 'nlp', 'dbt', 'airflow', 'databricks'],
  visualization: ['tableau', 'powerbi', 'looker', 'plotly'],
  systems: ['aws', 'gcp', 'azure', 'snowflake', 'bigquery', 'redshift', 'kafka']
};

function inferCategory(keyword) {
  const normalized = keyword.toLowerCase();
  if (categoryMap.programming.includes(normalized)) {
    return 'programming';
  }
  if (categoryMap.ml.includes(normalized)) {
    return 'ml';
  }
  if (categoryMap.visualization.includes(normalized)) {
    return 'visualization';
  }
  if (categoryMap.systems.includes(normalized)) {
    return 'systems';
  }
  return null;
}

function extractTailorKeywords(jobText, texContent, limit = 8) {
  const candidates = topKeywords(jobText, 32);
  const existing = texContent.toLowerCase();

  return candidates
    .filter((keyword) => inferCategory(keyword))
    .filter((keyword) => !existing.includes(keyword.toLowerCase()))
    .slice(0, limit);
}

function applySafeTailoring(texContent, keywords) {
  const lines = texContent.split(/\r?\n/);
  const added = [];

  const enrichLine = (line, categoryName) => {
    const candidates = keywords.filter((keyword) => inferCategory(keyword) === categoryName);
    if (candidates.length === 0) {
      return line;
    }

    const missing = candidates.filter((keyword) => !line.toLowerCase().includes(keyword.toLowerCase()));
    if (missing.length === 0) {
      return line;
    }

    added.push(...missing.slice(0, 2));
    return `${line}, ${missing.slice(0, 2).join(', ')}`;
  };

  const updated = lines.map((line) => {
    if (/programming/i.test(line)) {
      return enrichLine(line, 'programming');
    }
    if (/ml|analytics/i.test(line)) {
      return enrichLine(line, 'ml');
    }
    if (/visual/i.test(line)) {
      return enrichLine(line, 'visualization');
    }
    if (/tools|systems|cloud/i.test(line)) {
      return enrichLine(line, 'systems');
    }
    return line;
  });

  return {
    texContent: updated.join('\n'),
    addedKeywords: [...new Set(added)]
  };
}

async function runGit(args, cwd) {
  await execFileAsync('git', args, { cwd });
}

async function detectOverleafAuthRequired(page) {
  const url = page.url().toLowerCase();
  if (
    url.includes('overleaf.com/login') ||
    url.includes('launchpad.overleaf.com') ||
    url.includes('/register')
  ) {
    return true;
  }

  if ((await page.locator('input[type="password"]').count().catch(() => 0)) > 0) {
    return true;
  }

  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase()
    .slice(0, 3000);
  return (
    bodyText.includes('log in to overleaf') ||
    bodyText.includes('sign in to overleaf') ||
    bodyText.includes('continue with email') ||
    bodyText.includes('restricted, sorry you don') ||
    bodyText.includes("you don't have permission to load this page")
  );
}

async function waitForOverleafEditor(page) {
  const readyLocators = [
    page.getByRole('button', { name: /recompile/i }).first(),
    page.getByRole('button', { name: /download pdf/i }).first(),
    page.locator('[aria-label*="Recompile" i], [title*="Recompile" i]').first()
  ];

  for (const locator of readyLocators) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 6000 });
      return true;
    } catch {
      // Try the next readiness signal.
    }
  }

  const bodyText = (await page.locator('body').innerText().catch(() => ''))
    .toLowerCase()
    .slice(0, 4000);
  return bodyText.includes('recompile') || bodyText.includes('download pdf');
}

async function clickOverleafDownloadPdf(page) {
  const directTargets = [
    page.getByRole('button', { name: /download pdf/i }).first(),
    page.getByRole('link', { name: /download pdf/i }).first(),
    page.locator('[aria-label*="Download PDF" i], [title*="Download PDF" i]').first(),
    page.locator('text=/download pdf/i').first()
  ];

  for (const target of directTargets) {
    try {
      if (await target.isVisible({ timeout: 800 })) {
        await target.click({ timeout: 2000 });
        return true;
      }
    } catch {
      // Keep trying.
    }
  }

  const menuOpened =
    (await tryClickByText(page, ['menu'])) ||
    (await tryClickByText(page, ['file']));

  if (!menuOpened) {
    return false;
  }

  await page.waitForTimeout(800);

  for (const label of ['download pdf', 'download as pdf', 'pdf']) {
    const clicked = await tryClickByText(page, [label]);
    if (clicked) {
      return true;
    }
  }

  return false;
}

async function downloadOverleafPdf(page, outputPath) {
  await ensureDir(path.dirname(outputPath));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    const clicked = await clickOverleafDownloadPdf(page);
    if (!clicked) {
      continue;
    }

    const download = await downloadPromise;
    if (!download) {
      continue;
    }

    await download.saveAs(outputPath);
    return outputPath;
  }

  return '';
}

async function ensureOverleafSession(page, profile, allowManualPrompt, projectUrl = '') {
  const credentials =
    profile.overleaf?.email && profile.overleaf?.webPassword
      ? { email: profile.overleaf.email, password: profile.overleaf.webPassword }
      : null;

  if (!(await detectOverleafAuthRequired(page))) {
    return;
  }

  if (credentials) {
    await attemptLogin(page, credentials);
    await page.waitForTimeout(2500);

    if (projectUrl) {
      await gotoAndSettle(page, projectUrl);
    }
  }

  const challenge = await detectHumanChallenge(page);
  if (challenge || (await detectOverleafAuthRequired(page))) {
    const message = challenge
      ? `Overleaf website login requires manual ${challenge} verification.`
      : 'Overleaf website login requires manual verification.';

    if (!allowManualPrompt) {
      throw new Error(message);
    }

    await promptForManualStep(
      'Overleaf still needs a manual sign-in or verification step in the opened browser.',
      { allowPrompt: allowManualPrompt }
    );
  }
}

export async function bootstrapOverleafSession({
  profile,
  headless = false,
  context = null,
  allowManualPrompt = true
}) {
  const ownsContext = !context;
  const browserContext = context ?? (await launchBrowserContext({ headless }));

  try {
    const page = await browserContext.newPage();
    const projectUrl = `https://www.overleaf.com/project/${profile.overleaf.projectId}`;

    await gotoAndSettle(page, projectUrl);
    await ensureOverleafSession(page, profile, allowManualPrompt, projectUrl);
    const editorReady = await waitForOverleafEditor(page);
    if (!editorReady) {
      throw new Error('Overleaf editor did not finish loading after sign-in.');
    }

    await tryClickByText(page, ['recompile']);
    await sleep(6000);

    const downloadedPath = await downloadOverleafPdf(
      page,
      resolveRepoPath(path.join(profile.overleaf.tailoredOutputDir, 'overleaf-session-check.pdf'))
    );
    if (!downloadedPath) {
      throw new Error('Overleaf session was created, but the compiled PDF could not be downloaded from the editor.');
    }

    await page.close().catch(() => {});
    return { ok: true };
  } finally {
    if (ownsContext) {
      await browserContext.close().catch(() => {});
    }
  }
}

async function maybeDownloadOverleafPdf({
  profile,
  outputPath,
  headless = false,
  existingContext = null,
  allowManualPrompt = true
}) {
  const ownsContext = !existingContext;
  const context = existingContext ?? (await launchBrowserContext({ headless }));

  try {
    const page = await context.newPage();
    const projectUrl = `https://www.overleaf.com/project/${profile.overleaf.projectId}`;

    await gotoAndSettle(page, projectUrl);
    await ensureOverleafSession(page, profile, allowManualPrompt, projectUrl);
    const editorReady = await waitForOverleafEditor(page);
    if (!editorReady) {
      throw new Error('Overleaf editor did not finish loading after sign-in.');
    }

    await tryClickByText(page, ['recompile']);
    await sleep(8000);

    let downloadedPath = await downloadOverleafPdf(page, outputPath);
    if (!downloadedPath && !headless) {
      await sleep(4000);
      downloadedPath = await downloadOverleafPdf(page, outputPath);
    }
    if (!downloadedPath) {
      if (await detectOverleafAuthRequired(page)) {
        throw new Error('Overleaf website login requires manual verification.');
      }
      throw new Error('Failed to download the compiled PDF from the Overleaf editor.');
    }

    await page.close().catch(() => {});
    return downloadedPath;
  } finally {
    if (ownsContext) {
      await context.close().catch(() => {});
    }
  }
}

export async function ensureUploadResumePath({
  profile,
  roleType = 'general-ds',
  tailoredResumePath = '',
  headless = false,
  context = null,
  allowManualPrompt = true
}) {
  if (tailoredResumePath && (await fileExists(resolveRepoPath(tailoredResumePath)))) {
    return resolveRepoPath(tailoredResumePath);
  }

  const preferredPath = preferredResumePath(profile, roleType);
  if (preferredPath && /\.(pdf|doc|docx)$/i.test(preferredPath)) {
    return preferredPath;
  }

  if (!profile.overleaf?.enabled) {
    return preferredPath;
  }

  const clonePath = resolveRepoPath(profile.overleaf.localClonePath);
  const mainTexPath = path.join(clonePath, 'main.tex');
  const sourcePath = preferredResumePath(profile, roleType);
  if (sourcePath && mainTexPath && sourcePath !== mainTexPath) {
    const sourceText = await fs.readFile(sourcePath, 'utf8');
    await writeText(mainTexPath, sourceText);
  }

  const outputPath = resolveRepoPath(
    path.join(profile.overleaf.tailoredOutputDir, `default-${slugify(roleType)}.pdf`)
  );
  return maybeDownloadOverleafPdf({
    profile,
    outputPath,
    headless,
    existingContext: context,
    allowManualPrompt
  });
}

export async function tailorJob({
  profile,
  job,
  headless = false,
  downloadPdf = true,
  context = null,
  allowManualPrompt = true
}) {
  const roleType = classifyRoleType(job.title, job.description);
  const clonePath = resolveRepoPath(profile.overleaf.localClonePath);
  const texFile = profile.overleaf?.texFiles?.[roleType];

  if (!clonePath || !texFile) {
    throw new Error('Overleaf clone path or tex file mapping is not configured.');
  }

  const texPath = path.join(clonePath, texFile);
  const mainTexPath = path.join(clonePath, 'main.tex');
  const originalTex = await fs.readFile(texPath, 'utf8');
  const codexConfig = resolveCodexConfig(profile);
  const openAIConfig = resolveOpenAIConfig(profile);

  let texContent = originalTex;
  let addedKeywords = [];
  let tailoringMethod = 'heuristic';
  let modelUsed = '';
  let tailoringSummary = '';
  let acceptedEdits = [];
  let tailoringWarning = '';

  if (codexConfig.enabled) {
    try {
      const tailoredByModel = await tailorResumeWithCodexCli({
        profile,
        job,
        texContent: originalTex,
        roleType,
        texFile
      });

      texContent = tailoredByModel.texContent;
      addedKeywords = tailoredByModel.addedKeywords;
      tailoringMethod = tailoredByModel.method;
      modelUsed = tailoredByModel.model;
      tailoringSummary = tailoredByModel.summary;
      acceptedEdits = tailoredByModel.acceptedEdits;
      tailoringWarning = tailoredByModel.warning || '';
    } catch (error) {
      tailoringWarning = error.message;
    }
  }

  if (tailoringMethod !== 'codex-cli' && openAIConfig.enabled && (!codexConfig.enabled || codexConfig.fallbackToOpenAI)) {
    try {
      const tailoredByModel = await tailorResumeWithOpenAI({
        profile,
        job,
        texContent: originalTex,
        roleType,
        texFile
      });

      texContent = tailoredByModel.texContent;
      addedKeywords = tailoredByModel.addedKeywords;
      tailoringMethod = tailoredByModel.method;
      modelUsed = tailoredByModel.model;
      tailoringSummary = tailoredByModel.summary;
      acceptedEdits = tailoredByModel.acceptedEdits;
      tailoringWarning = tailoredByModel.warning || '';
    } catch (error) {
      tailoringWarning = error.message;
    }
  }

  if (tailoringMethod !== 'openai' && tailoringMethod !== 'codex-cli') {
    const keywords = extractTailorKeywords(`${job.title}\n${job.description}`, originalTex);
    const heuristicResult = applySafeTailoring(originalTex, keywords);
    texContent = heuristicResult.texContent;
    addedKeywords = heuristicResult.addedKeywords;
  }

  await writeText(texPath, texContent);
  await writeText(mainTexPath, texContent);

  await runGit(['add', texFile, 'main.tex'], clonePath);
  const companySlug = slugify(job.company || 'company');
  const titleSlug = slugify(job.title || 'job');
  const tag = `${roleType}/${companySlug}-${dateSlug()}`;
  const commitMessage = `Tailored for ${truncate(job.title, 60)} at ${truncate(job.company, 40)}`;

  try {
    await runGit(['diff', '--cached', '--quiet'], clonePath);
  } catch {
    await runGit(['commit', '-m', commitMessage], clonePath);
    await runGit(['push', 'origin', 'master'], clonePath);
    try {
      await runGit(['tag', '-f', tag], clonePath);
      await runGit(['push', 'origin', '--force', tag], clonePath);
    } catch {
      // Tagging is best-effort in standalone mode.
    }
  }

  let tailoredResumePath = '';
  if (downloadPdf) {
    const outputPath = resolveRepoPath(
      path.join(
        profile.overleaf.tailoredOutputDir,
        `${companySlug}-${titleSlug}-${dateSlug()}.pdf`
      )
    );
    tailoredResumePath = await maybeDownloadOverleafPdf({
      profile,
      outputPath,
      headless,
      existingContext: context,
      allowManualPrompt
    });
  }

  return {
    roleType,
    texFile,
    addedKeywords,
    tag,
    tailoredResumePath,
    tailoringMethod,
    modelUsed,
    tailoringSummary,
    tailoringWarning,
    acceptedEdits
  };
}
