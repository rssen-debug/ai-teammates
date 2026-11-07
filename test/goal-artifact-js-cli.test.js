import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectRequestedArtifact, explicitTarget } from '../src/core/goal-artifact.js';
const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'majin-js-artifact-'));
const name='cli-agent-fixture.mjs';
const prompt='Actually create and save a working Node.js CLI agent module in '+name+
  '. Export function respond(message) that returns a helpful non-placeholder response containing the message. '+
  'When run with QA_PING, the CLI MUST print QA_PING, with a DIFFERENT argument print the other.';
test('the actual 58-byte placeholder from real Qwen benchmark cannot be marked completed',()=>{
  fs.writeFileSync(path.join(workspace,name),"function respond(message) { return 'Your response here'; }");
  const out=inspectRequestedArtifact(prompt,workspace);
  assert.equal(out.ok,false);
  for(const piece of ['exported respond','CLI output','argument handling','placeholder code']) {
    assert.ok(out.missing.some(m=>m.includes(piece)),'missing '+piece+': '+out.missing.join(','));
  }
});
test('a semantically structured CLI module meets the explicit static contract',()=>{
  const code="export function respond(message) { return 'You said: ' + message; }\nif (process.argv[1]) console.log(respond(process.argv[2] || ''));";
  fs.writeFileSync(path.join(workspace,name),code);
  const out=inspectRequestedArtifact(prompt,workspace);
  assert.equal(out.ok,true,out.reason);
});
test('CLI argument handling is checked independently of printed output',()=>{
  const code="export function respond(message) { return 'You said: ' + message; }\nconsole.log(respond('fixed reply'));";
  fs.writeFileSync(path.join(workspace,name),code);
  const out=inspectRequestedArtifact(prompt,workspace);
  assert.equal(out.ok,false);
  assert.ok(out.missing.some(m=>/argument handling/.test(m)));
});

test('Node.js runtime name must not become a second output target',()=>{
  assert.equal(explicitTarget(prompt,workspace)?.name,'cli-agent-fixture.mjs');
  assert.equal(explicitTarget('Create a file named node.js',workspace)?.name,'node.js');
});
