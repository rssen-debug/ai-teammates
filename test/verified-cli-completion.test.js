import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyIsolatedNodeCli } from '../src/core/cli-proof.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-cli-proof-'));
const filename = 'cli-agent.mjs';
const goal = 'Actually create and save cli-agent.mjs with export function respond(message) and a CLI entrypoint using process.argv to echo a DIFFERENT runtime argument.';
const valid = `export function respond(message) { return 'Response: ' + message; }
console.log(respond(process.argv[2] || ''));`;

test('CLI proof needs two distinct live outputs from a restricted no-network container', () => {
  fs.writeFileSync(path.join(workspace, filename), valid);
  const invocations = [];
  const result = verifyIsolatedNodeCli(goal, workspace, {
    nonce: 'UNIT',
    run(command, args, options) {
      invocations.push({command, args, options});
      return { status: 0, stdout: 'Response: ' + args.at(-1) };
    },
  });
  assert.equal(result?.ok, true);
  assert.equal(result.stopReason, 'verified_isolated_cli');
  assert.equal(invocations.length, 2);
  assert.notEqual(invocations[0].args.at(-1), invocations[1].args.at(-1));
  for (const {command, args, options} of invocations) {
    assert.equal(command, 'docker');
    assert.ok(args.includes('--network=none'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.ok(args.includes('--pull=never'));
    assert.ok(args.includes('--user=10001:10001'));
    assert.ok(args.includes('node:22-alpine'));
    const mount = args[args.indexOf('--mount') + 1];
    assert.ok(mount.endsWith(',target=/work/agent.mjs,readonly'));
    assert.ok(mount.includes(path.join(workspace, filename)));
    assert.ok(!args.join(' ').includes(':' + workspace + ':/work'), 'must not mount entire workspace');
    assert.equal(options.timeout, 8000);
    assert.equal(options.maxBuffer, 65536);
  }
});

test('CLI proof never turns absent Docker, errors, or unchanged output into success', () => {
  fs.writeFileSync(path.join(workspace, filename), valid);
  assert.equal(verifyIsolatedNodeCli(goal, workspace, {run() {return {status: 127, stderr:'docker missing'};}}), null);
  assert.equal(verifyIsolatedNodeCli(goal, workspace, {run() {throw new Error('not installed');}}), null);
  assert.equal(verifyIsolatedNodeCli(goal, workspace, {run() {return {status:0, stdout:'hello world'};}}), null);
  assert.equal(verifyIsolatedNodeCli(goal, workspace, {run() {return {status:0, stdout:'MAJIN_PROBE_A_UNIT'};},nonce:'UNIT'}), null);
});

test('CLI proof refuses invalid source and unrequested or ambiguous tasks without running', () => {
  fs.writeFileSync(path.join(workspace, filename), 'export function respond(message) { INVALID SYNTAX!!!');
  let calls = 0;
  const noRun = () => { calls += 1; throw new Error('not permitted'); };
  assert.equal(verifyIsolatedNodeCli(goal, workspace, {run:noRun}), null);
  fs.writeFileSync(path.join(workspace, filename), valid);
  assert.equal(verifyIsolatedNodeCli('Explain how a CLI works', workspace, {run:noRun}), null);
  assert.equal(verifyIsolatedNodeCli(goal + ' Also create other.mjs', workspace, {run:noRun}), null);
  assert.equal(calls, 0);
});

test('CLI proof rejects non-regular inputs, including symlink sources', (t) => {
  fs.writeFileSync(path.join(workspace, filename), valid);
  const alias = path.join(workspace, 'alias-agent.mjs');
  try { fs.symlinkSync(path.join(workspace, filename), alias); }
  catch { t.skip('symlink creation not supported on this runner'); return; }
  const aliasGoal = goal.replaceAll(filename, 'alias-agent.mjs');
  let calls = 0;
  assert.equal(verifyIsolatedNodeCli(aliasGoal, workspace, {run() { calls++; return {status:0}; }}), null);
  assert.equal(calls, 0);
});
