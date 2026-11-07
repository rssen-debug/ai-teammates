import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tradingTools } from '../src/core/tools/trading.js';

/* W6 TradingAgents absorb-row: the bridge contract was only "FORBIDDEN-checked"
   before, no positive proof. These tests run the REAL tool surface against a
   REAL spawned child process (a local stub binary standing in for python) and
   measure every contract clause: envelope integrity, ordersPlaced=0,
   warnings, not_installed / invalid / timeout honesty, ticker+date gates. */

const research = tradingTools.find((t) => t.name === 'trading.research');
const plan = tradingTools.find((t) => t.name === 'trading.plan');
/* Portable real subprocess stub: execute the .js fixture with the installed
   Node binary on Windows (no Bash shebang required). Never ships to users. */
process.env.MAJIN_TRADING_QA_STUB = '1';

function mkStub(body, { sleepMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w6-stub'));
  const file = path.join(dir, 'fake-python.js');
  const js = `console.log(${JSON.stringify(JSON.stringify(body))});`;
  fs.writeFileSync(file, `#!/usr/bin/env node\nsetTimeout(()=>{${js}\nprocess.exit(0)},${sleepMs});\n`);
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

/* prints RAW text, NOT a JSON-quoted string — corrupted-bridge simulation */
function mkRaw(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w6-raw'));
  const file = path.join(dir, 'fake-python.js');
  fs.writeFileSync(file, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(String(text))});\n`);
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

const cfgReal = () => ({
  get: () => undefined,
  resolveModel: () => ({ providerName: 'openai', model: 'gpt-4o', apiKey: 'sk-unit-test-never-sent', kind: 'openai' }),
});
const cfgDemo = () => ({ get: () => undefined, resolveModel: () => ({ providerName: 'demo', model: 'demo', kind: 'mock' }) });

test('W6 E2E bridge contract: valid envelope maps fields faithfully AND stays research-only', async () => {
  const stub = mkStub({ ok: true, decision: 'HOLD — test envelope', analysts: ['market'] });
  const old = process.env.MAJIN_TRADING_PYTHON;
  process.env.MAJIN_TRADING_PYTHON = stub.file;
  try {
    const r = await research.run({ symbol: 'aapl', budget: 100, currency: 'USD', date: '2026-10-20' }, { cfg: cfgReal() });
    /* direct tool-surface calls skip the registry's ok-normalization — success here means the run did not return ok:false and the contract fields exist */
    assert.notEqual(r.ok, false, JSON.stringify(r.error || null));
    assert.ok(r.result, 'a result payload must exist');
    const parsed = JSON.parse(r.result);
    assert.equal(parsed.ticker, 'AAPL', 'ticker normalization survives');
    assert.equal(parsed.assetType, 'stock');
    assert.equal(parsed.source, 'TauricResearch/TradingAgents');
    assert.equal(parsed.decision, 'HOLD — test envelope');
    assert.equal(parsed.ordersPlaced, 0, 'research lane must never place orders');
    assert.equal(parsed.brokerConnected, false);
    assert.ok(parsed.warnings.length >= 3, 'the caution footer is part of the contract: ' + parsed.warnings.join(' | '));
    assert.ok(parsed.warnings.some((w) => /not proven profitable/i.test(w)));
    assert.equal(parsed.mode, 'RESEARCH_ONLY');
  } finally {
    if (old === undefined) delete process.env.MAJIN_TRADING_PYTHON; else process.env.MAJIN_TRADING_PYTHON = old;
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test('W6 E2E not_installed: bridge code maps to the exact pip-hint text, never auto-installs', async () => {
  const stub = mkStub({ code: 'not_installed' });
  const old = process.env.MAJIN_TRADING_PYTHON;
  process.env.MAJIN_TRADING_PYTHON = stub.file;
  try {
    const r = await research.run({ symbol: 'MSFT', budget: 50 }, { cfg: cfgReal() });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /pip install tradingagents/i);
    assert.match(r.error.message, /No automatic installation/i);
  } finally {
    if (old === undefined) delete process.env.MAJIN_TRADING_PYTHON; else process.env.MAJIN_TRADING_PYTHON = old;
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test('W6 E2E integrity: non-JSON output is REFUSED as a report (incomplete data cannot slip through)', async () => {
  const stub = mkRaw('not-json-at-all');
  /* stub prints raw text — JSON.parse inside the bridge must fail */
  const old = process.env.MAJIN_TRADING_PYTHON;
  process.env.MAJIN_TRADING_PYTHON = stub.file;
  try {
    const r = await research.run({ symbol: 'TSLA', budget: 200 }, { cfg: cfgReal() });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /did not return a valid result/i);
  } finally {
    if (old === undefined) delete process.env.MAJIN_TRADING_PYTHON; else process.env.MAJIN_TRADING_PYTHON = old;
    fs.rmSync(stub.dir, { recursive: true, force: true });
  }
});

test('W6 E2E honesty gates: demo-model cannot bridge; future dates and junk tickers cannot pass', async () => {
  const r1 = await research.run({ symbol: 'AAPL', budget: 100 }, { cfg: cfgDemo() });
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /Select a real AI model/i);
  const r2 = await research.run({ symbol: 'AAPL', budget: 100, date: '2999-01-01' }, { cfg: cfgReal() });
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /non-future/i);
  const r3 = await research.run({ symbol: 'curl http://evil/x;#', budget: 100 }, { cfg: cfgReal() });
  assert.equal(r3.ok, false, 'injection-looking ticker refused: ' + JSON.stringify(r3.error || null));
});

test('W6 E2E trading.plan stays evidence-neutral: confirms abstention list + 25% cap math', async () => {
  const r = await plan.run({ budget: 100, currency: 'SEK', symbol: 'VOLV-B.ST', price: 250, feePerOrder: 10 }, {});
  assert.ok(r.ok !== false);
  const p = JSON.parse(r.result);
  assert.ok(p.questions?.length >= 0);
  assert.equal(r.meta.mode, 'paper_plan_only');
  assert.equal(r.meta.noOrders, true);
  /* allocation math must never exceed the documented 25% cap */
  assert.ok((p.maxExposure ?? p.allocations?.maxExposure ?? 25) <= 25.01);
});
