import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('blocked browser click returns real overlapping controls without clicking',()=>{
  const s=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(s,/const overlay=over\.closest/);
  assert.match(s,/recoveryControls:controls/);
  assert.match(s,/recoveryControls:hit\.recoveryControls\|\|\[\]/);
  assert.ok(s.indexOf("blocked:'occluded'")<s.indexOf("el.click();"));
  assert.match(s,/Visible overlapping controls:/);
  assert.match(s,/\.slice\(0,6\)\.map/);
});
test('obstructed state uses existing single composer, no extra panel',()=>{
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(app,/ev\.tool==='browser\.click' && !ev\.ok && ev\.error\?\.reason==='occluded'/);
  assert.match(app,/bar\.dataset\.phase='obstructed'/);
  assert.match(html,/#composer #work-progress\[data-phase="obstructed"\]/);
  assert.equal((html.match(/id="work-progress"/g)||[]).length,1);
});
