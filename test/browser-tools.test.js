import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTools, validateUrl } from '../src/core/tools/browser.js';
import { ALL_TOOLS } from '../src/core/tools/index.js';

test('Playwright browser tools do not override the integrated browser registry', () => {
  const names = browserTools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'browser.open', 'browser.inspect', 'browser.verify', 'browser.shot', 'browser.click', 'browser.fill',
    'browser.check', 'browser.select', 'browser.upload', 'browser.press', 'browser.download', 'browser.tabs', 'browser.clear_marks', 'browser.close',
  ]);
  assert.equal(browserTools.some((tool) => ALL_TOOLS.includes(tool)), false,
    'the integrated CDP browser surface owns the registered browser session');
  const registeredBrowserTools = ALL_TOOLS.filter((tool) => tool.name.startsWith('browser.'));
  assert.equal(new Set(registeredBrowserTools.map((tool) => tool.name)).size, registeredBrowserTools.length,
    'each browser capability has one implementation');
  assert.ok(registeredBrowserTools.some((tool) => tool.name === 'browser.open'));
  assert.match(browserTools[0].desc, /Playwright Core/);
  assert.match(browserTools[0].desc, /never submit/i);
  assert.match(browserTools.find((tool) => tool.name === 'browser.click').desc, /submit buttons are refused/i);
});

test('browser URL validation accepts only absolute http(s) URLs', () => {
  assert.equal(validateUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(validateUrl('http://localhost:3000'), 'http://localhost:3000/');
  for (const url of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
    assert.throws(() => validateUrl(url), /http\(s\)|valid http/);
  }
});

test('browser form tools never expose a submit operation', () => {
  assert.equal(browserTools.some((tool) => /submit|apply/i.test(tool.name)), false);
  assert.match(browserTools.find((tool) => tool.name === 'browser.upload').desc, /not uploaded until the user submits/i);
});

test('frame-scoped browser tools declare the frame parameter they implement', () => {
  // Regression guard: these runs destructure and use `frame`; a missing param
  // declaration means the driver schema strips it (additionalProperties:false)
  // and frame-scoped calls can never reach the implementation.
  for (const name of ['browser.inspect', 'browser.verify', 'browser.click', 'browser.fill', 'browser.check', 'browser.select', 'browser.download', 'browser.clear_marks']) {
    const tool = browserTools.find((entry) => entry.name === name);
    assert.ok(Object.hasOwn(tool.parameters.properties, 'frame'), `${name} must declare a frame param`);
  }
});
