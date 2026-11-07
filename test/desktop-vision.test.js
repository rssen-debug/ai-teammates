import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { captureEvidence, groundTargets, verifyOnScreen, parseGroundingContract, platformGate, DesktopVisionError, VERSION, evidenceDir } from '../src/core/desktop-vision.js';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'w11-vision-'));
// 1x1 PNG-ish bytes — the harness measures BYTES, not image semantics, so test bytes are fine
const FAKE_SHOT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('fake-screen-bytes')]);

test('W11 desktop-vision: utan injicerad captureFn REFUSERAR observationen — ingen frabricerad skärmdump', async () => {
  await assert.rejects(() => captureEvidence({ dir: ws() }), /no captureFn injected/);
});

test('W11 desktop-vision: captureEvidence skriver bytes + sha256, tom capture refuseras högljudt', async () => {
  const dir = ws();
  const ev = await captureEvidence({ captureFn: async () => FAKE_SHOT, dir });
  assert.match(ev.sha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(ev.file).length, FAKE_SHOT.length, 'diskerten är capturens bytes');
  await assert.rejects(() => captureEvidence({ captureFn: async () => Buffer.alloc(0), dir }), /no bytes/);
  await assert.rejects(() => captureEvidence({ captureFn: () => 'nonexistent-path-nope', dir: ws() }), DesktopVisionError);
});

test('W11 desktop-vision: groundning accepterar BARA strikta [{label,x,y}] — aldrig prosa till klickkoordinater', async () => {
  const dir = ws();
  const r = await groundTargets({
    captureFn: async () => FAKE_SHOT,
    analyzeFn: async () => 'I see a button. [{"label":"Save","x":412,"y":340},{"label":"Cancel","x":520,"y":340}] as requested.',
    dir, question: 'locate dialog buttons',
  });
  assert.equal(r.targets.length, 2);
  assert.equal(r.targets[0].label, 'Save');
  assert.match(r.evidence.sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(() => groundTargets({
    captureFn: async () => FAKE_SHOT,
    analyzeFn: async () => 'the Save button is somewhere around the middle of the dialog, click there',
    dir: ws(), question: 'locate dialog buttons',
  }), /strict grounding contract/);
});

test('W11 desktop-vision: parseGroundingContract avvisar allt som inte är strukturerad sanning', () => {
  assert.equal(parseGroundingContract('no coordinates in sight'), null);
  assert.equal(parseGroundingContract('[{"label":"X"}]'), null);
  assert.equal(parseGroundingContract('[{"label":"X","x":"10","y":2}]'), null);
  assert.equal(parseGroundingContract('[{"label":"X","x":1,"y":2}]').length, 1);
  assert.equal(parseGroundingContract(42), null);
});

test('W11 desktop-vision: verifyOnScreen — accept() avgör, aldrig "modellen sa ja"; evidence skrivs ALLTID', async () => {
  const dir = ws();
  const win = await verifyOnScreen({
    captureFn: async () => FAKE_SHOT,
    analyzeFn: async () => 'The dialog title reads "Save As" and the file list shows 3 entries.',
    dir, question: 'what does the dialog say?', accept: (a) => a.includes('"Save As"'),
  });
  assert.equal(win.passed, true);
  const lose = await verifyOnScreen({
    captureFn: async () => FAKE_SHOT,
    analyzeFn: async () => 'The dialog title reads "Save As".',
    dir, question: 'is the dialog Save As?', accept: (a) => a.toLowerCase().includes('export dialog'),
  });
  assert.equal(lose.passed, false);
  const verdicts = fs.readFileSync(path.join(dir, 'verdicts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(verdicts.length, 2, 'båda verdicts loggade — även misslycket är evidence');
  assert.equal(JSON.parse(verdicts[0]).version, VERSION);
  await assert.rejects(() => verifyOnScreen({ captureFn: async () => FAKE_SHOT, analyzeFn: async () => 'x', dir: ws(), question: 'q' , accept: null }), /never a proof/);
});

test('W11 platformGate: live lane finns BARA på Windows — annan plattform deklarerar deferred-honestly', () => {
  const linux = platformGate('linux');
  assert.equal(linux.canCaptureLive, false);
  assert.equal(linux.lane, 'deferred-hardware-required');
  const win = platformGate('win32');
  assert.equal(win.lane, 'live-windows');
  const here = platformGate();
  assert.equal(here.platform, process.platform);
});

test('W11 evidenceDir: skapar isolerade beviskataloger under workspace', () => {
  const dir = ws();
  const d = evidenceDir(dir, 'task-123');
  assert.ok(fs.statSync(d).isDirectory());
  assert.match(d, /desktop-vision[\\/]task-123$/);
});
