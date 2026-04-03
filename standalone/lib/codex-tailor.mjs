import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot, resolveCodexConfig } from './config.mjs';
import { dateSlug, ensureDir, normalizeWhitespace, uniqueBy, writeJson, writeText } from './utils.mjs';

function buildPrompt({ job, texFile }) {
  return `You are tailoring a one-page LaTeX resume for a job application.

Read these files in the current directory:
- resume.tex
- job.md

Task:
- Edit only resume.tex in place.
- Improve alignment to the job description while staying truthful.
- Keep the resume one page and preserve the overall LaTeX template structure.
- Prefer tightening or swapping wording in existing bullets rather than adding new length.
- Do not add packages, sections, commands, or invented achievements.
- Do not change contact information, links, dates, company names, or degree facts.
- You may update bullet wording, ordering within a bullet, and technical-skills wording if it improves ATS fit.
- If the current resume is already a safe fit, leave resume.tex unchanged.

Context:
- Target template file name: ${texFile}
- Job title: ${job.title}
- Company: ${job.company}

When finished, respond with JSON only matching the provided schema.`;
}

function buildJobMarkdown(job) {
  return `# Job

Title: ${job.title || 'Unknown'}
Company: ${job.company || 'Unknown'}
Location: ${job.location || 'Unknown'}
URL: ${job.url || ''}

## Description
${String(job.description ?? '').slice(0, 16000)}`;
}

function buildResponseSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      changed: { type: 'boolean' },
      keywords_added: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 12
      },
      notes: { type: 'string' }
    },
    required: ['summary', 'changed', 'keywords_added', 'notes']
  };
}

function parseFinalResponse(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim());
    return {
      summary: normalizeWhitespace(parsed.summary ?? ''),
      changed: Boolean(parsed.changed),
      keywordsAdded: uniqueBy(
        (parsed.keywords_added ?? [])
          .map((value) => normalizeWhitespace(value))
          .filter(Boolean),
        (value) => value.toLowerCase()
      ),
      notes: normalizeWhitespace(parsed.notes ?? '')
    };
  } catch {
    return {
      summary: '',
      changed: false,
      keywordsAdded: [],
      notes: ''
    };
  }
}

async function runCodexExec({ codexPath, cwd, prompt, schemaPath, outputPath, config }) {
  const codexArgs = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--full-auto',
    '--sandbox',
    config.sandbox,
    '--color',
    'never',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    '-'
  ];

  if (config.model) {
    codexArgs.splice(1, 0, '--model', config.model);
  }

  const childEnv = { ...process.env };
  if (config.apiKey) {
    childEnv[config.apiKeyEnvVar] = config.apiKey;
  }

  const usesCmdLauncher = /\.cmd$/i.test(codexPath) || /\.bat$/i.test(codexPath);
  const command = usesCmdLauncher ? 'cmd.exe' : codexPath;
  const args = usesCmdLauncher ? ['/c', codexPath, ...codexArgs] : codexArgs;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            normalizeWhitespace(
              stderr || stdout || `Codex CLI exited with code ${code}.`
            )
          )
        );
        return;
      }

      resolve({ stdout, stderr });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildWorkspaceName(job) {
  const title = String(job.title ?? 'job')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const company = String(job.company ?? 'company')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${dateSlug()}-${company || 'company'}-${title || 'job'}`;
}

export async function tailorResumeWithCodexCli({ profile, job, texContent, roleType, texFile }) {
  const config = resolveCodexConfig(profile);
  if (!config.enabled) {
    throw new Error('Codex CLI tailoring is disabled.');
  }
  if (!config.available) {
    throw new Error('Codex CLI executable was not found.');
  }

  const workspaceDir = path.join(repoRoot, 'runs', 'codex-tailor', buildWorkspaceName(job));
  const resumePath = path.join(workspaceDir, 'resume.tex');
  const jobPath = path.join(workspaceDir, 'job.md');
  const schemaPath = path.join(workspaceDir, 'response-schema.json');
  const outputPath = path.join(workspaceDir, 'response.json');

  await ensureDir(workspaceDir);
  await writeText(resumePath, texContent);
  await writeText(jobPath, buildJobMarkdown(job));
  await writeJson(schemaPath, buildResponseSchema());

  await runCodexExec({
    codexPath: config.cliPath,
    cwd: workspaceDir,
    prompt: buildPrompt({ job, texFile, roleType }),
    schemaPath,
    outputPath,
    config
  });

  const editedTex = await fs.readFile(resumePath, 'utf8');
  const response = parseFinalResponse(await fs.readFile(outputPath, 'utf8').catch(() => ''));
  const changed = editedTex !== texContent;
  const warning = changed
    ? ''
    : 'Codex made no resume edits; keeping the existing resume content.';

  return {
    texContent: editedTex,
    addedKeywords: response.keywordsAdded,
    summary: response.summary || response.notes || 'Codex CLI tailoring completed.',
    acceptedEdits: [],
    warning,
    model: config.model || 'default',
    method: 'codex-cli'
  };
}
