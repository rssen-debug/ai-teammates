import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {suggestBrowserRecovery} from '../src/core/browser-recovery-policy.js';

test('stale references require a fresh observation not a blind click',()=>{
 const h=suggestBrowserRecovery('browser.click',{code:'ref_stale'});
 assert.equal(h.next,'browser.elements');
 assert.equal(h.phase,'refresh_page');
 assert.match(h.message,/fresh interactive snapshot/);
});
test('unknown timeout outcome must be inspected before repeating a side effect',()=>{
 const h=suggestBrowserRecovery('browser.click',{code:'tool_timeout'});
 assert.equal(h.phase,'outcome_unknown');
 assert.equal(h.next,'browser.read');
 assert.match(h.message,/already have completed/);
});
test('a blocked control should cause inspection, not repeated clicks',()=>{
 const h=suggestBrowserRecovery('browser.click',{code:'click_blocked'});
 assert.equal(h.next,'browser.elements');
 assert.equal(h.phase,'inspect_blocker');
});
test('policy avoids changing non-browser tools and unknown error types',()=>{
 assert.equal(suggestBrowserRecovery('fs.write',{code:'tool_timeout'}),null);
 assert.equal(suggestBrowserRecovery('browser.click',{code:'other'}),null);
});
test('agent connects recovery guidance and subtle UI, no new overlays',()=>{
 const loop=fs.readFileSync('src/core/loop.js','utf8');
 const app=fs.readFileSync('src/ui/app.js','utf8');
 const html=fs.readFileSync('src/ui/index.html','utf8');
 assert.match(loop,/suggestBrowserRecovery\(r.name,r.out.error\)/);
 assert.match(loop,/type:'browser_recovery'/);
 assert.match(app,/ev.type === 'browser_recovery'/);
 assert.match(html,/#composer #work-progress\[data-phase="recover"\]/);
 assert.match(html,/prefers-reduced-motion:reduce/);
});

test('inherited prototype error codes never produce fabricated recovery advice',()=>{
 for(const code of ['__proto__','constructor','toString','valueOf']) assert.equal(suggestBrowserRecovery('browser.click',{code}),null);
});
