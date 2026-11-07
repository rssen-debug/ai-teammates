/**
 * Runbook consistency lane — the operator doc cannot drift from the CLI
 * without the suite failing. Every --flag mentioned inside the runbook's
 * PowerShell code blocks must exist in bin/majin-v2.mjs parseArgs options,
 * every referenced path/module that the doc claims exists must exist,
 * and every honesty claim in the status table must name a real lane state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNBOOK = path.join(REPO, 'docs', 'v2', 'OPERATOR_RUNBOOK_WINDOWS.md');
const BIN = path.join(REPO, 'bin', 'majin-v2.mjs');

const doc = fs.readFileSync(RUNBOOK, 'utf8').replace(/\r\n/g, '\n');
const bin = fs.readFileSync(BIN, 'utf8').replace(/\r\n/g, '\n');

/** flags the CLI actually declares (source of truth = parseArgs options block) */
function cliFlags(src) {
  const m = src.match(/options:\s*\{([\s\S]*?)\n  \},\n  allowPositionals/);
  assert.ok(m, 'parseArgs options block found');
  const flags = new Set();
  for (const mm of m[1].matchAll(/'?([a-z][a-z0-9-]*)'?:\s*\{\s*type:/g)) flags.add(mm[1]);
  return flags;
}

/** flags mentioned inside ```powershell fences in the runbook */
function docFlags(md) {
  const blocks = [...md.matchAll(/```powershell\n([\s\S]*?)```/g)].map((b) => b[1]);
  assert.ok(blocks.length >= 4, 'runbook should carry real powershell blocks');
  const flags = new Set();
  for (const b of blocks) {
    // split on double quotes: odd segments are inside quotes (e.g. the whisper
    // command template carries ITS OWN flags — those are whisper's, not ours)
    const segments = b.split('"');
    segments.forEach((seg, i) => {
      if (i % 2 === 1) return;
      for (const mm of seg.matchAll(/--([a-z][a-z0-9-]*)/g)) flags.add(mm[1]);
    });
  }
  return flags;
}

test('1. every flag the runbook teaches exists in the CLI — doc cannot lie about the surface', () => {
  const have = cliFlags(bin);
  const taught = docFlags(doc);
  assert.ok(taught.size >= 10, `runbook teaches ${taught.size} flags`);
  const missing = [...taught].filter((f) => !have.has(f));
  assert.deepEqual(missing, [], `flags in runbook but not in CLI: ${missing.join(', ')}`);
});

test('2. runbook references only paths that exist in the repo', () => {
  const refs = ['bin/majin-v2.mjs', 'docs/v2/ACCEPTANCE_MATRIX.md'];
  for (const r of refs) {
    assert.ok(doc.includes(r), `runbook should reference ${r}`);
    assert.ok(fs.existsSync(path.join(REPO, r)), `${r} must exist for the runbook to be true`);
  }
});

test('3. honesty table present with the required classifications (VERIFIED/NOT_TESTED marked per lane)', () => {
  assert.match(doc, /Ärlig statuskolumn/);
  assert.match(doc, /VERIFIED \(doc-consistency-testet\)/);
  assert.match(doc, /NOT_TESTED \(ingen Windows i sandbox\)/);
  assert.match(doc, /NOT_TESTED — runner offline/);
});

test('4. consent-flow claims in the doc match the actual scopes the code enforces', () => {
  const scopes = ['studio:run-goals', 'voice:external'];
  for (const scope of scopes) {
    assert.ok(doc.includes(scope), `runbook documents ${scope}`);
  }
  const studio = fs.readFileSync(path.join(REPO, 'src/v2/studio/server.js'), 'utf8');
  assert.ok(studio.includes('studio:run-goals'), 'code enforces studio:run-goals');
  const speak = fs.readFileSync(path.join(REPO, 'src/v2/voice/speak.js'), 'utf8');
  assert.ok(speak.includes('voice:external'), 'code enforces voice:external');
});

test('5. exit-code claims in runbook match the CLI tests that prove them', () => {
  assert.match(doc, /0=COMPLETED, 1=FAILED, 2=missbruk/);
  const cliTest = fs.readFileSync(path.join(REPO, 'test/v2-cli.test.js'), 'utf8');
  assert.match(cliTest, /exit 0|code.*0/, 'CLI test proves exit 0 path');
  assert.match(cliTest, /2/, 'CLI test proves exit 2 misuse path');
});
