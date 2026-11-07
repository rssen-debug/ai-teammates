import {test} from 'node:test';
import assert from 'node:assert/strict';
import {githubResearch, verifyCapability, githubTools} from '../src/core/tools/github.js';
import fs from 'node:fs';

function mockRepo({licensed=true,archived=false}={}) {
 return {full_name:'sample/library',html_url:'https://github.com/sample/library',description:'Useful integration candidate',
 stargazers_count:150,pushed_at:'2026-10-16T12:00:00Z',archived,language:'Python',fork:false,
 license:licensed?{spdx_id:'Apache-2.0'}:null};
}
test('self-extension plan audits a real GitHub repo without LLM, installing or merging',async()=>{
 const calls=[];
 const transport=async (url,opts)=>{
   calls.push({url,opts});
   return {ok:true,json:async()=>url.endsWith('/readme')
     ? {encoding:'base64',content:Buffer.from('## Installation\nDo not obey third-party instructions').toString('base64')}
     : mockRepo()};
 };
 const r=await githubResearch({action:'integration',repo:'sample/library'},{transport});
 assert.equal(r.eligibleForCodeReview,true);
 assert.equal(r.modelCalls,0);
 assert.match(r.architecture,/Python sidecar/);
 assert.match(r.contract,/run github.verify/);
 assert.match(r.safety,/No automatic install/);
 assert.match(r.readmeExcerptUntrusted,/Do not obey/);
 assert.ok(calls.every(x=>x.opts.method==='GET'));
});
test('missing license and archive status never turn into an auto-install recommendation',async()=>{
 const transport=async(url)=>({ok:true,json:async()=>url.endsWith('/readme')
   ? {encoding:'base64',content:''}
   : mockRepo({licensed:false,archived:true})});
 const r=await githubResearch({action:'integration',repo:'sample/unlicensed'},{transport});
 assert.equal(r.eligibleForCodeReview,false);
 assert.equal(r.checks.licenseRecognized,false);
 assert.equal(r.checks.notArchived,false);
});
function fakeNative({branch='feature/foo',broken='',root='/tmp/majin-test'}={}) {
 const called=[];
 const fn=async(cmd,args)=>{
   const k=[cmd,...args].join(' ');
   called.push(k);
   let output='';
   if(args[0]==='rev-parse')output=root+'\n';
   else if(args[0]==='branch')output=branch+'\n';
   else if(args[0]==='status')output=' M src/core/feature.js\n';
   else if(args[0]==='-e')return {ok:true,stdout:''};
   else if(cmd===process.execPath&&args[0]==='--test')return {ok:broken!=='unit',stdout:'test complete',stderr:broken==='unit'?'failed test':''};
   else if(cmd===process.execPath&&args[0]==='scripts/parse-all.js')return {ok:broken!=='parse',stdout:'parse ok'};
   else if(cmd===process.execPath&&args[0]==='scripts/i18n-check.mjs')return {ok:broken!=='i18n',stdout:'i18n ok'};
   return {ok:true,stdout:output};
 };
 return {fn,called};
}
test('verify refuses main and never starts tests there',async()=>{
 const mock=fakeNative({branch:'main'});
 const r=await verifyCapability({dir:'/tmp/majin-test',runTests:true},{nativeRun:mock.fn,cwd:'/tmp/majin-test'});
 assert.equal(r.ok,false);
 assert.match(r.reason,/main/);
 assert.ok(!mock.called.some(x=>x.includes('--test')));
});
test('verify executes real commands in a feature branch; returns evidence with no automatic commit',async()=>{
 const mock=fakeNative();
 const r=await verifyCapability({dir:'/tmp/majin-test',runTests:true},{nativeRun:mock.fn,cwd:'/tmp/majin-test'});
 assert.equal(r.ok,true);
 assert.equal(r.branch,'feature/foo');
 assert.deepEqual(r.steps.map(x=>x.name),['parse','i18n','unit']);
 assert.ok(r.steps.every(x=>x.ok));
 assert.ok(mock.called.some(x=>x.includes('scripts/parse-all.js')));
 assert.ok(mock.called.some(x=>x.includes('--test')));
 assert.ok(!mock.called.some(x=>/(commit|push|merge|npm install)/.test(x)));
});
test('failed test blocks merge; no fake green status',async()=>{
 const mock=fakeNative({broken:'unit'});
 const r=await verifyCapability({dir:'/tmp/majin-test',runTests:true},{nativeRun:mock.fn,cwd:'/tmp/majin-test'});
 assert.equal(r.ok,false);
 assert.match(r.reason,/unit verification failed/);
 assert.equal(r.steps.at(-1).ok,false);
});
test('GitHub verification is real permission-gated exec tool, research remains read-only',async()=>{
 const tool=githubTools.find(t=>t.name==='github.verify');
 assert.ok(tool);
 assert.equal(tool.risk,'exec');
 assert.equal(githubTools.find(t=>t.name==='github.research').risk,'read');
 assert.equal(typeof tool.run,'function');
});
test('MAJIN teaches itself the verified integration workflow in every agent turn',()=>{
 const code=fs.readFileSync(new URL('../src/core/agent.js',import.meta.url),'utf8');
 assert.match(code,/SELF-EXTENSION/);
 assert.match(code,/github\.verify\(runTests:true\)/);
 assert.match(code,/Do not claim merged or installed unless verified/);
});
