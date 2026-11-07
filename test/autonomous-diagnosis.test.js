import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { superviseFailure, supervisorInstruction } from '../src/v4/autonomous-diagnosis.js';

test('browser failures trigger safe differential diagnosis instead of repeated open',()=>{
 const x=superviseFailure({tool:'browser_open',code:'TOOL_TIMEOUT',repeats:2,available:['tools_search','sys_ports','agent_delegate']});
 assert.equal(x.repairCode,true);
 assert.equal(x.avoidSameCall,true);
 assert.deepEqual(x.discoveryTools,['tools_search','sys_ports','agent_delegate']);
 const text=supervisorInstruction(x);
 assert.match(text,/host process and CDP port/);
 assert.match(text,/isolated fix branch and PR/);
 assert.match(text,/do NOT silently merge/);
 assert.doesNotMatch(text,/C:\\Users|email@|password=/);
});

test('ordinary document failure suggests an alternative extraction method',()=>{
 const x=superviseFailure({tool:'document_read',code:'UNKNOWN',repeats:0});
 assert.equal(x.repairCode,false);
 assert.match(supervisorInstruction(x),/different installed extraction engine/);
 assert.match(supervisorInstruction(x),/original document/);
});

test('MAJIN tool failures feed supervisor plan into same model loop without raw args',()=>{
 const source=fs.readFileSync(new URL('../src/v4/agent.js',import.meta.url),'utf8');
 assert.match(source,/failedToolCounts = new Map/);
 assert.match(source,/superviseFailure\(\{/);
 assert.match(source,/outcome\.supervisorGuidance = guidance/);
 assert.match(source,/supervisor: outcome\.supervisorGuidance \|\| ''/);
 assert.match(source,/action: 'diagnose_subsystem'/);
});
