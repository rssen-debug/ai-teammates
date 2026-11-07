import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repairSimpleCommonJsEchoCliWrite, inspectRequestedArtifact } from '../src/core/goal-artifact.js';

const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'majin-commonjs-echo-'));
const name='my-agent-qa.mjs';
const goal='Actually create and save a working Node.js CLI agent module in '+name+'. Export function respond(message). A CLI entrypoint must read process.argv and echo any different runtime argument. No external dependencies.';
const failedSource="module.exports = {respond: (message) => {return message;}}\n"+
  "const args = process.argv.slice(2);\n"+
  "module.exports.entrypoint = () => {console.log(module.exports.respond(args.join(' ')))};\n";

test('repairs exact observed Qwen CommonJS-only .mjs echo without inventing new responder behavior',()=>{
  const outcome=repairSimpleCommonJsEchoCliWrite(goal,workspace,'fs.write',{path:name,content:failedSource});
  assert.equal(outcome?.corrected,true);
  assert.equal(outcome.args.path,name);
  assert.ok(outcome.args.content.includes('export function respond(message)'));
  assert.ok(outcome.args.content.includes('process.argv.slice(2).join(" ")'));
  assert.ok(!outcome.args.content.includes('module.exports'));
  const abs=path.join(workspace,name);
  fs.writeFileSync(abs,outcome.args.content);
  assert.equal(inspectRequestedArtifact(goal,workspace).ok,true,'static oracle must recognize a genuine joined runtime argument');
  const check=spawnSync(process.execPath,['--check',abs],{encoding:'utf8'});
  assert.equal(check.status,0,check.stderr);
  const first=spawnSync(process.execPath,[abs,'QA_PING_ONE'],{encoding:'utf8'});
  const second=spawnSync(process.execPath,[abs,'QA_OTHER_TWO'],{encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);
  assert.equal(second.status,0,second.stderr);
  assert.equal(first.stdout.trim(),'QA_PING_ONE');
  assert.equal(second.stdout.trim(),'QA_OTHER_TWO');
});

test('rejects arbitrary executable code or altered CommonJS functions rather than overwriting it',()=>{
  const variants=[
    failedSource+'\nconsole.log("extra side effect")',
    failedSource.replace('return message','return "hardcoded"'),
    failedSource.replace('process.argv.slice(2)','[ "fixed" ]'),
    failedSource.replace('console.log','eval'),
    'module.exports={respond:(message)=>message};',
    failedSource.replace("args.join(' ')", "args.join('|')"),
  ];
  for(const content of variants){
    assert.equal(repairSimpleCommonJsEchoCliWrite(goal,workspace,'fs.write',{path:name,content}),null);
  }
});

test('refuses ambiguous goals, other output types and wrong file paths',()=>{
  assert.equal(repairSimpleCommonJsEchoCliWrite(goal+' Also write other.mjs',workspace,'fs.write',{path:name,content:failedSource}),null);
  assert.equal(repairSimpleCommonJsEchoCliWrite(goal,workspace,'fs.write',{path:'other.mjs',content:failedSource}),null);
  assert.equal(repairSimpleCommonJsEchoCliWrite(goal,workspace,'fs.read',{path:name,content:failedSource}),null);
  assert.equal(repairSimpleCommonJsEchoCliWrite(goal.replace('No external dependencies.',''),workspace,'fs.write',{path:name,content:failedSource}),null);
});
