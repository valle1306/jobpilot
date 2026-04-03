import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLoginPage, detectRegistrationPage } from '../lib/browser.mjs';

function createMockPage({ url, bodyText = '', passwordCount = 0, emailCount = 0 }) {
  return {
    url: () => url,
    locator: (selector) => {
      if (selector === 'body') {
        return {
          innerText: async () => bodyText
        };
      }

      if (selector.includes('input[type="password"]')) {
        return {
          count: async () => passwordCount
        };
      }

      if (selector.includes('input[type="email"]')) {
        return {
          count: async () => emailCount
        };
      }

      return {
        count: async () => 0,
        innerText: async () => ''
      };
    }
  };
}

test('detectRegistrationPage identifies account registration pages', async () => {
  const page = createMockPage({
    url: 'https://recruiting2.ultipro.com/company/Account/Register?redirectUrl=/apply',
    bodyText: 'Register Create an account to apply or save for later Confirm Password',
    passwordCount: 2,
    emailCount: 1
  });

  assert.equal(await detectRegistrationPage(page), true);
  assert.equal(await detectLoginPage(page), false);
});

test('detectLoginPage still identifies ordinary sign-in pages', async () => {
  const page = createMockPage({
    url: 'https://example.com/login',
    bodyText: 'Sign in to your account Forgot password',
    passwordCount: 1,
    emailCount: 1
  });

  assert.equal(await detectRegistrationPage(page), false);
  assert.equal(await detectLoginPage(page), true);
});
