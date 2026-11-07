import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const code = fs.readFileSync(new URL('../src/core/tools/web.js', import.meta.url),'utf8');
const click = code.slice(code.indexOf("name: 'browser.click'"),code.indexOf("name: 'browser.fill'"));
const fill = code.slice(code.indexOf("name: 'browser.fill'"),code.indexOf("name: 'browser.shot'"));

test('real browser.fill never echoes user-entered values into returned result/meta',()=>{
  assert.match(fill,/stuck: el\.value ===/,'field value is verified against original input');
  assert.doesNotMatch(fill,/value: el\.value|value: r\.value|kept value/, 'raw form value must never leave browser eval or appear in tool response');
  assert.match(fill,/value hidden/,'agent must be told the value was intentionally redacted');
  assert.match(fill,/valueHidden: true/);
});
test('real browser.click does not echo input.value and reports checkbox state',()=>{
  assert.doesNotMatch(click,/el\.innerText\s*\|\|\s*el\.value|text:\s*el\.value/,'clicked inputs may contain private credentials');
  assert.match(click,/isCheckbox/);
  assert.match(click,/checkbox CHECKED/);
  assert.match(click,/checkbox UNCHECKED/);
  assert.match(click,/checkboxChanged: hit\.changed/);
});
