/**
 * V2 tool contracts: registry shape, full runner pipeline (validate -> policy
 * -> consent -> execute -> validate -> receipt + telemetry), and §4.2/112
 * fuzzing: malformed inputs rejected, schema-breaking outputs classified,
 * escape paths refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ToolRegistry, ToolError } from '../src/v2/tools/registry.js';
import { runTool } from '../src/v2/tools/runner.js';
import { builtinTools } from '../src/v2/tools/builtins.js';
import { Approvals } from '../src/v2/safety/approvals.js';
import { EventBus } from '../src/v2/runtime/events.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';

function setup(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-'));
  const reg = new ToolRegistry();
  for (const t of builtinTools(root)) reg.define(t);
  const events = new EventBus();
  const tele = new TelemetryLedger(fs.mkdtempSync(path.join(dir, 'tele')));
  const approvals = new Approvals(events);
  return { reg, approvals: approvals, events, tele, ctx: { approvals, telemetry: tele, events } };
}

test('registry: malformed tool definitions are refused', () => {
  const reg = new ToolRegistry();
  assert.throws(() => reg.define({ name: 'Bad Name!' }));
  reg.define({ name: 't1', tier: 'read', description: 'x tool', inputSchema: z.object({}), outputSchema: z.object({}), execute: async () => ({}) });
  assert.equal(reg.list().length, 1);
});

test('runner: read_file executes, output schema-locked, receipts written', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-ws-'));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'world');
  const { reg, ctx, tele } = setup(root);
  const r = await runTool({ tool: 'read_file', input: { path: 'hello.txt' } }, { registry: reg, ...ctx });
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 5);
  assert.equal(r.data.content, 'world');
  assert.ok(fs.readdirSync(path.dirname(tele.todayFile())).length >= 1);
});

test('runner: unknown tool + invalid input + schema-breaking output all classified', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-ws-'));
  const { reg, ctx } = setup(root);
  await assert.rejects(() => runTool({ tool: 'no_such_tool', input: {} }, { registry: reg, ...ctx }), (e) => e instanceof ToolError);
  await assert.rejects(() => runTool({ tool: 'write_file', input: { path: 42 } }, { registry: reg, ...ctx }), (e) => e.cls === 'INVALID_TOOL_INPUT:MAJIN');
  reg.define({
    name: 'liar_tool', tier: 'read', description: 'claims structured data, produces junk',
    inputSchema: z.object({}), outputSchema: z.object({ verifiable: z.boolean() }),
    execute: async () => ({ verifiable: 'yes definitely' }),
  });
  await assert.rejects(() => runTool({ tool: 'liar_tool', input: {} }, { registry: reg, ...ctx }), (e) => e.cls === 'INVALID_TOOL_OUTPUT');
});

test('runner: write-file consent flow (hold -> waiting -> consent -> executes)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-ws-'));
  const { reg, approvals, ctx } = setup(root);
  const call = { tool: 'write_file', input: { path: 'out.txt', content: 'hello v2 tools' } };
  const wait = await runTool(call, { registry: reg, ...ctx });
  assert.equal(wait.decision, 'waiting');
  assert.ok(!fs.existsSync(path.join(root, 'out.txt')));
  approvals.grant(wait.pendingScope, { user: 'owner' });
  const done = await runTool(call, { registry: reg, ...ctx });
  assert.equal(done.decision, 'done');
  assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), 'hello v2 tools');
  // one-time consent: exhausted now
  const again = await runTool(call, { registry: reg, ...ctx });
  assert.equal(again.decision, 'waiting');
});

test('runner: path escape refused on both read and write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-ws-'));
  const { reg, approvals, ctx } = setup(root);
  approvals.grant('tool:write_file', { user: 'owner', mode: 'session', maxUses: 5 });
  await assert.rejects(() => runTool({ tool: 'write_file', input: { path: '../escape.txt', content: 'x' } }, { registry: reg, ...ctx }), /escapes root/);
  await assert.rejects(() => runTool({ tool: 'read_file', input: { path: '../../etc/passwd' } }, { registry: reg, ...ctx }), /escapes root/);
});

test('runner: timeout loaned line (§112 tool-limits) respected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-ws-'));
  const { reg, ctx } = setup(root);
  reg.define({
    name: 'slow', tier: 'read', description: 'stalls', inputSchema: z.object({}), outputSchema: z.object({}),
    execute: () => new Promise(() => {}),
  });
  const t0 = Date.now();
  await assert.rejects(() => runTool({ tool: 'slow', input: {} }, { registry: reg, ...ctx, timeoutMs: 300 }), (e) => e.cls === 'TIMEOUT');
  assert.ok(Date.now() - t0 < 2000);
});

test('runner: verify_now bridges the verifier registry through policy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-tools-ws-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'present');
  const { reg, ctx } = setup(root);
  const ok = await runTool({ tool: 'verify_now', input: { kind: 'file', spec: { path: path.join(root, 'a.txt'), contains: 'present' } } }, { registry: reg, ...ctx });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.verified, true);
  const no = await runTool({ tool: 'verify_now', input: { kind: 'file', spec: { path: path.join(root, 'missing.txt') } } }, { registry: reg, ...ctx });
  assert.equal(no.data.verified, false);
});
