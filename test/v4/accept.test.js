/**
 * The acceptance runner must be incapable of flattering the release.
 *
 * These tests assert the two properties that matter:
 *   1. on a healthy host it reports the checks as passing (and still refuses to
 *      call the release verified when the model lane is unconfigured);
 *   2. its exit code follows the failures, so CI (and a human) cannot miss them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tempHome } from './helpers.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/v4/accept.mjs');

function runAccept(env = {}) {
  const home = tempHome();
  const out = spawnSync(process.execPath, [SCRIPT, '--json'], {
    cwd: path.dirname(SCRIPT),
    timeout: 120_000,
    env: { ...process.env, MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo', ...env },
    encoding: 'utf8',
  });
  fs.rmSync(home, { recursive: true, force: true });
  return out;
}

test('accept: reports every real check with machine-readable evidence', () => {
  const out = runAccept();
  const report = JSON.parse(out.stdout);
  assert.ok(Array.isArray(report.results) && report.results.length >= 12, 'all checks ran');
  for (const r of report.results) {
    assert.equal(typeof r.id, 'string');
    assert.equal(typeof r.ok, 'boolean');
    assert.equal(typeof r.detail, 'string');
  }
  const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));

  // the checks that must hold on any host
  for (const id of [
    'host.health',
    'auth.refuses_anonymous',
    'auth.pairing_works',
    'auth.cookie_hardened',
    'auth.csrf_required',
    'auth.cross_origin_refused',
    'chat.streams',
    'goal.tool_verified',
    'chat.completes',
    'goal.file_on_disk',
    'persist.conversation_reloads',
    'restart.goal_survives',
    'restart.file_survives',
  ]) {
    assert.equal(byId[id]?.ok, true, `${id}: ${byId[id]?.detail}`);
  }
});

test('accept: a configured-provider claim is refused without a provider', () => {
  const out = runAccept();
  const report = JSON.parse(out.stdout);
  const model = report.results.find((r) => r.id === 'model.configured');
  assert.equal(model.ok, false, 'the demo brain is not a configured model');
  assert.match(model.detail, /demo/i);
  assert.ok(model.hint, 'it tells you what to do about it');
});

test('accept: the exit code follows the failures', () => {
  const out = runAccept();
  assert.equal(out.status, 1, 'one failed check must fail the run');
  const report = JSON.parse(out.stdout);
  assert.ok(report.failed >= 1);
  assert.equal(report.passed + report.failed, report.results.length);
});

test('accept: a public URL that is not https is rejected without inventing a pass', () => {
  const out = runAccept({});
  const withUrl = spawnSync(process.execPath, [SCRIPT, '--json', '--url', 'http://insecure.example'], {
    cwd: path.dirname(SCRIPT),
    timeout: 120_000,
    env: { ...process.env, MAJIN_HOME: tempHome(), MAJIN_V4_PROVIDER: 'demo' },
    encoding: 'utf8',
  });
  assert.ok(withUrl.stdout.length > 0);
  const report = JSON.parse(withUrl.stdout);
  const https = report.results.find((r) => r.id === 'tunnel.https');
  assert.equal(https.ok, false, 'http is not https');
  void out;
});
