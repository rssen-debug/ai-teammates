import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../src/core/memory.js';

test('remember/forget preserve earlier facts and recover legacy lines without bullets', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-memory-notes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const memory = new Memory({ get: key => key === 'memory.dir' ? directory : undefined });
  fs.writeFileSync(memory.factsFile, '# Minnen\n\nlegacy note ALPHA\n- existing note BETA\n');
  memory.remember('new note GAMMA');
  assert.deepEqual(memory.facts(), ['new note GAMMA', 'legacy note ALPHA', 'existing note BETA']);
  memory.forget('GAMMA');
  assert.deepEqual(memory.facts(), ['legacy note ALPHA', 'existing note BETA']);
  const reloaded = new Memory(memory.cfg);
  assert.deepEqual(reloaded.facts(), memory.facts());
  assert.match(fs.readFileSync(memory.factsFile, 'utf8'), /- legacy note ALPHA\n- existing note BETA/);
});
