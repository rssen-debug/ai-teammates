// V4 lifecycle binding; cryptography, anchors and bundle format remain V2's.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {AuditChain,AuditBind,keygen,anchor,verifyAnchor} from '../v2/audit/index.js';
import {exportBundle,verifyBundle} from '../v2/audit/export.js';
import {KEY_DIR,PRIV_FILE} from '../v2/audit/anchor.js';

export function createV4Audit({root,workspace}){
  const dir=path.join(root,'audit'),chain=new AuditChain(dir),binding=new AuditBind(chain),seen=new Map();
  let impaired=false;
  function assertHealthy(){
    const result=chain.verify();
    let signed;try{signed=verifyAnchor(dir);}catch{signed={ok:false};}
    if(impaired||!result.ok||signed.ok===false||(fs.existsSync(chain.headFile)&&!fs.existsSync(chain.file))){
      const error=Object.assign(new Error('Audit integrity is impaired. Preserve and restore the audit store before further execution.'),{cls:'AUDIT_INTEGRITY',code:'AUDIT_INTEGRITY'});throw error;
    }
  }
  assertHealthy();
  // Rebuild receipt dedup from the actual verified chain; no parallel history.
  if(fs.existsSync(chain.file))for(const line of fs.readFileSync(chain.file,'utf8').trim().split('\n'))if(line){const e=JSON.parse(line);if(e.kind==='receipt')seen.set(e.payload.id,e.payload.hash);}
  function persistenceFailure(error){impaired=true;throw Object.assign(new Error('Audit persistence failed. Preserve the audit store; execution cannot be treated as fully audited.'),{code:'AUDIT_INTEGRITY',cls:'AUDIT_INTEGRITY',cause:error});}
  function guarded(fn){try{return fn();}catch(error){return persistenceFailure(error);}}
  function recordGoal(goal){
    return guarded(()=>{for(const receipt of goal.receipts||[])if(seen.get(receipt.id)!==receipt.hash){binding.recordReceipt(receipt);seen.set(receipt.id,receipt.hash);while(seen.size>10000)seen.delete(seen.keys().next().value);}});
  }
  function anchorConfigured(){if(fs.existsSync(path.join(dir,KEY_DIR,PRIV_FILE)))anchor(dir);}
  function recordTelemetry(row){return guarded(()=>{const entry=binding.recordTelemetryRow(row);if(row.event==='goal.finish')anchorConfigured();return entry;});}
  function recordEvent(type,payload){return guarded(()=>{const entry=binding.recordEvent(type,payload);if(['background.observed','push.delivery'].includes(type))anchorConfigured();return entry;});}
  function consent({conversationId,tool,approved}){return guarded(()=>binding.recordEvent('consent.resolved',{conversationId,tool,approved:Boolean(approved)},{actor:'owner'}));}
  function status(){
    const integrity=chain.verify();let signed;
    try{signed=verifyAnchor(dir);}catch{signed={ok:false,cls:'ANCHOR_UNREADABLE'};}
    return {ok:!impaired&&integrity.ok&&signed.ok!==false&&!(fs.existsSync(chain.headFile)&&!fs.existsSync(chain.file)),integrity,anchor:signed,identity:'local audit identity; not a production release signer',timestamp:'No external timestamp has been requested.'};
  }
  function checkpoint({initialize=false}={}){assertHealthy();if(initialize)keygen(dir);return anchor(dir);}
  function exportPublic(){
    assertHealthy();const out=path.resolve(workspace,'audit-export-'+crypto.randomUUID());
    if(path.dirname(out)!==path.resolve(workspace)||fs.existsSync(out))throw Error('Unsafe audit export destination');
    const exported=exportBundle(dir,out),verification=verifyBundle(out);return {...exported,verification};
  }
  return {assertHealthy,recordGoal,recordTelemetry,recordEvent,consent,status,checkpoint,exportPublic,persistenceFailure,dir};
}
