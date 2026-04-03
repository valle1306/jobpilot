import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStandaloneExecutionConfig } from '../lib/config.mjs';

test('resolveStandaloneExecutionConfig defaults to unattended-safe edge mode', () => {
  const config = resolveStandaloneExecutionConfig({ standalone: {} }, {});

  assert.equal(config.executionMode, 'unattended-safe');
  assert.equal(config.browserName, 'edge');
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
        browserName: 'edge'
      }
    },
    {
      browser: 'chrome',
      'browser-user-data-dir': 'C:\\Users\\lpnhu\\AppData\\Local\\Google\\Chrome\\User Data',
      'browser-profile-directory': 'Default'
    }
  );

  assert.equal(config.browserName, 'chrome');
  assert.equal(
    config.browserUserDataDir,
    'C:\\Users\\lpnhu\\AppData\\Local\\Google\\Chrome\\User Data'
  );
  assert.equal(config.browserProfileDirectory, 'Default');
});
