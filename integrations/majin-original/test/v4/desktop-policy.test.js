import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { V4_VERSION } from '../../src/v4/config.js';
const { hostOrigin, sameOrigin, restoreBounds } = createRequire(import.meta.url)('../../desktop/policy.cjs');

test('desktop: native package and shared server advertise the same release', () => {
  const desktopPackage = JSON.parse(fs.readFileSync(new URL('../../desktop/package.json', import.meta.url), 'utf8'));
  assert.equal(desktopPackage.version, V4_VERSION);
  assert.ok(desktopPackage.build.extraResources.some((entry) => entry.from === 'stage/host/node_modules'
    && entry.to === 'host/node_modules'), 'the independent Node host needs its own runtime dependencies');
});

test('desktop: only loopback HTTP or HTTPS origins, without embedded credentials', () => {
  assert.equal(hostOrigin(), 'http://127.0.0.1:7373');
  assert.equal(hostOrigin('https://desktop.example.ts.net/'), 'https://desktop.example.ts.net');
  for (const url of ['http://remote.test', 'file:///C:/x', 'https://a:b@host/', 'http://127.0.0.1:7373/?token=x']) {
    assert.throws(() => hostOrigin(url));
  }
  assert.equal(sameOrigin('http://127.0.0.1:7373/api/state', hostOrigin()), true);
  assert.equal(sameOrigin('http://127.0.0.1:7374/', hostOrigin()), false);
  assert.equal(sameOrigin('http://127.0.0.1.evil.test:7373/', hostOrigin()), false);
});

test('desktop: monitor removal cannot strand the restored window off screen', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(restoreBounds({ x: 2400, y: 20, width: 800, height: 600 }, displays), { width: 520, height: 860 });
  assert.deepEqual(restoreBounds({ x: 30, y: 20, width: 800, height: 600 }, displays), { x: 30, y: 20, width: 800, height: 600 });
});
