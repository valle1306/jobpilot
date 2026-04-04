import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { repoRoot, resolveCodexConfig } from './config.mjs';
import {
  dateSlug,
  ensureDir,
  normalizeWhitespace,
  uniqueBy,
  writeJson,
  writeText
} from './utils.mjs';

function buildWorkspaceName(query = 'autorun') {
  const querySlug = String(query ?? 'autorun')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${dateSlug()}-${querySlug || 'autorun'}`;
}

function trimDescription(value, limit = 1800) {
  const normalized = normalizeWhitespace(String(value ?? ''));
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

function buildPrompt({
  query,
  maxApplications,
  minMatchScore,
  executionMode,
  postedWithinHours,
  guidanceConfig
}) {
  return `You are guiding an autonomous job-application run, similar to an interactive job-search agent.

Read these files in the current directory:
- jobs.json
- candidate-profile.json
- resume.txt

Task:
- Return JSON only matching the provided schema.
- Choose which jobs this run should apply to.
- Prefer entry-level or early-career roles that fit the resume well.
- Prefer direct external apply targets that look feasible to complete.
- In unattended-safe mode, be conservative but not overly rigid: if a role is a plausible fit and has a direct external apply target, you may still select it even when heuristic signals are mixed.
- Never select jobs marked as hard_blocked in jobs.json.
- Use match score, title, company, description, location, apply host, and soft warning signals together rather than treating any one heuristic as absolute.
- If there are viable jobs, choose the best ones instead of returning an empty selection just because a heuristic is imperfect.
- Avoid senior / lead / manager roles unless the description still clearly reads as early-career.
- Keep your reasons short and concrete.

Run context:
- Query set: ${query}
- Max applications this run: ${maxApplications}
- Heuristic minimum match score: ${minMatchScore}
- Execution mode: ${executionMode}
- Posting window filter: ${postedWithinHours > 0 ? `${postedWithinHours} hours` : 'disabled'}
- Codex rescue floor: ${guidanceConfig.rescueMinScore}

When finished, respond with JSON only matching the schema.`;
}

function buildResponseSchema(maxApplications = 5) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      selected: {
        type: 'array',
        maxItems: Math.max(1, maxApplications),
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'integer' },
            priority: { type: 'integer' },
            reason: { type: 'string' }
          },
          required: ['id', 'priority', 'reason']
        }
      }
    },
    required: ['summary', 'selected']
  };
}

function parseResponse(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim());
    const selected = Array.isArray(parsed.selected)
      ? uniqueBy(
          parsed.selected
            .map((entry) => ({
              id: Number(entry.id),
              priority: Number.isFinite(Number(entry.priority)) ? Number(entry.priority) : 999,
              reason: normalizeWhitespace(entry.reason ?? '')
            }))
            .filter((entry) => Number.isFinite(entry.id)),
          (entry) => String(entry.id)
        )
      : [];

    return {
      summary: normalizeWhitespace(parsed.summary ?? ''),
      selected
    };
  } catch {
    return {
      summary: '',
      selected: []
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

function buildCandidateProfile(profile, standaloneConfig, resumeText = '') {
  return {
    workAuthorization: profile.workAuthorization ?? {},
    preferredLocations:
      standaloneConfig.preferredLocations ??
      profile.workAuthorization?.preferredLocations ??
      [],
    entryLevelOnly: standaloneConfig.entryLevelOnly !== false,
    entryLevelMaxYears: Number(standaloneConfig.entryLevelMaxYears ?? 3) || 3,
    skipTitleKeywords: [
      ...(profile.autopilot?.skipTitleKeywords ?? []),
      ...(standaloneConfig.skipTitleKeywords ?? [])
    ],
    targetQueries: Array.isArray(standaloneConfig.queries) ? standaloneConfig.queries : [],
    resumeExcerpt: trimDescription(resumeText, 4000)
  };
}

function toReviewJob(job) {
  return {
    id: job.id,
    title: job.title ?? '',
    company: job.company ?? '',
    location: job.location ?? '',
    board: job.board ?? '',
    url: job.url ?? '',
    sourceUrl: job.sourceUrl ?? '',
    applyUrl: job.applyUrl ?? '',
    applyHost: job.applyHost ?? '',
    applyTier: job.applyTier ?? 0,
    matchScore: job.matchScore ?? 0,
    matchReason: job.matchReason ?? '',
    sourceQueries: Array.isArray(job.sourceQueries) ? job.sourceQueries : [],
    matchedKeywords: Array.isArray(job.matchedKeywords) ? job.matchedKeywords : [],
    missingKeywords: Array.isArray(job.missingKeywords) ? job.missingKeywords : [],
    hard_blocked: job.hardBlocked === true,
    hard_block_reason: job.hardBlockReason ?? '',
    soft_warnings: Array.isArray(job.softWarnings) ? job.softWarnings : [],
    description: trimDescription(job.description, 2200)
  };
}

export async function reviewAutopilotJobsWithCodexCli({
  profile,
  query,
  jobs,
  resumeText = '',
  standaloneConfig = {},
  maxApplications = 5,
  minMatchScore = 6,
  executionMode = 'unattended-safe',
  postedWithinHours = 0,
  guidanceConfig
}) {
  const config = resolveCodexConfig(profile);
  if (!config.enabled) {
    throw new Error('Codex CLI run guidance is disabled.');
  }
  if (!config.available) {
    throw new Error('Codex CLI executable was not found.');
  }

  const workspaceDir = path.join(
    repoRoot,
    'runs',
    'codex-review',
    buildWorkspaceName(query)
  );
  const jobsPath = path.join(workspaceDir, 'jobs.json');
  const candidateProfilePath = path.join(workspaceDir, 'candidate-profile.json');
  const resumePath = path.join(workspaceDir, 'resume.txt');
  const schemaPath = path.join(workspaceDir, 'response-schema.json');
  const outputPath = path.join(workspaceDir, 'response.json');

  await ensureDir(workspaceDir);
  await writeJson(jobsPath, jobs.map((job) => toReviewJob(job)));
  await writeJson(
    candidateProfilePath,
    buildCandidateProfile(profile, standaloneConfig, resumeText)
  );
  await writeText(resumePath, trimDescription(resumeText, 12000));
  await writeJson(schemaPath, buildResponseSchema(maxApplications));

  const prompt = buildPrompt({
    query,
    maxApplications,
    minMatchScore,
    executionMode,
    postedWithinHours,
    guidanceConfig
  });
  await writeText(path.join(workspaceDir, 'prompt.txt'), prompt);

  await runCodexExec({
    codexPath: config.cliPath,
    cwd: workspaceDir,
    prompt,
    schemaPath,
    outputPath,
    config
  });

  const response = parseResponse(await fs.readFile(outputPath, 'utf8').catch(() => ''));
  return {
    ...response,
    model: config.model || 'default',
    method: 'codex-cli'
  };
}
