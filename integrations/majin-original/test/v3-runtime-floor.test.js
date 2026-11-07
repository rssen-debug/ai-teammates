import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertV3NodeSupported, isV3NodeSupported, V3_MIN_NODE_VERSION } from '../src/v3/platform/runtime.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('runtime helper accepts Node 22+ and refuses Node 20/21', () => {
  assert.equal(V3_MIN_NODE_VERSION, '22.0.0');
  assert.equal(isV3NodeSupported('20.20.2'), false);
  assert.equal(isV3NodeSupported('21.7.3'), false);
  assert.equal(isV3NodeSupported('22.0.0'), true);
  assert.equal(isV3NodeSupported('v22.23.4'), true);
  assert.equal(isV3NodeSupported('24.1.0'), true);
  assert.equal(isV3NodeSupported('not-a-version'), false);
  assert.throws(() => assertV3NodeSupported('20.20.2'), /requires Node\.js >=22\.0\.0/);
  assert.doesNotThrow(() => assertV3NodeSupported());
});

test('package and lockfile engine floors match the engines of required dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.engines.node, '>=22.0.0');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.equal(lock.packages['node_modules/canonicalize'].engines.node, '>=22');
  assert.equal(lock.packages['node_modules/p-queue'].engines.node, '>=22');
});

test('entry points, installers, doctor, documentation and V3 CI all enforce Node 22+', () => {
  assert.match(read('install.ps1'), /\$okNode = \[int\]\$parts\[0\] -ge 22/);
  assert.match(read('scripts/install-windows.ps1'), /\[int\]\$parts\[0\] -lt 22/);
  assert.match(read('scripts/build-on-windows.ps1'), /\[int\]\$parts\[0\] -lt 22/);
  assert.match(read('setup/setup.ps1'), /\$ver\.Major -ge 22/);
  assert.match(read('start-majin.cmd'), /if %MAJOR% LSS 22 goto :toogame/);
  assert.match(read('scripts/windows/live-acceptance-run.ps1'), /\[int\]\$nv\[0\] -ge 22/);
  assert.match(read('src/v2/ops/doctor.js'), /major >= 22[\s\S]+requires >= 22/);
  assert.match(read('README.md'), /Node 22\+/);
  assert.match(read('docs/WINDOWS.md'), /Node.*22\.0\.0\+/);

  const workflow = read('.github/workflows/v3-fast-ci.yml');
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /contents: read/);
});
