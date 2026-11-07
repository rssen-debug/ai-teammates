import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('grounded browser clicks lock to element identity before acting',()=>{
  const src=fs.readFileSync('src/core/tools/web.js','utf8');
  const click=src.slice(src.indexOf("name: 'browser.click'"),src.indexOf("name: 'browser.fill'"));
  assert.match(click,/const cached = recallRef\(session, ref\)/);
  assert.match(click,/const expected = \$\{expectedIdentity\}/);
  assert.match(click,/expected\.tag!==current\.tag/);
  assert.match(click,/expected\.href!==current\.href/);
  assert.match(click,/expected\.name!==current\.name/);
  assert.match(click,/blocked:'ref_identity_changed'/);
  assert.ok(click.indexOf("blocked:'ref_identity_changed'")<click.indexOf('el.click()'),
    'never click before verifying stale ground refs');
  assert.doesNotMatch(click,/text:String\(el\.innerText \|\| el\.value/);
});
test('browser reports a blocked stale click rather than claiming success',()=>{
  const src=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(src,/code:'click_blocked'/);
  assert.match(src,/click was NOT attempted/);
});
test('one small verified-progression glyph stays inside composer',()=>{
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(html,/#composer #work-progress\[data-phase="verified"\] \.pulse::before/);
  assert.match(html,/majin-proof-appear/);
  assert.match(html,/prefers-reduced-motion:reduce/);
  assert.equal((html.match(/id="work-progress"/g)||[]).length,1);
});
