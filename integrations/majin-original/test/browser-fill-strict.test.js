import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('browser.fill requires a unique field before changing anything',()=>{
  const s=fs.readFileSync('src/core/tools/web.js','utf8');
  const fill=s.slice(s.indexOf("name: 'browser.fill'"),s.indexOf("name: 'browser.shot'"));
  assert.match(fill,/document\.querySelectorAll\(\$\{sel\}\)/);
  assert.match(fill,/nodes\.length > 1/);
  assert.match(fill,/ambiguous_target/);
  assert.match(fill,/disabled_or_readonly/);
  assert.match(fill,/el\.readOnly/);
  assert.match(fill,/value_reverted/);
  assert.match(fill,/setTimeout\(resolve, 120\)/);
  assert.match(fill,/retained: true, valueHidden: true, verified: true/);
  assert.doesNotMatch(fill,/result:[^\n]*\$\{val\}/,'never echo the entered value in tool results');
});

test('existing composer reflects verified/rejected form outcomes without new panel',()=>{
  const s=fs.readFileSync('src/ui/app.js','utf8');
  assert.match(s,/ev\.tool==='browser\.fill'/);
  assert.match(s,/Field retained · verified/);
  assert.match(s,/bar\.dataset\.phase=confirmed\?'verified':'problem'/);
  assert.match(s,/Input content is never shown/);
});
