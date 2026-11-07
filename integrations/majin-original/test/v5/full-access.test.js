import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OwnerMode, normaliseFolder, normaliseBrowserOrigin, GRANTABLE_LANES } from '../../src/v4/owner-mode.js';
import { createDriverTools } from '../../src/v5/codex-tools.js';
import { browserWriteAllowed } from '../../src/core/tools/browser.js';
import { ProviderManager } from '../../src/v5/providers.js';
const bin = fileURLToPath(new URL('../../bin/majin-v5.mjs', import.meta.url));

test('explicit local full grant persists all lanes and roots; browser writes and outside-workspace file access can be revoked', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-full-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const result = spawnSync(process.execPath, [bin, 'grants', 'full', '--data-dir', data, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const access = JSON.parse(result.stdout);
  assert.equal(access.grantedLanes.length, GRANTABLE_LANES.length);
  assert.ok(access.grantedFolders.includes(path.parse(root).root));
  assert.deepEqual(access.browserWriteOrigins, ['*']);
  const mode = new OwnerMode({ file: path.join(data, 'owner-mode.json') });
  assert.deepEqual(mode.browserOrigins(), ['*']);
  assert.ok(browserWriteAllowed({ browserWriteOrigins: () => mode.browserOrigins() }, 'https://new-employer.example/apply'));
  assert.equal(browserWriteAllowed({ browserWriteOrigins: ['*'] }, 'file:///etc/passwd'), false);
  assert.equal(browserWriteAllowed({ browserWriteOrigins: ['*'] }, 'https://user:pass@example.com'), false);
  const outside = path.join(root, 'cv.txt'); fs.writeFileSync(outside, 'fixture CV');
  const tools = await createDriverTools({ workspace: path.join(data, 'workspace'), allowedFolders: mode.folders(), grantedLanes: mode.activeLanes(), browserWriteOriginsFile: mode.file });
  assert.match(JSON.stringify(await tools.get('fs_read').run({ path: outside })), /fixture CV/);
  mode.revoke();
  assert.equal(mode.activeLanes().length, 0);
  assert.equal(browserWriteAllowed({ browserWriteOrigins: () => mode.browserOrigins() }, 'https://new-employer.example/apply'), false);
  const status = (await tools.get('driver_status').run({})).result;
  assert.deepEqual(status.browserWriteOrigins, []);
  assert.throws(() => normaliseFolder(path.parse(root).root));
  assert.throws(() => normaliseBrowserOrigin('*'));
});

test('explicit model tools=false returns a concrete error instead of silently stripping the catalog', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-capability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const pm = new ProviderManager({ dataDir: dir, completeImpl: async request => {
    calls++; assert.equal(request.tools.length, 1);
    return { text: 'observed', toolCalls: [], usage: {} };
  } });
  await pm.configureProvider({ providerId: 'opencode-go', apiKey: 'fixture-key', discover: false });
  pm.selectModel({ providerId: 'opencode-go', modelId: 'fixture', allowManualFallback: true, capabilities: { tools: false } });
  const request = { messages: [{ role: 'user', content: 'Read the file' }], tools: [{ name: 'fs_read', description: 'Read', parameters: { type: 'object', properties: {} } }] };
  const blocked = await pm.complete(request);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'MODEL_TOOLS_UNAVAILABLE');
  assert.equal(calls, 0);
  pm.state.providers['opencode-go'].modelCapabilities.fixture = {};
  assert.equal((await pm.complete(request)).ok, true);
  assert.equal(calls, 1);
});
