import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  resolveCodexRunGuidanceConfig,
  resolveStandaloneExecutionConfig,
  resolveStandalonePreflightConfig
} from '../lib/config.mjs';

function expectedDefaultBrowser() {
  const chromeCandidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];

  return chromeCandidates.some((candidate) => candidate && fs.existsSync(candidate))
    ? 'chrome'
    : 'edge';
}

test('resolveStandaloneExecutionConfig defaults to the preferred installed browser', () => {
  const config = resolveStandaloneExecutionConfig({ standalone: {} }, {});

  assert.equal(config.executionMode, 'unattended-safe');
  assert.equal(config.browserName, expectedDefaultBrowser());
  assert.equal(config.browserProfileStrategy, 'auto');
  assert.equal(config.headless, true);
  assert.equal(config.allowManualPrompt, false);
  assert.equal(config.manualAutofillAssist, false);
  assert.equal(config.unattendedSafeHostsOnly, true);
  assert.ok(config.unattendedSafeApplyHosts.includes('greenhouse.io'));
});

test('resolveStandaloneExecutionConfig enables supervised chrome behavior', () => {
  const config = resolveStandaloneExecutionConfig(
    {
      standalone: {
        executionMode: 'supervised',
        browserName: 'chrome',
        headless: false,
        manualAutofillAssist: true
      }
    },
    {}
  );

  assert.equal(config.executionMode, 'supervised');
  assert.equal(config.browserName, 'chrome');
  assert.equal(config.headless, false);
  assert.equal(config.allowManualPrompt, true);
  assert.equal(config.manualAutofillAssist, true);
  assert.equal(config.unattendedSafeHostsOnly, false);
});

test('resolveStandaloneExecutionConfig honors explicit browser overrides', () => {
  const config = resolveStandaloneExecutionConfig(
    {
      standalone: {
        executionMode: 'supervised',
        browserName: 'edge',
        browserProfileStrategy: 'mirror'
      }
    },
    {
      browser: 'chrome',
      'browser-user-data-dir': 'C:\\Users\\lpnhu\\AppData\\Local\\Google\\Chrome\\User Data',
      'browser-profile-directory': 'Default',
      'browser-profile-strategy': 'direct'
    }
  );

  assert.equal(config.browserName, 'chrome');
  assert.equal(
    config.browserUserDataDir,
    'C:\\Users\\lpnhu\\AppData\\Local\\Google\\Chrome\\User Data'
  );
  assert.equal(config.browserProfileDirectory, 'Default');
  assert.equal(config.browserProfileStrategy, 'direct');
});

test('resolveCodexRunGuidanceConfig enables codex-guided review by default when codex is enabled', () => {
  const config = resolveCodexRunGuidanceConfig({
    codex: { enabled: true },
    standalone: {}
  });

  assert.equal(config.enabled, true);
  assert.equal(config.provider, 'codex-cli');
  assert.equal(config.maxReviewJobs, 24);
  assert.equal(config.rescueMinScore, 4);
});

test('resolveCodexRunGuidanceConfig can be forced back to deterministic mode', () => {
  const config = resolveCodexRunGuidanceConfig({
    codex: { enabled: true },
    standalone: {
      guidanceProvider: 'deterministic'
    }
  });

  assert.equal(config.enabled, false);
  assert.equal(config.provider, 'deterministic');
});

test('resolveStandalonePreflightConfig defaults to enabled repair mode', () => {
  const config = resolveStandalonePreflightConfig({ standalone: {} }, {});

  assert.equal(config.enabled, true);
  assert.equal(config.repairAuth, true);
  assert.equal(config.bootstrapSetup, true);
  assert.equal(config.searchSessions, true);
  assert.equal(config.overleafSession, true);
});

test('resolveStandalonePreflightConfig honors skip and check-only flags', () => {
  const checkOnly = resolveStandalonePreflightConfig({ standalone: {} }, { 'check-only': true });
  assert.equal(checkOnly.enabled, true);
  assert.equal(checkOnly.repairAuth, false);
  assert.equal(checkOnly.bootstrapSetup, false);

  const skipped = resolveStandalonePreflightConfig({ standalone: {} }, { 'skip-preflight': true });
  assert.equal(skipped.enabled, false);

  const forced = resolveStandalonePreflightConfig(
    { standalone: { preflightChecks: false } },
    { 'force-preflight': true }
  );
  assert.equal(forced.enabled, true);
});
