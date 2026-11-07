import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('browser.fill accepts grounded ref and checks element identity before mutation and after rendering',()=>{
  const src=fs.readFileSync('src/core/tools/web.js','utf8');
  const start=src.indexOf("name: 'browser.fill'");
  const end=src.indexOf("name: 'browser.shot'",start);
  assert.ok(start>=0&&end>start);
  const fill=src.slice(start,end);
  assert.match(fill,/ref: 'string optional numbered ref from browser\.elements/);
  assert.match(fill,/recallRef\(session,ref\)/);
  assert.match(fill,/code:'ref_unknown'/);
  assert.match(fill,/blocked:'ref_stale'/);
  assert.match(fill,/nodes\[0\]\.value === \$\{JSON\.stringify\(r\.targetValue\)\}/);
  assert.match(fill,/Boolean\(selector\) === Boolean\(ref\)/);
  assert.match(fill,/valueHidden: true/);
});
test('composer focus polish remains inside the chat surface and supports reduced motion',()=>{
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(html,/#composer:focus-within/);
  assert.match(html,/#composer \.composer-talk:focus-visible/);
  assert.match(html,/@media\(prefers-reduced-motion:reduce\)/);
});
