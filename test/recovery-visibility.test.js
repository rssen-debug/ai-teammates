import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('repeated tool failure produces structured visible recovery event',()=>{
  const src=fs.readFileSync('src/core/loop.js','utf8');
  assert.match(src,/type: 'agent_recovery'/);
  assert.match(src,/phase: 'blocked'/);
  assert.match(src,/Last failing tool:/);
  assert.match(src,/stopReason: 'repeat_block'/);
});
test('recovery status appears inside composer and stays accessible',()=>{
  const ui=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(ui,/ev\.type === 'agent_recovery'/);
  assert.match(ui,/dataset\.phase=ev\.phase==='blocked'\?'problem':'recovery'/);
  assert.match(html,/#composer #work-progress\[data-phase="recover"\]/);
  assert.match(html,/id="work-progress" role="status" aria-live="polite"/);
  assert.match(html,/prefers-reduced-motion:reduce/);
});
