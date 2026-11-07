import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('conditional browser screenshots skip duplicate disk writes with SHA256',()=>{
  const source=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(source,/name: 'browser\.shot'/);
  assert.match(source,/ifChanged:'string optional true\|false/);
  assert.match(source,/createHash\('sha256'\)/);
  assert.match(source,/previous\?\.sha256===digest/);
  assert.match(source,/unchanged:true,sha256:digest/);
  assert.match(source,/unchanged:false,sha256:digest/);
  assert.match(source,/recentShot\.size>64/);
  assert.match(source,/recentShot\.delete\(ctx\.session \|\| 'default'\)/);
});
test('screenshot status stays inside the composer, not an added panel',()=>{
  const js=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(js,/ev\.tool==='browser\.shot' && ev\.ok/);
  assert.match(js,/Screenshot unchanged/);
  assert.match(js,/Screenshot captured/);
  assert.match(html,/#composer #work-progress\[data-phase="visual"\]/);
  assert.match(html,/prefers-reduced-motion:reduce/);
});
