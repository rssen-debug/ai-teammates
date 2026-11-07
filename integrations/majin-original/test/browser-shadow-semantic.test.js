import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SEMANTIC_SNAPSHOT_JS, formatSemanticSnapshot } from '../src/core/browser-semantic.js';

function element(tag, label, extras={}) {
  return {
    tagName:tag,innerText:label,labels:[],
    getAttribute(k){return k==='type'?'button':null;},
    getBoundingClientRect(){return {width:120,height:24};},
    closest(){return null;},matches(sel){return tag==='BUTTON' && sel.includes('button');},
    ...extras
  };
}
test('semantic observation reaches an OPEN shadow root and does not emit form values',()=>{
  const secret=element('INPUT','', { value:'secret-token',getAttribute(k){return k==='placeholder'?'Search':k==='type'?'text':null;},matches(sel){return sel.includes('input');} });
  const save=element('BUTTON','Save changes');
  const shadow={querySelectorAll(q){return q==='*'?[save,secret]:[save,secret];}};
  const host=element('DIV','',{shadowRoot:shadow,matches(){return false;}});
  const doc={title:'Account',querySelectorAll(q){return q==='*'?[host]:[];}};
  const environment={document:doc,getComputedStyle(){return {display:'block',visibility:'visible',opacity:'1'}},
    location:{origin:'https://example.test',pathname:'/settings',search:'?token=hidden'}};
  const snapshot=vm.runInNewContext(SEMANTIC_SNAPSHOT_JS,environment);
  assert.equal(snapshot.shadowRoots,1);
  assert.equal(snapshot.elements.length,2);
  const out=formatSemanticSnapshot(snapshot);
  assert.match(out,/button "Save changes"/);
  assert.match(out,/textbox "Search"/);
  assert.doesNotMatch(out,/secret-token|token=hidden/);
});
test('shadow scan has explicit resource caps, composer focus remains single-surface',()=>{
  const src=fs.readFileSync('src/core/browser-semantic.js','utf8');
  const ui=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(src,/index < 16 && scanned < 350/);
  assert.match(src,/roots.length < 16/);
  assert.match(ui,/#composer:focus-within/);
  assert.match(ui,/prefers-reduced-motion:reduce/);
});
