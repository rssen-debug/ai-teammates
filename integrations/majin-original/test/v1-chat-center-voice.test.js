import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const css=fs.readFileSync('src/ui/phoenix.css','utf8');
const app=fs.readFileSync('src/ui/app.js','utf8');
const html=fs.readFileSync('src/ui/index.html','utf8');
test('composer and transcript use the same centered chat width',()=>{
  assert.match(css,/body\.simple #scroller>\.msg\{[^}]*var\(--chat-width\)[^}]*margin-inline:auto/);
  assert.match(css,/body\.simple footer #composer,body\.simple footer \.crow,body\.simple footer #run-state\{[^}]*var\(--chat-width\)[^}]*margin-inline:auto/);
  assert.match(css,/body\.simple #composer #input\{[^}]*grid-column:2;grid-row:1/);
  assert.match(css,/@media\(max-width:600px\)\{body\.simple footer\{padding-inline:12px/);
});
test('single composer with accessible voice and send controls',()=>{
  assert.equal((html.match(/id="composer"/g)||[]).length,1);
  assert.equal((html.match(/id="mic"/g)||[]).length,1);
  assert.equal((html.match(/id="send"/g)||[]).length,1);
});
test('unsupported speech recognizer cannot leave hands-free stuck on',()=>{
  assert.match(app,/if\(!SR\)\{S\.handsFree=false;S\.listening=false;voiceState\('error'/);
  assert.match(app,/if\(S\.handsFree&&!S\.busy\)startMic\(\)/);
});
