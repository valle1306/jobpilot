import { resolveOpenAIConfig } from './config.mjs';
import { normalizeWhitespace, uniqueBy } from './utils.mjs';

const ALLOWED_SECTIONS = new Set(['Experience', 'Projects']);
const FORBIDDEN_LATEX_TOKENS = [
  '\\documentclass',
  '\\usepackage',
  '\\begin{document}',
  '\\end{document}',
  '\\section{',
  '\\resumeSubheading{',
  '\\resumeProjectHeading{',
  '\\newcommand',
  '\\input{',
  '\\include{'
];

function parseCommandArgs(line, commandName) {
  const token = `\\${commandName}`;
  const start = line.indexOf(token);
  if (start === -1) {
    return [];
  }

  const args = [];
  let index = start + token.length;
  while (index < line.length) {
    while (line[index] === ' ' || line[index] === '\t') {
      index += 1;
    }

    if (line[index] !== '{') {
      break;
    }

    let depth = 0;
    let value = '';
    for (; index < line.length; index += 1) {
      const char = line[index];
      if (char === '{') {
        depth += 1;
        if (depth > 1) {
          value += char;
        }
        continue;
      }

      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          args.push(value);
          index += 1;
          break;
        }
      }

      if (depth >= 1) {
        value += char;
      }
    }
  }

  return args;
}

function stripLatex(value) {
  return normalizeWhitespace(
    String(value ?? '')
      .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
      .replace(/\\textbf\{([^}]*)\}/g, '$1')
      .replace(/\\textit\{([^}]*)\}/g, '$1')
      .replace(/\\underline\{([^}]*)\}/g, '$1')
      .replace(/\\textcolor\{[^}]*\}\{([^}]*)\}/g, '$1')
      .replace(/\\emph\{([^}]*)\}/g, '$1')
      .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
      .replace(/[{}\\]/g, ' ')
  );
}

function balancedBraces(value) {
  let depth = 0;
  for (const char of value) {
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }

  return depth === 0;
}

function extractUrls(line) {
  return [...String(line ?? '').matchAll(/https?:\/\/[^}\s]+/g)].map((match) => match[0]);
}

function extractSkillsSection(texContent) {
  const lines = texContent.split(/\r?\n/);
  const skillsStart = lines.findIndex((line) => line.includes('\\section{Technical Skills}'));
  if (skillsStart === -1) {
    return '';
  }

  const nextSection = lines.findIndex(
    (line, index) => index > skillsStart && line.trim().startsWith('\\section{')
  );
  const end = nextSection === -1 ? lines.length : nextSection;
  return lines.slice(skillsStart, end).join('\n');
}

export function extractCandidateBullets(texContent) {
  const lines = texContent.split(/\r?\n/);
  const bullets = [];
  let section = '';
  let currentEntry = {
    entryKey: 'general',
    contextLabel: 'General'
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith('\\section{')) {
      const sectionName = parseCommandArgs(trimmed, 'section')[0] ?? '';
      section = stripLatex(sectionName);
      continue;
    }

    if (trimmed.startsWith('\\resumeSubheading{')) {
      const args = parseCommandArgs(trimmed, 'resumeSubheading');
      const company = stripLatex(args[0] ?? 'Company');
      const role = stripLatex(args[2] ?? 'Role');
      currentEntry = {
        entryKey: `${section}:${company}:${role}`,
        contextLabel: `${role} at ${company}`,
        section
      };
      continue;
    }

    if (trimmed.startsWith('\\resumeProjectHeading{')) {
      const args = parseCommandArgs(trimmed, 'resumeProjectHeading');
      const project = stripLatex(args[0] ?? 'Project');
      currentEntry = {
        entryKey: `${section}:${project}`,
        contextLabel: project,
        section
      };
      continue;
    }

    if (!ALLOWED_SECTIONS.has(section)) {
      continue;
    }

    if (trimmed.startsWith('\\resumeItem{')) {
      bullets.push({
        id: `b${bullets.length + 1}`,
        lineIndex: index,
        originalLine: trimmed,
        originalLength: trimmed.length,
        section,
        entryKey: currentEntry.entryKey,
        contextLabel: currentEntry.contextLabel,
        containsLink: trimmed.includes('\\href{'),
        urls: extractUrls(trimmed)
      });
    }
  }

  return bullets;
}

function buildPrompt({ job, roleType, texFile, bullets, texContent, config }) {
  const bulletList = bullets
    .map(
      (bullet) =>
        `- ${bullet.id} | ${bullet.contextLabel} | len=${bullet.originalLength} | ${bullet.originalLine}`
    )
    .join('\n');

  return `Tailor this one-page Overleaf resume for the job below.

Hard rules:
- Only rewrite bullet lines from the provided candidate list.
- Keep every replacement as a single LaTeX line beginning with \\resumeItem{ and ending with }.
- Preserve all claims, metrics, company names, dates, URLs, and links. Do not fabricate experience.
- Keep the resume one page: do not materially lengthen bullets. Prefer tightening wording while adding relevant keywords.
- Use at most ${config.maxBulletEdits} bullet edits total.
- Use at most ${config.maxBulletsPerEntry} bullet edits per experience or project entry.
- If the resume already fits well, return fewer edits or an empty list.

Target role type: ${roleType}
Template file: ${texFile}

Job title: ${job.title}
Company: ${job.company}
Job description:
${String(job.description ?? '').slice(0, 12000)}

Current technical skills section:
${extractSkillsSection(texContent)}

Candidate bullet lines:
${bulletList}`;
}

function buildResponseSchema(config) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      bullet_edits: {
        type: 'array',
        maxItems: config.maxBulletEdits,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bullet_id: { type: 'string' },
            replacement_line: { type: 'string' },
            reason: { type: 'string' },
            keywords_added: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 8
            }
          },
          required: ['bullet_id', 'replacement_line', 'reason', 'keywords_added']
        }
      }
    },
    required: ['summary', 'bullet_edits']
  };
}

function extractResponseText(payload) {
  if (typeof payload.choices?.[0]?.message?.content === 'string') {
    return payload.choices[0].message.content;
  }

  if (Array.isArray(payload.output)) {
    const chunks = [];
    for (const item of payload.output) {
      for (const content of item.content ?? []) {
        if (typeof content.text === 'string') {
          chunks.push(content.text);
        } else if (typeof content.value === 'string') {
          chunks.push(content.value);
        }
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n');
    }
  }

  return '';
}

async function requestOpenAITailoring({ apiKey, prompt, config }) {
  const body = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          'You are a careful resume editor for Overleaf LaTeX resumes. Return only valid JSON matching the schema.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'resume_tailoring_plan',
        strict: true,
        schema: buildResponseSchema(config)
      }
    }
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || 'OpenAI API request failed.');
  }

  const content = extractResponseText(payload);
  if (!content) {
    throw new Error('OpenAI API returned no structured tailoring content.');
  }

  return JSON.parse(content);
}

export function applyTailoringPlan({ texContent, bullets, plan, config }) {
  const lines = texContent.split(/\r?\n/);
  const bulletById = new Map(bullets.map((bullet) => [bullet.id, bullet]));
  const acceptedEdits = [];
  const entryCounts = new Map();
  let totalAddedChars = 0;

  for (const edit of plan.bullet_edits ?? []) {
    const bullet = bulletById.get(edit.bullet_id);
    if (!bullet) {
      continue;
    }

    if (acceptedEdits.some((item) => item.bullet.id === bullet.id)) {
      continue;
    }

    const nextEntryCount = (entryCounts.get(bullet.entryKey) ?? 0) + 1;
    if (nextEntryCount > config.maxBulletsPerEntry) {
      continue;
    }

    const replacementLine = String(edit.replacement_line ?? '').trim();
    if (!replacementLine.startsWith('\\resumeItem{')) {
      continue;
    }
    if (replacementLine.includes('\n') || replacementLine.includes('\r')) {
      continue;
    }
    if (!balancedBraces(replacementLine)) {
      continue;
    }
    if (FORBIDDEN_LATEX_TOKENS.some((token) => replacementLine.includes(token))) {
      continue;
    }
    if (replacementLine.length > bullet.originalLength + config.maxExtraCharsPerBullet) {
      continue;
    }
    if (replacementLine === bullet.originalLine) {
      continue;
    }
    if (bullet.urls.some((url) => !replacementLine.includes(url))) {
      continue;
    }

    const delta = replacementLine.length - bullet.originalLength;
    if (totalAddedChars + Math.max(0, delta) > config.maxTotalAddedChars) {
      continue;
    }

    lines[bullet.lineIndex] = lines[bullet.lineIndex].replace(bullet.originalLine, replacementLine);
    acceptedEdits.push({
      bullet,
      replacementLine,
      reason: String(edit.reason ?? '').trim(),
      keywordsAdded: uniqueBy(
        (edit.keywords_added ?? [])
          .map((value) => normalizeWhitespace(value))
          .filter(Boolean),
        (value) => value.toLowerCase()
      )
    });
    entryCounts.set(bullet.entryKey, nextEntryCount);
    totalAddedChars += Math.max(0, delta);
  }

  if (acceptedEdits.length === 0) {
    throw new Error('OpenAI tailoring did not produce any safe bullet edits.');
  }

  return {
    texContent: lines.join('\n'),
    acceptedEdits,
    addedKeywords: uniqueBy(
      acceptedEdits.flatMap((edit) => edit.keywordsAdded),
      (value) => value.toLowerCase()
    )
  };
}

export async function tailorResumeWithOpenAI({ profile, job, texContent, roleType, texFile }) {
  const config = resolveOpenAIConfig(profile);
  if (!config.enabled) {
    throw new Error('OpenAI tailoring is disabled.');
  }
  if (!config.apiKey) {
    throw new Error(
      `OpenAI API key not found. Set ${config.apiKeyEnvVar} in your environment or .env file.`
    );
  }

  const bullets = extractCandidateBullets(texContent);
  if (bullets.length === 0) {
    throw new Error('No candidate resume bullets were found for OpenAI tailoring.');
  }

  const prompt = buildPrompt({
    job,
    roleType,
    texFile,
    bullets,
    texContent,
    config
  });

  const plan = await requestOpenAITailoring({
    apiKey: config.apiKey,
    prompt,
    config
  });

  const applied = applyTailoringPlan({
    texContent,
    bullets,
    plan,
    config
  });

  return {
    texContent: applied.texContent,
    addedKeywords: applied.addedKeywords,
    summary: normalizeWhitespace(plan.summary),
    acceptedEdits: applied.acceptedEdits,
    model: config.model,
    method: 'openai'
  };
}
