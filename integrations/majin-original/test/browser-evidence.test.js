import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERIFY_JS, verificationCriteria, verifyObserved, browserRecoveryAdvice } from '../src/core/browser-evidence.js';

test('verify browser evidence requires a concrete observable expectation',()=>{
  assert.equal(verificationCriteria({}).ok,false);
  assert.equal(verificationCriteria({text:'Saved'}).ok,false);
  assert.equal(verificationCriteria({checked:'true'}).ok,false);
  assert.equal(verificationCriteria({selector:'#saved'}).ok,true);
  assert.equal(verificationCriteria({url:'/done'}).ok,true);
});
test('successful click alone is not proof: expected element absent fails',()=>{
  const c=verificationCriteria({selector:'#success',text:'Saved'});
  const r=verifyObserved(c,{valid:true,url:'https://example.test',title:'Example',exists:false,visible:false,textMatch:false});
  assert.equal(r.ok,false);
  assert.ok(r.failures.some(x=>x.name==='element_present'));
});
test('visible element and expected text constitute evidence',()=>{
  const c=verificationCriteria({selector:'#success',text:'Saved',url:'/done'});
  const r=verifyObserved(c,{valid:true,url:'https://example.test/done',title:'Saved',exists:true,unique:true,matchCount:1,visible:true,textMatch:true,urlMatch:true});
  assert.equal(r.ok,true);assert.equal(r.failures.length,0);
});
test('checkbox state is verified, not assumed based on click',()=>{
  const c=verificationCriteria({selector:'#consent',checked:'true'});
  const no=verifyObserved(c,{valid:true,url:'',title:'',exists:true,unique:true,matchCount:1,visible:true,checked:false});
  assert.equal(no.ok,false);
  const yes=verifyObserved(c,{valid:true,url:'',title:'',exists:true,unique:true,matchCount:1,visible:true,checked:true});
  assert.equal(yes.ok,true);
});
test('absence assertions and malformed CSS fail safely',()=>{
  const c=verificationCriteria({selector:'.gone',present:'false'});
  assert.equal(verifyObserved(c,{valid:true,url:'',title:'',exists:false,visible:false}).ok,true);
  assert.equal(verifyObserved(c,{valid:false,reason:'invalid_selector'}).ok,false);
  assert.match(VERIFY_JS,/invalid_selector/);
  assert.doesNotMatch(VERIFY_JS,/input\.value|document\.cookie/);
});
test('tool remains read-only and returns assertion_failed instead of fake completion',async()=>{
  const fs=await import('node:fs');
  const src=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(src,/name: 'browser\.verify'/);
  assert.match(src,/risk: 'read'/);
  assert.match(src,/code:'assertion_failed'/);
  assert.match(src,/verifyObserved\(criteria,observed\)/);
});

test('browser verifier rejects ambiguous selectors rather than verifying a random matching element',()=>{
  const criteria=verificationCriteria({selector:'.save-button',text:'Saved'});
  const verdict=verifyObserved(criteria,{
    valid:true,url:'https://example.test/done',title:'Save',
    exists:true,unique:false,matchCount:3,visible:false,textMatch:false
  });
  assert.equal(verdict.ok,false);
  assert.ok(verdict.failures.some(x=>x.name==='element_unique'));
  assert.equal(verdict.observed.matchCount,3);
  assert.match(VERIFY_JS,/querySelectorAll\(selector\)/);
});
test('contradictory absence and checkbox/text expectations fail before interaction',()=>{
  assert.equal(verificationCriteria({selector:'.item',present:'false',text:'Hi'}).ok,false);
  assert.equal(verificationCriteria({selector:'#agree',present:'false',checked:'true'}).ok,false);
});

test('click can assert post-action effects in one bounded browser call',async()=>{
  const fs=await import('node:fs');
  const src=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(src,/name: 'browser\.click'/);
  assert.match(src,/expectSelector: 'string optional/);
  assert.match(src,/expectUrl: 'string optional/);
  assert.match(src,/verificationCriteria\(\{/);
  assert.match(src,/code:'post_click_assertion_failed'/);
  assert.match(src,/Math\.min\(4000,Math\.max\(0/);
  assert.match(src,/verified: proof\?\.ok/);
  assert.match(src,/if\(requiresVerification && !expected\.ok\)/);
});

test('disabled native or aria-disabled controls cannot be called ready',()=>{
  const c=verificationCriteria({selector:'#publish',enabled:'true'});
  assert.equal(c.ok,true);
  const no=verifyObserved(c,{valid:true,url:'https://example.test',title:'Page',exists:true,unique:true,visible:true,enabled:false});
  assert.equal(no.ok,false);
  assert.equal(no.failures[0].name,'element_enabled');
  const yes=verifyObserved(c,{valid:true,url:'https://example.test',title:'Page',exists:true,unique:true,visible:true,enabled:true});
  assert.equal(yes.ok,true);
  assert.equal(verificationCriteria({enabled:'true'}).ok,false,'enabled assertion requires a grounded selector');
});
test('composer focus is visually distinguished without new panels',async()=>{
  const fs=await import('node:fs');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(html,/#composer:focus-within/);
  assert.match(html,/#composer #send:not\(:disabled\):hover/);
  assert.match(html,/prefers-reduced-motion/);
});

test('SPA verifier demands a sustained result instead of trusting a transient DOM flash',async()=>{
  const fs=await import('node:fs');
  const src=fs.readFileSync('src/core/tools/web.js','utf8');
  assert.match(src,/stableMs: 'string optional 0–1500/);
  assert.match(src,/const stableMs=Math.min\(1500,Math.max\(0/);
  assert.match(src,/if\(firstPassingAt===null\)firstPassingAt=now/);
  assert.match(src,/if\(now-firstPassingAt>=stableMs\)break/);
  assert.match(src,/else firstPassingAt=null/);
  assert.match(src,/name:'stable_duration'/);
});
test('MAJIN progress uses a minimal animated thread that respects reduced motion',async()=>{
  const fs=await import('node:fs');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(html,/#composer #work-progress::after/);
  assert.match(html, /data-phase="stalled"/);
  assert.match(html, /data-phase="verified"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
});

test('MAJIN distinguishes a browser click from a verified outcome in UI',async()=>{
  const fs=await import('node:fs');
  const tools=fs.readFileSync('src/core/tools/web.js','utf8');
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(tools,/outcomeEvidence: proof\?\.ok \? 'postcondition' : 'action_only'/);
  assert.match(tools,/OUTCOME NOT VERIFIED: call browser\.verify/);
  assert.match(app,/Click sent · checking its effect/);
  assert.match(app,/if\(verified\)/);
  assert.match(app,/bar\.dataset\.phase='verified'/);
  assert.match(app,/bar\.dataset\.phase='action'/);
  assert.match(html,/#composer #work-progress\[data-phase="action"\]/);
});

test('failed verification chooses a bounded grounded recovery rather than replaying a click',()=>{
  const c=verificationCriteria({selector:'#submit'});
  const verdict={ok:false,failures:[{name:'element_unique',expected:true,actual:false}]};
  const plan=browserRecoveryAdvice(verdict,c,[
    {selector:'#save',label:'Save',type:'button'},
    {selector:'#pass',label:'password',type:'password'},
  ]);
  assert.equal(plan.action,'narrow_selector');
  assert.equal(plan.candidates.length,2);
  assert.ok(!JSON.stringify(plan).includes('input.value'));
});
test('verification failures choose distinct recovery strategies',()=>{
  const c=verificationCriteria({url:'/finished'});
  assert.equal(browserRecoveryAdvice({ok:false,failures:[{name:'url_contains'}]},c).action,'inspect_navigation');
  assert.equal(browserRecoveryAdvice({ok:false,failures:[{name:'stable_duration'}]},c).action,'wait_or_inspect');
  assert.equal(browserRecoveryAdvice({ok:false,failures:[{name:'element_enabled'}]},c).action,'resolve_prerequisites');
  assert.equal(browserRecoveryAdvice({ok:true},c).action,'none');
});
test('failed browser verification is visible via ONE inline MAJIN status',async()=>{
  const fs=await import('node:fs');
  const src=fs.readFileSync('src/core/tools/web.js','utf8');
  const app=fs.readFileSync('src/ui/app.js','utf8');
  const html=fs.readFileSync('src/ui/index.html','utf8');
  assert.match(src,/browserRecoveryAdvice\(verdict,criteria,controls\)/);
  assert.match(src,/recovery},meta:\{assertions:verdict.assertions/);
  assert.match(app,/ev.tool==='browser.verify' && !ev.ok/);
  assert.match(app,/bar\.dataset\.phase=navigation\?'navigation':'recovery'/);
  assert.match(html,/#composer #work-progress\[data-phase="recovery"\]/);
  assert.match(html,/prefers-reduced-motion:reduce/);
});

test('navigation recovery includes exact pathname and origin mismatches',()=>{
 const c=verificationCriteria({urlPath:'/dashboard',urlOrigin:'https://example.test'});
 const fail=verifyObserved(c,{valid:true,url:'https://evil.test/?next=/dashboard',title:'Redirect',
    pathMatch:false,originMatch:false});
 assert.equal(fail.ok,false);
 const recovery=browserRecoveryAdvice(fail,c);
 assert.equal(recovery.action,'inspect_navigation');
 assert.match(recovery.hint,/pathname/);
});
test('UI shows a lightweight navigation investigation state without another panel',async()=>{
 const fs=await import('node:fs');
 const app=fs.readFileSync('src/ui/app.js','utf8');
 const html=fs.readFileSync('src/ui/index.html','utf8');
 assert.match(app,/bar\.dataset\.phase=navigation\?'navigation':'recovery'/);
 assert.match(html,/work-progress\[data-phase="navigation"\]/);
});

test('verify an exact count of page cards without requiring a unique selector',()=>{
 const c=verificationCriteria({selector:'.search-result',count:'12'});
 assert.equal(c.ok,true);
 const yes=verifyObserved(c,{valid:true,matchCount:12,exists:true,unique:false,visible:false,url:'https://example.test',title:'Results'});
 assert.equal(yes.ok,true);
 assert.equal(yes.assertions.some(x=>x.name==='element_unique'),false);
 const no=verifyObserved(c,{valid:true,matchCount:11,exists:true,unique:false,visible:false,url:'https://example.test',title:'Results'});
 assert.equal(no.ok,false);
 assert.equal(no.failures[0].name,'element_count_exact');
});
test('count validation rejects invalid and conflicting expectations',()=>{
 for(const count of ['-1','1.5','NaN','1001','Infinity']){
   assert.equal(verificationCriteria({selector:'.row',count}).ok,false);
 }
 assert.equal(verificationCriteria({count:'3'}).ok,false);
 assert.equal(verificationCriteria({selector:'.row',count:'3',text:'hello'}).ok,false);
 assert.equal(verificationCriteria({selector:'.row',count:'0'}).ok,true);
});

test('count above 1000 cannot masquerade as exactly 1000',()=>{
 const c=verificationCriteria({selector:'.result',count:'1000'});
 const observed={valid:true,matchCount:1001,url:'https://example.test',title:'Results'};
 const verdict=verifyObserved(c,observed);
 assert.equal(verdict.ok,false);
 assert.equal(browserRecoveryAdvice(verdict,c).action,'inspect_result_count');
 const source=fs.readFileSync('src/core/browser-evidence.js','utf8');
 assert.match(source,/count > 1000 \? 1001 : count/);
});
test('visual result verification feedback stays within existing composer',()=>{
 const html=fs.readFileSync('src/ui/index.html','utf8');
 assert.match(html,/#composer #work-progress\[data-phase="verify"\] #work-progress-symbol/);
 assert.match(html,/majin-proof-breathe/);
 assert.match(html,/prefers-reduced-motion:reduce/);
});

test('strict criteria reject coerced counts and URL control characters',()=>{
 for(const count of [true,{},[],[1]]) assert.equal(verificationCriteria({selector:'.result',count}).ok,false);
 assert.equal(verificationCriteria({selector:'.result',count:1}).ok,true);
 for(const urlPath of ['/next\nstep','/next\tstep']) assert.equal(verificationCriteria({urlPath}).ok,false);
});
test('strict criteria do not accept toString object as boolean',()=>{
 const criteria=verificationCriteria({selector:'#send',present:{toString:()=> 'false'}});
 assert.equal(criteria.present,null);
 assert.equal(verificationCriteria({selector:'#send',present:false}).present,false);
});
