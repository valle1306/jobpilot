import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  repoRoot,
  resolveCodexApplyConfig,
  resolveCodexConfig
} from './config.mjs';
import {
  dateSlug,
  ensureDir,
  normalizeWhitespace,
  writeJson,
  writeText
} from './utils.mjs';

function buildWorkspaceName(job, host = '') {
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
  const hostSlug = String(host ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${dateSlug()}-${company || 'company'}-${title || 'job'}-${hostSlug || 'apply'}`;
}

export function shouldUseCodexApplyAssist(targetUrl = '', profile = {}) {
  const config = resolveCodexApplyConfig(profile);
  if (!config.enabled) {
    return false;
  }

  const normalized = String(targetUrl ?? '').toLowerCase();
  return config.hostPatterns.some((pattern) => normalized.includes(pattern));
}

function buildPrompt({ job, host, round }) {
  return `You are assisting browser automation for a job application on a difficult ATS host.

Read these files in the current directory:
- page-state.json
- candidate-profile.json

Task:
- Return JSON only matching the provided schema.
- Your goal is to help Playwright finish this application step safely.
- Prefer guest/manual apply paths over account creation when possible.
- Do not invent credentials, work history, degrees, or answers not supported by candidate-profile.json.
- If the page is blocked by login, verification, CAPTCHA, or a code challenge, set pause_for_human to true.
- Only reference fields and visible actions that appear in page-state.json.
- Keep the action list short and high-signal. Use at most the actions needed for the next browser step.
- Favor concrete form actions over commentary.

Allowed action kinds:
- fill_field
- select_field
- set_checkbox
- click_text
- wait
- none

Context:
- ATS host: ${host || 'unknown'}
- Job title: ${job.title || 'Unknown'}
- Company: ${job.company || 'Unknown'}
- Assistance round: ${round}

When finished, respond with JSON only matching the provided schema.`;
}

function buildResponseSchema(maxActions = 6) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      pause_for_human: { type: 'boolean' },
      pause_reason: { type: 'string' },
      actions: {
        type: 'array',
        maxItems: maxActions,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string' },
            target: { type: 'string' },
            value: { type: 'string' },
            rationale: { type: 'string' }
          },
          required: ['kind', 'target', 'value', 'rationale']
        }
      }
    },
    required: ['summary', 'pause_for_human', 'pause_reason', 'actions']
  };
}

function parsePlan(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim());
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions
          .map((action) => ({
            kind: normalizeWhitespace(action.kind ?? '').toLowerCase(),
            target: normalizeWhitespace(action.target ?? ''),
            value: normalizeWhitespace(action.value ?? ''),
            rationale: normalizeWhitespace(action.rationale ?? '')
          }))
          .filter((action) => action.kind)
      : [];

    return {
      summary: normalizeWhitespace(parsed.summary ?? ''),
      pauseForHuman: Boolean(parsed.pause_for_human),
      pauseReason: normalizeWhitespace(parsed.pause_reason ?? ''),
      actions
    };
  } catch {
    return {
      summary: '',
      pauseForHuman: false,
      pauseReason: '',
      actions: []
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
            normalizeWhitespace(stderr || stdout || `Codex CLI exited with code ${code}.`)
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

export async function planApplyWithCodexCli({
  profile,
  job,
  host = '',
  pageState,
  candidateProfile,
  round = 1
}) {
  const codexConfig = resolveCodexConfig(profile);
  const applyConfig = resolveCodexApplyConfig(profile);
  if (!codexConfig.enabled) {
    throw new Error('Codex CLI apply assistance is disabled.');
  }
  if (!codexConfig.available) {
    throw new Error('Codex CLI executable was not found.');
  }

  const workspaceDir = path.join(
    repoRoot,
    'runs',
    'codex-apply',
    buildWorkspaceName(job, host)
  );
  const pageStatePath = path.join(workspaceDir, 'page-state.json');
  const candidateProfilePath = path.join(workspaceDir, 'candidate-profile.json');
  const schemaPath = path.join(workspaceDir, 'response-schema.json');
  const outputPath = path.join(workspaceDir, 'response.json');

  await ensureDir(workspaceDir);
  await writeJson(pageStatePath, pageState);
  await writeJson(candidateProfilePath, candidateProfile);
  await writeJson(schemaPath, buildResponseSchema(applyConfig.maxActionsPerRound));
  await writeText(
    path.join(workspaceDir, 'prompt.txt'),
    buildPrompt({ job, host, round })
  );

  await runCodexExec({
    codexPath: codexConfig.cliPath,
    cwd: workspaceDir,
    prompt: buildPrompt({ job, host, round }),
    schemaPath,
    outputPath,
    config: codexConfig
  });

  const response = parsePlan(await fs.readFile(outputPath, 'utf8').catch(() => ''));
  return {
    ...response,
    model: codexConfig.model || 'default',
    method: 'codex-cli'
  };
}
