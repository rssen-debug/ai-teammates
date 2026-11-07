import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  repairLiteralEscapedNewlineEchoCliWrite,
  inspectRequestedArtifact,
} from '../src/core/goal-artifact.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-escaped-cli-'));
const filename = 'my-agent-qa.mjs';
const goal = 'Actually create and save a working Node.js CLI agent module in ' + filename +
  '. Export function respond(message). A CLI entrypoint must read process.argv ' +
  'and reflect different runtime arguments. No external dependencies.';
const tick = String.fromCharCode(96);
const broken = 'export function respond(message) { return ' +
  tick + 'Received: $' + '{message}' + tick +
  '; }' + '\\n' +
  'console.log(respond(process.argv[2] || ""));';

test('the exact escaped-newline CLI observed on real QA is safely corrected and executable', () => {
  const fixed = repairLiteralEscapedNewlineEchoCliWrite(goal, workspace, 'fs.write', { path: filename, content: broken });
  assert.equal(fixed?.corrected, true);
  assert.equal(fixed.args.path, filename);
  assert.ok(fixed.args.content.includes('}\nconsole.log('), 'line break is real');
  assert.ok(!fixed.args.content.includes('}\\nconsole.log('), 'escaped line break was removed');
  const abs = path.join(workspace, filename);
  fs.writeFileSync(abs, fixed.args.content);
  const syntax = spawnSync(process.execPath, ['--check', abs], {encoding:'utf8'});
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.equal(inspectRequestedArtifact(goal, workspace)?.ok, true);
  for (const arg of ['QA_PING_UNSEEN', 'QA_OTHER_FRESH']) {
    const run = spawnSync(process.execPath, [abs, arg], {encoding:'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'Received: ' + arg);
  }
});

test('never corrupts arbitrary escapes, different functions or arbitrary user code', () => {
  const variants = [
    broken.replace('Received:', 'Hello:'),
    broken.replace('return ', 'return await '),
    broken.replace('}\\nconsole.log', '}\\nalert'),
    broken.replace('}\\nconsole.log', '}\nconsole.log'),
    broken.replace('process.argv[2]', 'process.argv[3]'),
    broken + '\nconsole.log("extra action")',
    broken.replace('Received: $' + '{message}', 'Received: \\n$' + '{message}'),
  ];
  for (const content of variants) {
    assert.equal(repairLiteralEscapedNewlineEchoCliWrite(goal, workspace, 'fs.write', {path:filename,content}), null);
  }
});

test('repair requires exact CLI goal, targeted file and approved write tool', () => {
  assert.equal(repairLiteralEscapedNewlineEchoCliWrite('Tell me about JavaScript', workspace, 'fs.write', {path:filename,content:broken}), null);
  assert.equal(repairLiteralEscapedNewlineEchoCliWrite(goal, workspace, 'fs.read', {path:filename,content:broken}), null);
  assert.equal(repairLiteralEscapedNewlineEchoCliWrite(goal, workspace, 'fs.write', {path:'other.mjs',content:broken}), null);
  assert.equal(repairLiteralEscapedNewlineEchoCliWrite(goal.replace('No external dependencies.',''), workspace, 'fs.write', {path:filename,content:broken}), null);
});
