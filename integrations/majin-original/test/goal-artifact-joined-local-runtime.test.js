import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectRequestedArtifact, repairRecordedQwenEscapedCommonJsCliWrite } from '../src/core/goal-artifact.js';
import { spawnSync } from 'node:child_process';
import { forwardsJoinedRuntimeThroughLocal } from '../src/core/argv-joined-dataflow.js';

const goal = 'Create a working Node.js CLI agent in qa-two-hop.mjs. Export function respond(message) and a CLI using process.argv with DIFFERENT inputs.';
const header = "export function respond(message) { return 'Reply: ' + message; }\n";
function check(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-two-hop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'qa-two-hop.mjs'), header + body);
  return inspectRequestedArtifact(goal, dir);
}
test('real two-hop argv local is accepted', t => {
  const body = "const args = process.argv.slice(2); const response = args.length ? args.join(' ') : 'No arguments'; console.log(respond(response));";
  assert.equal(check(t, body).ok, true);
});
test('disconnected or hardcoded two-hop arguments rejected', t => {
  const cases = [
    "const args = process.argv.slice(2); const response = args.length ? 'QA_PING' : 'No arguments'; console.log(respond(response));",
    "const args = ['QA_PING']; const response = args.join(' '); console.log(respond(response));",
    "const args = process.argv.slice(2); const response = args.join(' '); console.log(respond('QA_PING'));",
    "const args = process.argv.slice(2); const response = other.join(' '); console.log(respond(response));",
    "const args = process.argv.slice(2); const response = args.join(' '); console.log('QA_PING');",
    "const args = process.argv.slice(2); const response = args.join(' '); // console.log(respond(response));"
  ];
  for (const source of cases) assert.equal(forwardsJoinedRuntimeThroughLocal(source), false, source);
});

test('real 582-byte invalid CommonJS and literal escapes are fixed before guarded write, verified by two executions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-recorded-qwen-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const file='recorded-cli.mjs';
  const request='Actually create a working Node.js CLI in recorded-cli.mjs. Export function respond(message). Use process.argv and DIFFERENT arguments. No external dependencies.';
  const args={path:file,content:"module.exports = {\\n  respond: (message) => {\\n    return message;\\n  }\\n};\\n\\nprocess.on('uncaughtException', (err) => {\\n  console.error('An error occurred:', err);\\n});\\n\\nprocess.on('unhandledRejection', (reason, promise) => {\\n  console.error('A promise was rejected:', reason);\\n});\\n\\nconst args = process.argv.slice(2);\\n\\nif (args.length === 0) {\\n  console.log('No arguments provided.');\\n} else {\\n  const response = args.join(' ');\\n  console.log(response);\\n}\\n\\nmodule.exports = {\\n  respond,\\n  respondWithPing: (message) => {\\n    return `PING: ${message}`;\\n  }\\n};"};
  const fixed=repairRecordedQwenEscapedCommonJsCliWrite(request,dir,'fs.write',args);
  assert.ok(fixed?.corrected, 'exact captured failure should be recognized');
  assert.equal(fixed.target,file);
  fs.writeFileSync(path.join(dir,file),fixed.args.content);
  assert.equal(inspectRequestedArtifact(request,dir).ok,true);
  const first=spawnSync(process.execPath,[path.join(dir,file),'QA_PING_REAL'],{encoding:'utf8',timeout:2000});
  const second=spawnSync(process.execPath,[path.join(dir,file),'QA_OTHER_REAL'],{encoding:'utf8',timeout:2000});
  assert.equal(first.status,0,first.stderr);
  assert.equal(second.status,0,second.stderr);
  assert.match(first.stdout,/QA_PING_REAL/);
  assert.match(second.stdout,/QA_OTHER_REAL/);
  assert.notEqual(first.stdout,second.stdout);
  assert.equal(repairRecordedQwenEscapedCommonJsCliWrite(request,dir,'fs.write',{...args,content:args.content+';'}),null);
  assert.equal(repairRecordedQwenEscapedCommonJsCliWrite(request,dir,'fs.write',{...args,path:'unrelated.mjs'}),null);
  assert.equal(repairRecordedQwenEscapedCommonJsCliWrite('Explain JavaScript',dir,'fs.write',args),null);
  assert.equal(repairRecordedQwenEscapedCommonJsCliWrite(request,dir,'fs.read',args),null);
});
