import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexApplyConfig } from '../lib/config.mjs';
import { shouldUseCodexApplyAssist } from '../lib/codex-apply.mjs';

test('resolveCodexApplyConfig enables hard-host assistance by default when codex is enabled', () => {
  const config = resolveCodexApplyConfig({
    codex: { enabled: true },
    standalone: {}
  });

  assert.equal(config.enabled, true);
  assert.equal(config.maxRounds, 2);
  assert.equal(config.maxActionsPerRound, 6);
  assert.ok(config.hostPatterns.includes('myworkdayjobs.com'));
  assert.ok(config.hostPatterns.includes('icims.com'));
});

test('shouldUseCodexApplyAssist matches configured hard ATS hosts only', () => {
  const profile = {
    codex: { enabled: true },
    standalone: {
      codexAssistedApply: true,
      codexAssistedApplyHosts: ['myworkdayjobs.com', 'lever.co']
    }
  };

  assert.equal(
    shouldUseCodexApplyAssist(
      'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123',
      profile
    ),
    true
  );
  assert.equal(
    shouldUseCodexApplyAssist('https://jobs.lever.co/acme/123', profile),
    true
  );
  assert.equal(
    shouldUseCodexApplyAssist('https://boards.greenhouse.io/acme/jobs/123', profile),
    false
  );
});

test('shouldUseCodexApplyAssist can be disabled explicitly', () => {
  const profile = {
    codex: { enabled: true },
    standalone: {
      codexAssistedApply: false
    }
  };

  assert.equal(
    shouldUseCodexApplyAssist(
      'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123',
      profile
    ),
    false
  );
});
