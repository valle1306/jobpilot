import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  classifyRoleType,
  preferredResumePath,
  repoRoot,
  resolveRepoPath
} from './config.mjs';
import { dateSlug, ensureDir, fileExists, nowIso, slugify, sleep, truncate, writeText } from './utils.mjs';
import { gotoAndSettle, launchBrowserContext, promptForManualStep, detectLoginPage, attemptLogin } from './browser.mjs';
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

async function maybeDownloadOverleafPdf({
  profile,
  outputPath,
  headless = false,
  existingContext = null
}) {
  const ownsContext = !existingContext;
  const context = existingContext ?? (await launchBrowserContext({ headless }));

  try {
    const page = await context.newPage();
    const projectUrl = `https://www.overleaf.com/project/${profile.overleaf.projectId}`;
    const pdfUrl = `https://www.overleaf.com/project/${profile.overleaf.projectId}/output/output.pdf`;

    await gotoAndSettle(page, projectUrl);

    if (await detectLoginPage(page)) {
      const credentials =
        profile.overleaf?.email && profile.overleaf?.webPassword
          ? { email: profile.overleaf.email, password: profile.overleaf.webPassword }
          : null;

      if (credentials) {
        await attemptLogin(page, credentials);
      } else {
        await promptForManualStep(
          'Overleaf requires website login before PDF download. Sign in manually in the opened browser.'
        );
      }
    }

    await sleep(10000);
    const response = await page.goto(pdfUrl, { waitUntil: 'networkidle' });
    if (!response || !response.ok()) {
      throw new Error('Failed to fetch compiled PDF from Overleaf.');
    }

    const buffer = await response.body();
    await ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, buffer);
    await page.close().catch(() => {});
    return outputPath;
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
  context = null
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
    existingContext: context
  });
}

export async function tailorJob({
  profile,
  job,
  headless = false,
  downloadPdf = true,
  context = null
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
  const keywords = extractTailorKeywords(`${job.title}\n${job.description}`, originalTex);
  const { texContent, addedKeywords } = applySafeTailoring(originalTex, keywords);

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
      existingContext: context
    });
  }

  return {
    roleType,
    texFile,
    addedKeywords,
    tag,
    tailoredResumePath
  };
}
