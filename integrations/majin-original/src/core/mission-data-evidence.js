/**
 * Verify cross-file data lineage for an explicit "ALL job IDs from JSON
 * to Markdown" mission. A model cannot replace source identifiers with
 * Job1/Job2 placeholders and claim the output is verified.
 * Unsupported/ambiguous formats return null, NOT a fictional PASS.
 */
import fs from 'node:fs';
import path from 'node:path';
const SOURCE = /(?<![\w./\\-])([\w.-]+\.json)\b/gi;
const TARGET = /(?<![\w./\\-])([\w.-]+\.md)\b/gi;

export function verifyJobIdLineage(goal, workspace) {
  const prompt = String(goal || '');
  const root = typeof workspace === 'string' ? path.resolve(workspace) : '';
  if (!root || !/\ball\s+(?:(?:three|two|four|five|\d+)\s+)?job\s+ids?\b/i.test(prompt)) return null;
  const sources = [...new Set([...prompt.matchAll(SOURCE)].map(m => m[1]))];
  const outputs = [...new Set([...prompt.matchAll(TARGET)].map(m => m[1]))];
  if (sources.length !== 1 || outputs.length !== 1) return null;
  const src = path.resolve(root, sources[0]), dst = path.resolve(root, outputs[0]);
  if (path.dirname(src) !== root || path.dirname(dst) !== root) return null;
  const base = { type: 'job_id_lineage', source: sources[0], output: outputs[0] };
  let data;
  try { data = JSON.parse(fs.readFileSync(src, 'utf8')); }
  catch { return { ...base, ok: false, missing: [], reason: 'source JSON missing or invalid' }; }
  const jobs = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : null;
  if (!jobs?.length || jobs.length > 100 || !jobs.every(j => typeof j?.id === 'string' && j.id.trim())) {
    return { ...base, ok: false, missing: [], reason: 'source has no valid job ID collection' };
  }
  const ids = [...new Set(jobs.map(j => j.id.trim()))];
  const titles = [...new Set(jobs.filter(j => typeof j.title === 'string' && j.title.trim()).map(j => j.title.trim()))];
  let output;
  try { output = fs.readFileSync(dst, 'utf8'); }
  catch { return { ...base, ok: false, missing: ids, reason: 'target Markdown is absent' }; }
  const hasWholeId = id => {
    const index = output.indexOf(id);
    if (index < 0) return false;
    const before = output[index - 1] || '', after = output[index + id.length] || '';
    return !/[\w-]/.test(before) && !/[\w-]/.test(after);
  };
  const missing = ids.filter(id => !hasWholeId(id));
  const missingTitles = titles.filter(title => !output.includes(title));
  const ok = missing.length === 0 && missingTitles.length === 0;
  return { ...base, ok, count: ids.length, missing, missingTitles,
    reason: ok ? 'all source IDs and titles independently found in output' :
      'source-identifier integrity failed: ' + missing.length + ' missing IDs, ' + missingTitles.length + ' missing titles' };
}


/**
 * Cross-turn proof for "choose the SECOND job and save its exact ID".
 * The earlier user message must name ONE JSON source in this same session.
 * Unsupported, cross-session and ambiguous requests are not auto-verified.
 */
export function verifyFollowupJobSelection(goal, messages, workspace) {
  const request = String(goal || '');
  const rank = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+job\b/i.exec(request);
  if (!rank || !/\b(?:exact\s+job\s+id|job\s+id)\b/i.test(request) ||
      !/\b(?:continue|earlier|previous|samma|tidigare|fortsätt)\b/i.test(request)) return null;
  const index = { first:0,second:1,third:2,fourth:3,fifth:4,'1st':0,'2nd':1,'3rd':2,'4th':3,'5th':4 }[rank[1].toLowerCase()];
  const targets = [...new Set([...request.matchAll(/(?<![\w./\\-])([\w.-]+\.txt)\b/gi)].map(m=>m[1]))];
  if (targets.length !== 1 || !Array.isArray(messages)) return null;
  const root = typeof workspace === 'string' ? path.resolve(workspace) : '';
  if (!root) return null;
  const history = messages.filter(m => m?.role === 'user' && String(m.content || '') !== request);
  const sources = [...new Set(history.flatMap(m => [...String(m.content || '').matchAll(SOURCE)].map(x=>x[1])))];
  if (sources.length !== 1) return null;
  const sourcePath = path.resolve(root,sources[0]), outPath = path.resolve(root,targets[0]);
  if (path.dirname(sourcePath) !== root || path.dirname(outPath) !== root) return null;
  const base = { type:'job_followup_selection', target:targets[0], workspaceRelative:targets[0], source:sources[0] };
  let source;
  try { source=JSON.parse(fs.readFileSync(sourcePath,'utf8')); } catch {
    return { ...base, ok:false,missing:['earlier job JSON source is unavailable'],reason:'original job JSON cannot be read' };
  }
  const jobs=Array.isArray(source)?source:Array.isArray(source?.jobs)?source.jobs:null;
  const id=jobs?.[index]?.id;
  if (typeof id!=='string'||!id.trim()) {
    return { ...base,ok:false,missing:['requested job position not found'],reason:'source job position is absent' };
  }
  let saved;
  try {saved=fs.readFileSync(outPath,'utf8');}catch {
    return { ...base,ok:false,missing:['selected job ID file is absent'],reason:'selected job ID file is absent' };
  }
  const ok=saved.trim()===id.trim();
  return { ...base,ok,missing:ok?[]:['expected exact job ID '+id+' from '+sources[0]+', not '+saved.trim().slice(0,80)],
    reason:ok?'exact job ID verified against prior source JSON':'selected job ID does not match prior source JSON' };
}


/**
 * One source JSON -> one named Markdown output is a single artifact goal.
 * Qwen can generate the correct contents but fs.write a model-invented
 * /tmp/shortlist.md instead of the user's workspace/shortlist.md.
 * Correct ONLY this explicit, unambiguous output write; never redirect
 * fs.read, requests with multiple targets, or any unrelated tool.
 */
export function pinJobShortlistWrite(goal, workspace, tool, args) {
  if (tool !== 'fs.write' || !args || typeof args.path !== 'string' || !args.path.trim()) return null;
  const lineage = verifyJobIdLineage(goal, workspace);
  if (!lineage?.source || !lineage?.output) return null;
  const root = path.resolve(workspace);
  const requestedPath = path.resolve(root, lineage.output);
  const attemptedPath = path.resolve(root, args.path);
  if (attemptedPath === requestedPath) return null;
  return {
    args: { ...args, path: lineage.output },
    originalPath: args.path,
    requestedPath: lineage.output,
    corrected: true,
    reason: 'explicit source JSON -> one output Markdown file: keep fs.write inside user workspace',
  };
}
