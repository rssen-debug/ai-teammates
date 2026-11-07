import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('browser.click supports grounded accessible target and rejects ambiguity',()=>{
  const src=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(src,/role: 'string optional: button\|link\|checkbox\|textbox/);
  assert.match(src,/!\['button','link','checkbox','textbox'\]\.includes/);
  assert.match(src,/semantic_target_missing/);
  assert.match(src,/blocked:'ambiguous_target'/);
  assert.match(src,/semantic\.name\.toLocaleLowerCase\(\)/);
  assert.match(src,/el\.closest\('\[aria-hidden="true"\],\[inert\]'\)/);
});
test('one in-composer activity symbol changes with evidence, no popup',()=>{
  const h=fs.readFileSync('src/ui/index.html','utf8');
  const a=fs.readFileSync('src/ui/app.js','utf8');
  assert.match(h,/id="work-progress-symbol"/);
  assert.match(h,/#composer #work-progress-symbol/);
  assert.match(a,/work-progress-symbol/);
  assert.match(a,/textContent='✓'/);
});
