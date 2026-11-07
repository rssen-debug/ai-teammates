import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointForFailure, isResumeRequest, shouldResume, resumeGuidance } from '../src/v4/goal-supervisor.js';

test('supervisor saves original objective and argument shapes but never sensitive values',()=>{
 const c=checkpointForFailure({
  objective:'Sök jobbet hos Fellowmind',goalId:'goal_original',code:'MODEL_BUDGET',
  trace:[
   {name:'document_read',argsShape:'fileName',ok:true,verified:true},
   {name:'browser_form_fill',argsShape:'values',ok:false,cls:'value_reverted',secret:'PRIVATE_NUMBER'},
  ]
 });
 assert.equal(c.originalObjective,'Sök jobbet hos Fellowmind');
 assert.equal(c.verifiedSteps,1);
 assert.equal(c.steps.length,2);
 assert.equal(c.steps[1].failure,'value_reverted');
 assert.doesNotMatch(JSON.stringify(c),/PRIVATE_NUMBER|secret/);
 const note=resumeGuidance(c);
 assert.match(note,/Sök jobbet hos Fellowmind/);
 assert.match(note,/different grounded approach/i);
 assert.match(note,/browser_form_fill/);
 assert.doesNotMatch(note,/PRIVATE_NUMBER/);
});

test('only explicit short follow-up resumes a failed task',()=>{
 const c=checkpointForFailure({objective:'Prepare application',goalId:'a'});
 for(const text of ['fortsätt','lös det','kör igen','försök igen','continue','retry','fixa det']){
  assert.equal(isResumeRequest(text),true,text);
  assert.equal(shouldResume(text,c),true,text);
 }
 for(const text of ['Sök ett helt nytt jobb','hej','skapa en ny sida','']){
  assert.equal(shouldResume(text,c),false,text);
 }
 assert.equal(shouldResume('fortsätt',null),false);
});

test('supervisor trace is bounded, including very long tool names',()=>{
 const c=checkpointForFailure({objective:'x'.repeat(2000),trace:Array.from({length:100},()=>({name:'t'.repeat(300),argsShape:'a'.repeat(700),ok:false}))});
 assert.equal(c.originalObjective.length,500);
 assert.equal(c.steps.length,32);
 assert.equal(c.steps[0].tool.length,90);
 assert.equal(c.steps[0].args.length,180);
});

test('model tool failure has one automatic replan and keeps hard budgets', async()=>{
 const fs=await import('node:fs');
 const source=fs.readFileSync(new URL('../src/v4/agent.js',import.meta.url),'utf8');
 assert.match(source,/let automaticReplanUsed = false/);
 assert.match(source,/!automaticReplanUsed && !signal\?\.aborted/);
 assert.match(source,/automaticReplanUsed = true/);
 assert.match(source,/action: 'autonomous_replan'/);
 assert.match(source,/rounds < roundLimit \|\| maybeExtend\(\)/);
 assert.match(source,/conversation\.supervisorCheckpoint = checkpointForFailure/);
 assert.match(source,/conversation\.supervisorCheckpoint = null/);
 assert.match(source,/resumeGuidance\(resumedCheckpoint\)/);
});
