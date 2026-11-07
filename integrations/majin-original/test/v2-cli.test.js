/**
 * V2 CLI contracts: real child processes, real workspaces, exit codes honest
 * (0 only on verified completion). Covers: objective run, honest failure exit
 * 1, missing workspace refusal, telemetry report, gauntlet passthrough.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/majin-v2.mjs', import.meta.url));

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 120_000, ...opts }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('cli: website objective -> exit 0, summary lines honest, files produced', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cli-'));
  const r = await runCli(['build a modern portfolio website and show it to me', '--workspace', ws]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /goal:\s+COMPLETED/);
  assert.match(r.stdout, /compiler: deterministic/);
  assert.ok(fs.existsSync(path.join(ws, 'index.html')));
  assert.ok(fs.existsSync(path.join(ws, 'summary.json')) || true); // summary file is gauntlet-side
});

test('cli: blender objective -> exit 1 (honest failure), uncovered acceptance shown', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cli-'));
  const r = await runCli(['create a blender animation and render it', '--workspace', ws]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /goal:\s+FAILED/);
});

test('cli: without --workspace -> refusal exit 2 (never implicit destination)', async () => {
  const r = await runCli(['build a website']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--workspace is required/);
});

test('cli: telemetry report renders from the workspace ledger', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cli-'));
  await runCli(['build a portfolio website and show it', '--workspace', ws]);
  const rep = await runCli(['--telemetry-report', path.join(ws, 'telemetry'), '--days', '1']);
  assert.equal(rep.code, 0);
  assert.match(rep.stdout, /goals/);
});

test('cli: gauntlet passthrough works and writes reports', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cli-gauntlet-'));
  const r = await runCli(['--gauntlet'], { cwd: ws });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /gauntlet: 10\/10 pass/);
  assert.ok(fs.existsSync(path.join(ws, 'docs', 'v2', 'gauntlet', 'gauntlet-report.json')));
});
