import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTailoringPlan, extractCandidateBullets } from '../lib/openai-tailor.mjs';

const sampleTex = String.raw`\section{Experience}
\resumeSubHeadingListStart
\resumeSubheading{Acme Corp}{2025}{Data Analyst}{New York, NY}
\resumeItemListStart
\resumeItem{Built Tableau dashboards for weekly stakeholder reporting and KPI reviews.}
\resumeItem{Analyzed SQL datasets to improve retention reporting for product teams.}
\resumeItemListEnd
\resumeSubHeadingListEnd
\section{Technical Skills}
\begin{itemize}
\item{\textbf{Programming:} SQL, Python}
\end{itemize}`;

test('extractCandidateBullets finds experience bullets with context', () => {
  const bullets = extractCandidateBullets(sampleTex);
  assert.equal(bullets.length, 2);
  assert.equal(bullets[0].contextLabel, 'Data Analyst at Acme Corp');
});

test('applyTailoringPlan only applies safe edits', () => {
  const bullets = extractCandidateBullets(sampleTex);
  const result = applyTailoringPlan({
    texContent: sampleTex,
    bullets,
    config: {
      maxBulletsPerEntry: 2,
      maxExtraCharsPerBullet: 36,
      maxTotalAddedChars: 120
    },
    plan: {
      summary: 'Emphasize experimentation and SQL ownership.',
      bullet_edits: [
        {
          bullet_id: bullets[0].id,
          replacement_line:
            '\\resumeItem{Built Tableau dashboards for weekly stakeholder reporting, KPI reviews, and experimentation readouts.}',
          reason: 'Adds experimentation language.',
          keywords_added: ['experimentation']
        },
        {
          bullet_id: bullets[1].id,
          replacement_line:
            '\\resumeItem{Analyzed SQL datasets to improve retention reporting and product analytics for cross-functional teams.}',
          reason: 'Adds product analytics alignment.',
          keywords_added: ['product analytics', 'retention']
        }
      ]
    }
  });

  assert.equal(result.acceptedEdits.length, 2);
  assert.ok(result.texContent.includes('experimentation readouts'));
  assert.ok(result.addedKeywords.includes('retention'));
});

test('applyTailoringPlan rejects unsafe structural edits', () => {
  const bullets = extractCandidateBullets(sampleTex);

  assert.throws(() =>
    applyTailoringPlan({
      texContent: sampleTex,
      bullets,
      config: {
        maxBulletsPerEntry: 2,
        maxExtraCharsPerBullet: 36,
        maxTotalAddedChars: 120
      },
      plan: {
        summary: 'Bad edit',
        bullet_edits: [
          {
            bullet_id: bullets[0].id,
            replacement_line: '\\section{Hacked}',
            reason: 'Unsafe',
            keywords_added: []
          }
        ]
      }
    })
  );
});
