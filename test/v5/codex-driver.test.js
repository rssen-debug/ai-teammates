import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodexDriver, driverFingerprint } from '../../src/v5/codex-driver.js';
import { createDriverTools, checkedPath } from '../../src/v5/codex-tools.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-driver-test-'));
  const options = { workspace: path.join(root, 'workspace'), stateDir: path.join(root, 'state') };
  fs.mkdirSync(options.workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return options;
}
test('workspace boundary rejects traversal and symlink escape', async t => {
  const options = fixture(t);
  assert.throws(() => checkedPath(options.workspace, '../secret'), /outside/);
  fs.symlinkSync(options.stateDir, path.join(options.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(options.stateDir);
  assert.throws(() => checkedPath(options.workspace, 'escape/secret'), /outside/);
});
test('only explicit deterministic capabilities; schemas reject unknown keys and bad edits', async t => {
  const options = fixture(t); const tools = await createDriverTools(options);
  assert(!tools.has('computer_use')); assert(!tools.has('screen_capture')); assert(!tools.has('browser_open'));
  await assert.rejects(() => tools.get('fs_write').run({ path: 'x', content: 'x', provider: 'hidden' }));
  await assert.rejects(() => tools.get('fs_patch').run({ path: 'x', edits: [{}] }));
  assert.equal((await tools.get('skills_search').run({ query: '' })).result.length, 0);
});
test('real file operations, observed failure and changed strategy; replay survives restart', async t => {
  const options = fixture(t); let driver = new CodexDriver(options);
  t.after(async () => driver.close()); await driver.start();
  const call = (name, operationId, args) => driver.call(name, { ...args, operationId });
  const failed = await call('fs_read', 'missing', { path: 'report.txt' });
  assert.equal(failed.structuredContent.status, 'failed');
  assert.equal((await call('fs_write', 'write', { path: 'report.txt', content: 'one', append: true })).isError, false);
  await driver.close(); driver = new CodexDriver(options); await driver.start();
  await call('fs_write', 'write', { append: true, content: 'one', path: 'report.txt' });
  assert.equal(fs.readFileSync(path.join(options.workspace, 'report.txt'), 'utf8'), 'one');
  await assert.rejects(() => call('fs_write', 'write', { path: 'report.txt', content: 'two' }), /different arguments/);
  assert.match((await call('documents_extract', 'extract', { path: 'report.txt' })).content[0].text, /one/);
  await call('fs_patch', 'fix', { path: 'report.txt', edits: [{ find: 'one', replace: 'two' }] });
  assert.equal(fs.readFileSync(path.join(options.workspace, 'report.txt'), 'utf8'), 'two');
});
test('incomplete journal record becomes uncertain and is never replayed', async t => {
  const options = fixture(t); const driver = new CodexDriver(options);
  const operationId = 'crashed';
  const record = { operationId, fingerprint: driverFingerprint('fs_write', { path: 'x', content: 'x' }),
    status: 'running', evidence: [] };
  driver.save(record);
  await driver.close();
  const resumed = new CodexDriver(options); t.after(() => resumed.close());
  const result = await resumed.call('fs_write', { operationId, path: 'x', content: 'x' });
  assert.equal(result.structuredContent.status, 'uncertain');
  assert(!fs.existsSync(path.join(options.workspace, 'x')));
});
test('a second driver cannot alter an active journal', async t => {
  const options = fixture(t); const driver = new CodexDriver(options); t.after(() => driver.close());
  assert.throws(() => new CodexDriver(options), /Another CODEX DRIVER/);
});
test('cancellation terminates a stuck tool process and allows a fresh worker', async t => {
  const options = fixture(t); const driver = new CodexDriver(options); t.after(() => driver.close());
  await driver.start(); const pid = driver.worker.pid;
  fs.writeFileSync(path.join(options.workspace, 'slow.txt'), 'a'.repeat(80) + '!');
  const pending = driver.call('fs_grep', { operationId: 'slow', path: 'slow.txt', pattern: '(a+)+$' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(() => driver.call('fs_read', { operationId: 'overlap', path: 'slow.txt' }), /running/);
  await driver.cancel('slow');
  assert.equal((await pending).structuredContent.errorCode, 'CANCELLED');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0));
  const result = await driver.call('driver_status', { operationId: 'fresh' });
  assert.equal(result.structuredContent.status, 'completed');
});
test('process lane resolves Node and cancellation prevents a delayed child write', { skip: process.platform !== 'win32' }, async t => {
  const options = { ...fixture(t), processAccess: true };
  const driver = new CodexDriver(options); t.after(() => driver.close()); await driver.start();
  const version = await driver.call('shell_run', { operationId: 'version', command: 'node --version' });
  assert.equal(version.isError, false, version.content[0].text);
  fs.writeFileSync(path.join(options.workspace, 'delayed.mjs'), "import fs from 'node:fs'; fs.writeFileSync('started.txt','started'); setTimeout(()=>fs.writeFileSync('late.txt','unexpected'),3000);");
  const pending = driver.call('shell_run', { operationId: 'delay', command: 'node delayed.mjs' });
  const startedPath = path.join(options.workspace, 'started.txt');
  const startDeadline = Date.now() + 10000;
  while (!fs.existsSync(startedPath) && Date.now() < startDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert(fs.existsSync(startedPath), 'the delayed child must actually start before cancellation is exercised');
  await driver.cancel('delay'); await pending;
  await new Promise(resolve => setTimeout(resolve, 3300));
  assert(!fs.existsSync(path.join(options.workspace, 'late.txt')));
});
test('unexpected worker death remains uncertain and a fresh operation can recover', async t => {
  const options = fixture(t); const driver = new CodexDriver(options); t.after(() => driver.close());
  await driver.start();
  fs.writeFileSync(path.join(options.workspace, 'slow.txt'), 'a'.repeat(80) + '!');
  const pending = driver.call('fs_grep', { operationId: 'crash', path: 'slow.txt', pattern: '(a+)+$' });
  await new Promise(resolve => setTimeout(resolve, 100)); driver.worker.kill('SIGKILL');
  const result = await pending;
  assert.equal(result.structuredContent.status, 'uncertain');
  assert.equal(result.structuredContent.errorCode, 'WORKER_EXIT');
  assert.equal((await driver.call('driver_status', { operationId: 'recover' })).isError, false);
});
