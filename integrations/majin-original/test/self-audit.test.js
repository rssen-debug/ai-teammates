import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import fileURL from 'node:url';
import { runAudit, checkMockResidue, checkClaims, checkStatusDrift, checkRecoveryReadiness, renderAudit, VERSION, RULES } from '../src/core/self-audit.js';

const ROOT = path.resolve(path.dirname(fileURL.fileURLToPath(import.meta.url)), '..');

test('W14 audit of THIS repo is honest-clean on the evidence side (no claims/mock/high findings in shipped source)', () => {
  const rep = runAudit({ root: ROOT, home: path.join(os.tmpdir(), 'majin-audit-home-' + Date.now()), scopes: ['unsupported-claims', 'mock-mode-residue'] });
  assert.equal(rep.findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length, 0,
    'shipped source must contain zero unsupported-claim strings and no mock residue: ' +
    JSON.stringify(rep.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')));
});

test('W14 mock-residue detector catches a poisoned session precisely', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-a-m'));
  const sdir = path.join(home, 'sessions');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'bad-session-1.json'), JSON.stringify([{ role: 'assistant', text: 'stub', meta: { mocked: true } }]));
  const findings = checkMockResidue(home);
  assert.equal(findings.length, 1, 'candidate root ' + sdir + ' must be scanned: ' + JSON.stringify(findings));
  assert.equal(findings[0].rule, 'mock-mode-residue');
  assert.equal(findings[0].severity, 'critical');
  fs.rmSync(home, { recursive: true, force: true });
});

test('W14 status-drift catches inconsistent docs (seeded fixture)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-a-d'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'MAJIN_100_STATUS.md'), 'Total ekvivalent status: **40/100**');
  fs.writeFileSync(path.join(root, 'docs', 'MAJIN_100_BACKLOG.json'), JSON.stringify({ roundLog: [{ round: 9, percent: 55 }] }));
  const drift = checkStatusDrift(root);
  assert.equal(drift.length, 1);
  assert.match(drift[0].snippet, /40\/100/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('W14 status-drift passes on CONSISTENT current repo docs', () => {
  const drift = checkStatusDrift(ROOT);
  assert.equal(drift.length, 0, 'STATUS.md and BACKLOG roundLog tail must agree — otherwise our own progress claim is false: ' + JSON.stringify(drift));
});

test('W14 recovery-readiness reports stale flow state when the plan says so (no side effects)', () => {
  const f = checkRecoveryReadiness({ files: [{ kind: 'stale-flow-state' }], freedBytes: 10 });
  assert.equal(f.length, 1);
  assert.equal(checkRecoveryReadiness({ files: [], freedBytes: 0 }).length, 0);
});

test('W14 claims scan flags seeded claim text (negative control)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-a-c'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'evil.js'), "const msg = 'fully verified 100/100';");
  const found = checkClaims(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, 'unsupported-claims');
  fs.rmSync(root, { recursive: true, force: true });
});

test('W14 render is bounded, evidence-shaped, and verdict honest', () => {
  const rep = runAudit({ root: ROOT, home: path.join(os.tmpdir(), 'majin-audit-home2-' + Date.now()), scopes: RULES });
  const t = renderAudit(rep);
  assert.match(t, /self-audit .* — verdict: /);
  assert.ok(t.length < 8000);
  /* findings with a file must also state WHY — no naked hits */
  for (const f of rep.findings) assert.ok(f.why.length > 10);
  assert.ok(VERSION.startsWith('majin-selfaudit/'));
});
