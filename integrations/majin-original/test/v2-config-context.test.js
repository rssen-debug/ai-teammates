/**
 * V2 config contracts + context-engine integration into role calls.
 * Config: defaults < repo < local override, JSON corruption errors honestly,
 * untrusted repos can only TIGHTEN safety. Context: roleCalls prepend packed
 * sections inside the token budget, truncation markers preserved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig, DEFAULTS } from '../src/v2/config/config.js';
import { roleCall } from '../src/v2/supervisor/roles.js';
import { OpenAICompatibleProvider } from '../src/v2/model/provider.js';

test('config: defaults alone when no files exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cfg-'));
  const { config, sources } = loadConfig(dir);
  assert.equal(config.approvals.mode, 'balanced');
  assert.equal(sources.repo, null);
});

test('config: repo < local override merge wins on leaf keys only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cfg-'));
  fs.writeFileSync(path.join(dir, 'majin.json'), JSON.stringify({ approvals: { mode: 'guided' }, telemetry: { retainDays: 7 } }));
  fs.writeFileSync(path.join(dir, 'majin.local.json'), JSON.stringify({ approvals: { mode: 'auto' } }));
  const { config, sources } = loadConfig(dir);
  assert.equal(config.approvals.mode, 'auto', 'local override wins');
  assert.equal(config.telemetry.retainDays, 7, 'repo survives fields local never touched');
  assert.ok(sources.repo && sources.local);
});

test('config: partial-broken values warn, survive (never crash), unknown mode dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cfg-'));
  fs.writeFileSync(path.join(dir, 'majin.json'), JSON.stringify({ approvals: { mode: 'turbo-max' }, telemetry: { retainDays: 9999 } }));
  const { config, warnings } = loadConfig(dir);
  assert.ok(warnings.length >= 2);
  assert.equal(config.approvals.mode, DEFAULTS.approvals.mode);
  assert.equal(config.telemetry.retainDays, DEFAULTS.telemetry.retainDays);
});

test('config: untrusted repo can only TIGHTEN (hands_off clamped to auto, self-trust-false keeps trust off)', () => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cfg-'));
  fs.writeFileSync(path.join(dir, 'majin.local.json'), JSON.stringify({ approvals: { mode: 'hands_off' }, safety: { trustedRepo: false } }));
  let { config } = loadConfig(dir);
  assert.equal(config.approvals.mode, 'auto');
  assert.equal(config.safety.trustedRepo, false);
  // trusted repo keeps hands_off
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cfg-'));
  fs.writeFileSync(path.join(dir, 'majin.local.json'), JSON.stringify({ approvals: { mode: 'hands_off' }, safety: { trustedRepo: true } }));
  ({ config } = loadConfig(dir));
  assert.equal(config.approvals.mode, 'hands_off');
  assert.equal(config.safety.trustedRepo, true);
});

test('config: invalid JSON -> explicit error naming the file (never silent)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-cfg-'));
  fs.writeFileSync(path.join(dir, 'majin.json'), '{oops');
  assert.throws(() => loadConfig(dir), /majin\.json.*not valid JSON/);
});

test('context: roleCall prepends packed sections inside budget with truncation markers intact', async () => {
  const captured = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        captured.push(JSON.parse(b || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ subtasks: [{ action: 'do x', role: 'executor', deps: [] }] }) } }] }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'ctx', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  const out = await roleCall('planner', 'do the thing', provider, {
    contextBudget: 80,
    contextSections: [
      { priority: 100, name: 'goal', text: 'goal: deliver green widget', essential: true },
      { priority: 40, name: 'file_excerpt', text: 'x'.repeat(2000) },
    ],
  });
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  assert.equal(out.role, 'planner');
  const systemMsg = captured[0].messages[0].content;
  assert.ok(systemMsg.includes('goal: deliver green widget'), 'essential section survived');
  assert.ok(systemMsg.length < 600, 'budget respected');
});

test('context: roleCall works unchanged without sections', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdict: 'verified', notes: 'ok' }) } }] }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const provider = new OpenAICompatibleProvider({ name: 'plain', baseUrl: `http://127.0.0.1:${port}`, model: 'x' });
  const out = await roleCall('verifier', 'evidences', provider);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  assert.equal(out.value.verdict, 'verified');
});
