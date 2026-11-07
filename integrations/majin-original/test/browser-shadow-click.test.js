import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('browser click resolves accessible controls in bounded open shadow roots, not first-match guesses',()=>{
  const s=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(s,/const queryDeep=\(css\)=>/);
  assert.match(s,/node\.shadowRoot && roots\.length<16/);
  assert.match(s,/i<16 && scanned<350/);
  assert.match(s,/matches=queryDeep\(selectors\[semantic\.role\]\)/);
  assert.match(s,/else matches=queryDeep\(/);
  assert.match(s,/blocked:'ambiguous_target'/);
  assert.match(s,/fromShadowRoot: Boolean/);
});
test('browser click continues to require grounded targets and verifies outcome',()=>{
  const s=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(s,/role: 'string optional: button\|link\|checkbox\|textbox/);
  assert.match(s,/verificationCriteria\(/);
  assert.match(s,/verifyObserved\(/);
  assert.match(s,/ref_identity_changed/);
});
test('action shimmer stays in the composer and honors reduced-motion settings',()=>{
  const s=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(s,/#composer #work-progress\[data-phase="action"\]::before/);
  assert.match(s,/@keyframes majin-action-trace/);
  assert.match(s,/prefers-reduced-motion:reduce/);
});
