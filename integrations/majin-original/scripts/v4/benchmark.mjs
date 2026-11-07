#!/usr/bin/env node
/**
 * MAJIN V4 — benchmark harness.
 *
 * Runs a fixed scenario set against a throwaway host and records what actually
 * happened: pass/fail, latency percentiles, tool calls, receipt coverage and
 * the state each goal ended in. Results land in docs/v4/benchmarks/<date>.json
 * so two releases can be compared without trusting anyone's memory.
 *
 *   node scripts/v4/benchmark.mjs                 run and print
 *   node scripts/v4/benchmark.mjs --write         also write the JSON report
 *   node scripts/v4/benchmark.mjs --compare x.json  diff against an earlier run
 *
 * Deterministic by design: the demo route is used unless a model is configured,
 * and every scenario is local. Latency here is host overhead, not model latency
 * — the report says so instead of implying otherwise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/v4/config.js';
import { startV4Server } from '../../src/v4/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(here, '../../docs/v4/benchmarks');

const SCENARIOS = [
  { id: 'chat-plain', text: 'Vad kan du göra just nu?', expect: ['completed'] },
  { id: 'file-write', text: 'Skriv filen bench1.txt med innehåll: alfa', expect: ['completed'], check: 'file:bench1.txt' },
  { id: 'file-write-utf8', text: 'Skriv filen bench2.txt med innehåll: åäö 日本語 🎯', expect: ['completed'], check: 'file:bench2.txt' },
  { id: 'list-workspace', text: 'Lista filerna i arbetsytan', expect: ['completed'] },
  { id: 'bad-filename', text: 'Skriv filen ../escape.txt med innehåll: nej', expect: ['failed'], check: 'no-escape' },
  { id: 'duplicate-request', text: 'Skriv filen bench3.txt med innehåll: dubbel', expect: ['completed'], repeat: true },
  { id: 'long-message', text: `Skriv filen bench4.txt med innehåll: ${'x'.repeat(1500)}`, expect: ['completed'], check: 'file:bench4.txt' },
];

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

async function readSse(response) {
  const text = await response.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    let type = null;
    let data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (type) events.push({ type, data: data ? JSON.parse(data) : null });
  }
  return events;
}

async function runScenario(base, cookie, scenario) {
  const started = process.hrtime.bigint();
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: base, cookie },
    body: JSON.stringify({ text: scenario.text, requestId: `bench-${scenario.id}` }),
  });
  const events = await readSse(res);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

  const done = events.filter((e) => e.type === 'done').pop();
  const status = done?.data?.status || 'no-done-event';
  const goal = events.filter((e) => e.type === 'goal').pop()?.data || null;
  const toolResults = events.filter((e) => e.type === 'tool_result').map((e) => e.data);

  let repeatStatus = null;
  if (scenario.repeat) {
    const again = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1', origin: base, cookie },
      body: JSON.stringify({ text: scenario.text, requestId: `bench-${scenario.id}` }),
    });
    repeatStatus = (await readSse(again)).filter((e) => e.type === 'done').pop()?.data?.status || null;
  }

  return {
    id: scenario.id,
    status,
    repeatStatus,
    ms: Math.round(elapsed * 100) / 100,
    tools: toolResults.length,
    verifiedTools: toolResults.filter((t) => t.verified).length,
    goalState: goal?.state || null,
    receipts: goal?.receipts?.length || 0,
    verifiedReceipts: goal?.receipts?.filter((r) => r.verified).length || 0,
    ok: scenario.expect.includes(status) && (!scenario.repeat || repeatStatus === 'replayed'),
  };
}

function verifyScenario(home, scenario, result) {
  if (!scenario.check) return true;
  if (scenario.check === 'no-escape') {
    const escaped = [path.join(home, 'escape.txt'), path.resolve(home, '..', 'escape.txt')];
    return !escaped.some((p) => fs.existsSync(p));
  }
  if (scenario.check.startsWith('file:')) {
    const name = scenario.check.slice(5);
    const file = path.join(home, 'workspace', name);
    if (!fs.existsSync(file)) return false;
    const expected = scenario.text.split('innehåll:')[1]?.trim() || '';
    const actual = fs.readFileSync(file, 'utf8');
    return expected ? actual === expected : actual.length > 0;
  }
  return Boolean(result);
}

export async function runBenchmark({ home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-bench-')), keep = false } = {}) {
  const config = loadConfig({
    env: { MAJIN_HOME: home, MAJIN_V4_PROVIDER: 'demo', MAJIN_V4_RATE_REQUESTS: '10000', MAJIN_V4_RATE_TURNS: '10000' },
    argv: [],
    platform: 'linux',
  });
  // Explicit ports: Node pools HTTP connections per origin, so reusing an
  // ephemeral port from an earlier (closed) run can hand out a dead socket.
  let server;
  let context;
  for (let attempt = 0; ; attempt += 1) {
    const port = 33000 + Math.floor(Math.random() * 2000) + attempt;
    try {
      ({ server, context } = await startV4Server({ config: { ...config, port, host: '127.0.0.1' } }));
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt > 25) throw err;
    }
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (() => {
    const { token } = context.sessions.create({ ip: 'bench' });
    return `${config.auth.cookieName}=${encodeURIComponent(token)}`;
  })();

  const results = [];
  try {
    for (const scenario of SCENARIOS) {
      const result = await runScenario(base, cookie, scenario);
      result.artifactOk = verifyScenario(home, scenario, result);
      result.pass = result.ok && result.artifactOk;
      results.push(result);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (!keep) fs.rmSync(home, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.pass).length;
  const latencies = results.map((r) => r.ms);
  return {
    schema: 'majin.v4.benchmark/v1',
    at: new Date().toISOString(),
    node: process.versions.node,
    platform: process.platform,
    mode: context.model.info.demo ? 'demo' : 'configured-model',
    model: context.model.info.model,
    scenarios: results.length,
    passed,
    failed: results.length - passed,
    passRate: Math.round((passed / results.length) * 1000) / 10,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: Math.max(...latencies),
    },
    toolCalls: results.reduce((n, r) => n + r.tools, 0),
    verifiedToolCalls: results.reduce((n, r) => n + r.verifiedTools, 0),
    receipts: results.reduce((n, r) => n + r.receipts, 0),
    verifiedReceipts: results.reduce((n, r) => n + r.verifiedReceipts, 0),
    results,
    note: 'Latency is host/transport overhead for a local turn, not model latency.',
  };
}

function compare(current, previous) {
  const byId = Object.fromEntries((previous.results || []).map((r) => [r.id, r]));
  const lines = [];
  for (const r of current.results) {
    const before = byId[r.id];
    if (!before) {
      lines.push(`  + ${r.id} (new)`);
      continue;
    }
    const d = r.pass === before.pass ? '' : r.pass ? '  REGRESSION FIXED' : '  REGRESSION';
    const dt = Math.round((r.ms - before.ms) * 100) / 100;
    lines.push(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.id.padEnd(18)} ${String(r.ms).padStart(7)}ms (${dt >= 0 ? '+' : ''}${dt})${d}`);
  }
  lines.push('');
  lines.push(`  pass rate ${previous.passRate}% -> ${current.passRate}%`);
  lines.push(`  p95 ${previous.latencyMs?.p95}ms -> ${current.latencyMs?.p95}ms`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const report = await runBenchmark();
  const write = process.argv.includes('--write');
  const compareIdx = process.argv.indexOf('--compare');
  const compareFile = compareIdx >= 0 ? process.argv[compareIdx + 1] : null;

  process.stdout.write(`\nMAJIN V4 benchmark — ${report.mode} (${report.model})\n`);
  process.stdout.write('='.repeat(64) + '\n');
  for (const r of report.results) {
    process.stdout.write(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.id.padEnd(18)} ${String(r.ms).padStart(7)}ms  ${r.goalState || '-'}  tools ${r.tools}/${r.verifiedTools} verified\n`);
  }
  process.stdout.write('-'.repeat(64) + '\n');
  process.stdout.write(`  pass ${report.passed}/${report.scenarios} (${report.passRate}%)  p50 ${report.latencyMs.p50}ms  p95 ${report.latencyMs.p95}ms\n`);
  process.stdout.write(`  receipts ${report.verifiedReceipts}/${report.receipts} verified  ·  ${report.note}\n`);

  if (compareFile && fs.existsSync(compareFile)) {
    process.stdout.write(`\ncompare vs ${path.basename(compareFile)}\n`);
    process.stdout.write(compare(JSON.parse(fs.readFileSync(compareFile, 'utf8')), report) + '\n');
  }

  if (write) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const name = `${report.at.slice(0, 10)}-${report.mode}.json`;
    fs.writeFileSync(path.join(REPORT_DIR, name), JSON.stringify(report, null, 2));
    process.stdout.write(`\nwrote docs/v4/benchmarks/${name}\n`);
  }

  process.stdout.write('\n');
  process.exitCode = report.failed === 0 ? 0 : 1;
}
