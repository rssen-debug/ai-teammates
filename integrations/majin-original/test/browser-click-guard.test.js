import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('browser.click refuses hidden, disabled and occluded targets before DOM click',()=>{
  const s=fs.readFileSync('src/core/tools/web.js','utf8');
  const i=s.indexOf("name: 'browser.click'");
  const block=s.slice(i,s.indexOf("name: 'browser.fill'",i));
  assert.ok(i>=0);
  for(const reason of ["blocked:'hidden'","blocked:'disabled'","blocked:'occluded'","blocked:'outside_viewport'"])
    assert.ok(block.includes(reason),reason);
  assert.match(block,/elementFromPoint\(x,y\)/);
  assert.match(block,/el\.closest\('\[inert\]'\)/);
  assert.ok(block.indexOf("if(hit.found && hit.blocked)")<0 || block.includes("code:'click_blocked'"));
  assert.ok(block.indexOf("blocked:'occluded'") < block.indexOf('el.click()'));
  assert.match(block,/Browser click was NOT attempted/);
});

test('MAJIN activity remains compact and only claims verification from successful browser.verify',()=>{
  const a=fs.readFileSync('src/ui/app.js','utf8');
  const h=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(a,/ev\.tool==='browser\.verify' && ev\.ok/);
  assert.match(a,/bar\.dataset\.phase='verified'/);
  assert.match(a,/ev\.error\?\.code==='click_blocked'/);
  assert.match(h,/#composer #work-progress\[data-phase="verified"\]/);
  assert.doesNotMatch(h,/id="browser-verification-panel"/);
});
