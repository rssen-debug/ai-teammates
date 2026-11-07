import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SEMANTIC_SNAPSHOT_JS, formatSemanticSnapshot } from '../src/core/browser-semantic.js';

test('compact page structure has headings and roles without input values',()=>{
  const selector={
    tagName:'INPUT',
    getAttribute(k){return k==='type'?'text':k==='placeholder'?'Search here':null},
    getBoundingClientRect(){return {width:100,height:24}},
    closest(){return null},
    matches(){return false},
    labels:[],innerText:'SECRET',value:'api-key-do-not-leak'
  };
  const heading={
    tagName:'H2',innerText:'Account settings',
    getAttribute(){return null},
    getBoundingClientRect(){return {width:300,height:40}},
    closest(){return null},
    matches(){return false}
  };
  const env={document:{title:'Dashboard',querySelectorAll(){return [heading,selector]}},
    getComputedStyle(){return {display:'block',visibility:'visible',opacity:'1'}},
    location:{origin:'https://sample.test',pathname:'/settings',search:'?token=secret'}};
  const snap=vm.runInNewContext(SEMANTIC_SNAPSHOT_JS,env);
  assert.equal(snap.elements.length,2);
  const output=formatSemanticSnapshot(snap);
  assert.match(output,/h2 level=2 "Account settings"/);
  assert.match(output,/textbox "Search here"/);
  assert.doesNotMatch(output,/api-key-do-not-leak|token=secret/);
});
test('no visible elements means bounded empty outline, never full HTML dump',()=>{
  const out=formatSemanticSnapshot({url:'https://sample.test',title:'Example',elements:[]});
  assert.match(out,/Page: Example/);
  assert.ok(out.length<100);
  const lots=Array.from({length:200},()=>({role:'button',label:'x'.repeat(300)}));
  assert.ok(formatSemanticSnapshot({url:'',title:'',elements:lots}).length<=6500);
});
test('browser.read keeps its original API and supports structure mode without another tool schema',()=>{
  const s=fs.readFileSync('src/core/tools/web.js','utf8');
  const a=fs.readFileSync('src/ui/app.js','utf8');
  const h=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(s,/name: 'browser\.read'/);
  assert.match(s,/String\(mode\)\.toLowerCase\(\)==='structure'/);
  assert.match(s,/formatSemanticSnapshot\(payload\)/);
  assert.match(a,/Mapping page structure/);
  assert.match(h,/data-phase="structure"/);
});
