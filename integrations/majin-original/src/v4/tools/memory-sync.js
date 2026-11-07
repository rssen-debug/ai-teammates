import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {MemoryStore} from '../../v2/memory/store.js';
import {syncPair} from '../../core/memory-sync.js';
import {checkPath,isInside} from '../path-access.js';

/** Reuse the canonical V2 store and core sync entry point. No shadow fact store. */
export function createMemorySyncTool({memory,workspaceDir,folders=()=>[]}){
  return {
    name:'memory_sync',
    description:'Synchronize all canonical memory namespaces with another namespaced MAJIN memory directory in the workspace or an owner-granted folder. Preserves metadata and deletions; never converts V1 text memory implicitly. dryRun defaults true and writes no files. Actual sync exports private memory and always requires approval.',
    tier:'external',
    inputSchema:z.object({target:z.string().min(1).max(1000),dryRun:z.boolean().default(true)}),
    outputSchema:z.object({ok:z.literal(true),version:z.string(),dryRun:z.boolean(),provisionalIdentities:z.boolean(),aReceived:z.object({applied:z.number()}),bReceived:z.object({applied:z.number()}),factsNow:z.object({a:z.number(),b:z.number()}),stores:z.unknown(),atomicity:z.string(),conflictPolicy:z.string()}),
    execute:async({target,dryRun=true})=>{
      const checked=checkPath(target,{workspace:workspaceDir,folders:folders()});
      if(!checked.allowed||!checked.abs)throw Object.assign(Error('Memory target is outside the current folder grants'),{cls:'PERMISSION_DENIED'});
      // checkPath uses the native resolver (including Windows 8.3 expansion).
      // Use that same representation for the canonical source boundary.
      const local=fs.realpathSync.native?fs.realpathSync.native(memory.dir):fs.realpathSync(memory.dir),remote=checked.abs;
      if(isInside(remote,local)||isInside(local,remote))throw Object.assign(Error('Memory stores must be separate non-overlapping directories'),{cls:'PERMISSION_DENIED'});
      // No mkdir in constructor: BOTH stores must pass strict preflight first.
      const peer=new MemoryStore(path.resolve(remote),{maxEntriesPerNs:memory.maxEntriesPerNs,create:false});
      const report=syncPair(memory,peer,{dryRun});
      if(!report.ok)throw Object.assign(Error(report.error.message),{cls:'INVALID_TOOL_INPUT'});
      return report;
    },
  };
}
