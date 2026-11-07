import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERIFY_JS, verificationCriteria, verifyObserved } from '../src/core/browser-evidence.js';

test('browser.verify exact path cannot be fooled by redirect query string',()=>{
  const c=verificationCriteria({urlPath:'/dashboard',urlOrigin:'https://app.example.com'});
  assert.equal(c.ok,true);
  const deceptive=verifyObserved(c,{
    valid:true,url:'https://app.example.com/login?next=/dashboard',
    title:'Login',pathMatch:false,originMatch:true
  });
  assert.equal(deceptive.ok,false);
  assert.ok(deceptive.failures.some(x=>x.name==='url_path_exact'));
  assert.equal(verifyObserved(c,{
    valid:true,url:'https://app.example.com/dashboard',title:'Dashboard',
    pathMatch:true,originMatch:true
  }).ok,true);
});
test('browser.verify exact origin prevents lookalike-domain confirmation',()=>{
  const c=verificationCriteria({urlOrigin:'https://app.example.com'});
  assert.equal(c.ok,true);
  const fake=verifyObserved(c,{
    valid:true,url:'https://app.example.com.evil.test/dashboard',title:'Dashboard',
    originMatch:false
  });
  assert.equal(fake.ok,false);
  assert.ok(fake.failures.some(x=>x.name==='url_origin_exact'));
});
test('strict URL expectation input is validated before opening the browser',()=>{
  for (const urlPath of ['dashboard','//evil.test','/ok?next=/dashboard','/x#fragment']) {
    assert.equal(verificationCriteria({urlPath}).ok,false,urlPath);
  }
  for (const urlOrigin of ['https://app.example.com/foo','javascript:alert(1)','https://u:p@app.example.com','https://app.example.com/']) {
    assert.equal(verificationCriteria({urlOrigin}).ok,false,urlOrigin);
  }
  assert.equal(verificationCriteria({urlPath:'/'}).ok,true);
  assert.equal(verificationCriteria({urlOrigin:'https://app.example.com'}).ok,true);
  assert.match(VERIFY_JS,/location\.pathname === args\.urlPath/);
  assert.match(VERIFY_JS,/location\.origin === args\.urlOrigin/);
});
test('strict URL proof is exposed in tool schema and shown inline without new panels',()=>{
  const tool=fs.readFileSync('src/core/tools/web.js','utf8');
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(tool,/urlPath: 'string optional EXACT pathname/);
  assert.match(tool,/urlOrigin: 'string optional EXACT origin/);
  assert.match(app,/bar\.dataset\.phase='verified'/);
  assert.match(app,/glyph\.textContent='✓'/);
  assert.match(html,/#composer #work-progress\[data-phase="verified"\]/);
  assert.match(html,/prefers-reduced-motion:reduce/);
});
