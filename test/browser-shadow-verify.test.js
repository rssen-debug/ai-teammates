import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { VERIFY_JS, verificationCriteria, verifyObserved } from '../src/core/browser-evidence.js';

function evaluate({ shadow = true, duplicate = false, closed = false } = {}) {
  const control={
    innerText:'Saved successfully',
    tagName:'BUTTON',
    matches:()=>false,
    closest:()=>null,
    getAttribute:()=>null,
    getRootNode:()=>({host:{tagName:'MAJIN-WIDGET'}}),
    getBoundingClientRect:()=>({width:44,height:22})
  };
  const childRoot={
    querySelectorAll:selector=>selector==='*'?[]:selector==='#done'?[control]:[]
  };
  const host={shadowRoot:closed?null:childRoot};
  const document={
    querySelectorAll:selector=>{
      if(selector==='*')return [host];
      if(selector==='#done' && !shadow)return [control];
      if(selector==='#done' && duplicate)return [control];
      return [];
    }
  };
  const context={
    document,
    location:{href:'https://majin.test/saved',pathname:'/saved',origin:'https://majin.test'},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
  };
  const criteria=verificationCriteria({selector:'#done',text:'Saved'});
  const observed=vm.runInNewContext(VERIFY_JS.replace('__MAJIN_ARGS__',JSON.stringify(criteria)),context);
  return {observed,verdict:verifyObserved(criteria,observed)};
}
test('unique control nested in an open shadow root is verified',()=>{
  const {observed,verdict}=evaluate();
  assert.equal(observed.fromShadowRoot,true);
  assert.equal(observed.matchCount,1);
  assert.equal(verdict.ok,true);
  assert.equal(verdict.observed.fromShadowRoot,true);
});
test('shadow-root and light-DOM duplicates are rejected, not arbitrarily selected',()=>{
  const {observed,verdict}=evaluate({duplicate:true});
  assert.equal(observed.matchCount,2);
  assert.equal(verdict.ok,false);
  assert.ok(verdict.failures.some(x=>x.name==='element_unique'));
});
test('closed shadow roots are not guessed or marked successful',()=>{
  const {verdict}=evaluate({closed:true});
  assert.equal(verdict.ok,false);
});
test('voice-first chat shows a single inline verification marker',()=>{
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(app,/shadow\?'Shadow DOM control verified':'Browser result verified'/);
  assert.match(html,/#composer #work-progress\[data-phase="shadow-verified"\]/);
  assert.doesNotMatch(html,/id="shadow-verified-panel"/);
});
