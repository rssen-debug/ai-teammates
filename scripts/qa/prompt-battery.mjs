#!/usr/bin/env node
/**
 * MAJIN free-LLM random prompt battery.
 * REAL Agent.turn() + REAL Ollama inference + production registry.
 * No mocks, no user workspace, no paid endpoint, no real applications,
 * no wallet and no production token release.
 * PASS requires independent filesystem/HTTP/PNG evidence; model text is never proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const root = process.env.MAJIN_HOME;
const model = process.env.QA_MODEL || 'qwen2.5:0.5b';
const only = new Set((process.env.QA_ONLY || '').split(',').filter(Boolean));
if (process.env.MAJIN_QA_SANDBOX !== '1' || !root || !process.env.CI ||
    path.resolve(root) === path.resolve(os.homedir()) ||
    !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
  throw new Error('REFUSING TO RUN: CI + isolated MAJIN_HOME under OS temp + MAJIN_QA_SANDBOX=1 required');
}
const workspace = path.join(root, 'workspace');
const evidence = process.env.QA_EVID || path.join(root, 'qa-evidence');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const stamp = crypto.randomBytes(5).toString('hex');
const f = (name) => path.join(workspace, name);
const has = (name) => fs.existsSync(f(name));
const read = (name) => has(name) ? fs.readFileSync(f(name), 'utf8') : '';
const write = (name, body) => fs.writeFileSync(f(name), body);
const { createRuntime } = await import('../../src/core/runtime.js');
const { approvals } = await import('../../src/core/guard.js');
const rt = await createRuntime({ channels: false, scheduler: false });
const routes = Object.fromEntries(Object.keys(rt.cfg.get('models.routes') || {}).map(k => [k, 'ollama/' + model]));
for (const k of ['chat', 'tasks', 'tools', 'code', 'research', 'analysis', 'plan', 'router', 'summarize', 'final', 'aggregator']) routes[k] = 'ollama/' + model;
const patch = rt.cfg.patch({
  workspace,
  providers: { ollama: { kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', models: [model] } },
  models: { provider: 'ollama', routes },
  moa: { policy: 'off', enabled: false },
  agent: { maxSteps: 9, maxTokens: 850, temperature: 0.1, toolSubset: false, maxRepeatCalls: 3, maxTurnSec: 120 },
  guard: { mode: 'confirm' },
  tools: { allow: ['fs.read', 'fs.list', 'fs.write'] },
  budget: { mode: 'cap', monthlyUsd: 0, perTaskUsd: 0 },
  updates: { check: false },
}, { persist: false });
if (!patch.ok) throw new Error('Could not configure sandbox: ' + JSON.stringify(patch.errors));
const report = { schema: 'majin.prompt-battery.v1', sha: process.env.GITHUB_SHA || null,
  model: 'ollama/' + model, source: 'real Agent.turn using local Ollama, not mock',
  started: new Date().toISOString(), cases: [], summary: {} };
const allowedDeletes = new Set();
const allowedBrowserSessions = new Set();
let base = null;
let receiptId = 'QA_RECEIPT_' + stamp;
const receipts = [];
let sessionNow = '';
let approvalCount = 0;
const approvalPoll = setInterval(() => {
  for (const entry of approvals.list()) {
    let approve = false;
    const p = entry.args?.path || '';
    if (entry.tool === 'fs.delete' && allowedDeletes.has(path.resolve(workspace, String(p))) &&
        path.resolve(workspace, String(p)).startsWith(workspace + path.sep)) approve = true;
    if (['browser.open', 'browser.fill', 'browser.click'].includes(entry.tool) &&
        allowedBrowserSessions.has(entry.session)) {
      approve = entry.tool !== 'browser.open' || (base && entry.args?.url?.startsWith(base));
    }
    if (approve) approvalCount += 1;
    approvals.respond(entry.id, approve, approve ? 'QA isolated fixture-only approval' : 'QA refused out-of-scope action');
  }
}, 150);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/apply') {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const data = new URLSearchParams(body);
    if (data.get('job') === 'QA-JOB-' + stamp && data.get('consent') === 'yes') {
      receipts.push({ job: data.get('job'), receipt: receiptId });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body><h1>Submitted</h1><p>' + receiptId + '</p></body></html>');
    }
    res.writeHead(400); return res.end('Missing job id or consent checkbox');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>MAJIN QA only</title></head><body><h1>Local Job Portal</h1>' +
    '<p>This is a synthetic fixture, not a real job application.</p>' +
    '<form method="POST" action="/apply"><label>Job<input id="job" name="job" value="QA-JOB-' + stamp + '"></label>' +
    '<label><input type="checkbox" id="consent" name="consent" value="yes"> I agree</label>' +
    '<button id="submit" type="submit">Apply to fixture</button></form></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = 'http://127.0.0.1:' + server.address().port;
async function turn(text, session, names, timeoutMs = 125000) {
  const p = rt.cfg.patch({ tools: { allow: names } }, { persist: false });
  if (!p.ok) throw new Error('tools.allow rejected: ' + JSON.stringify(p.errors));
  const events = [];
  sessionNow = session;
  const stopTimer = setTimeout(() => rt.agent.stop(session), timeoutMs);
  const start = Date.now();
  try {
    const response = await rt.agent.turn({
      input: text, session, source: 'majin-real-qa',
      model: 'ollama/' + model,
      onEvent: e => events.push({ type: e.type, tool: e.tool || e.name || null,
        step: e.step || null, reason: e.reason || e.stopReason || null }),
    });
    return { ms: Date.now() - start, steps: response?.steps ?? null,
      incomplete: !!response?.incomplete, blocked: response?.blocked || null,
      error: response?.error || null, stopReason: response?.stopReason || null,
      tools: (response?.tools || response?.toolLog || []).map(t => t.name || t.tool || t),
      toolDetails: (response?.tools || response?.toolLog || []).map(t => ({
        name: t.name || t.tool || null,
        ok: t.ok ?? null,
        path: String(t.args?.path || t.args?.from || '').slice(0,220),
        summary: String(t.summary || '').slice(0,300),
        error: t.error || null,
      })),
      events: events.slice(-45), responsePreview: String(response?.text || '').slice(0, 300) };
  } finally {
    clearTimeout(stopTimer);
    sessionNow = '';
  }
}
async function caseRun(id, category, prompt, allowed, verify, opts = {}) {
  if (only.size && !only.has(id)) return;
  console.log('\nSTART ' + id + ' ' + category);
  let trace = null; let status = 'FAIL'; let reason = 'no verified artifact';
  try {
    trace = await turn(prompt, opts.session || ('qa-' + id + '-' + stamp), allowed, opts.timeoutMs || 125000);
    const check = await verify(trace);
    const pass = !!check?.ok && !trace.incomplete && !trace.blocked && !trace.error;
    status = pass ? 'PASS' : trace.blocked ? 'BLOCKED' : 'FAIL';
    reason = check?.reason || reason;
    if (trace.error) reason += '; agent error: ' + trace.error;
    if (trace.stopReason) reason += '; stop: ' + trace.stopReason;
    if (trace.incomplete) reason += '; incomplete';
  } catch (e) { reason = String(e?.stack || e).slice(0,500); }
  const record = { id, category, status, reason, trace, approvalsSoFar: approvalCount };
  report.cases.push(record);
  fs.writeFileSync(path.join(evidence, id + '.json'), JSON.stringify(record, null, 2));
  console.log('VERDICT ' + id + ' ' + status + ' ' + reason);
}
const fileName = 'note-' + stamp + '.txt', marker = 'QA_FILE_' + stamp;
await caseRun('01', 'create-file',
  'Actually use fs.write to create ' + fileName + ' containing EXACTLY ' + marker + '. Do not just say done.',
  ['fs.write','fs.read'], () => ({ ok: read(fileName).trim() === marker,
    reason: 'independent on-disk byte comparison' }));
await caseRun('02', 'edit-file',
  'Read ' + fileName + ', then modify it so its content is EXACTLY ' + marker + '_EDITED. Use fs.write.',
  ['fs.read','fs.write','fs.patch'], () => ({ ok: read(fileName).trim() === marker + '_EDITED',
    reason: 'independent on-disk edit check' }));
const deleteName = 'delete-only-this-' + stamp + '.txt';
write(deleteName, 'temporary QA file');
allowedDeletes.add(f(deleteName));
await caseRun('03', 'delete-file-with-approval',
  'Delete the test fixture file ' + deleteName + ' using fs.delete with permanent:true. Only this file. Wait for approval.',
  ['fs.list','fs.delete'], () => ({ ok: !has(deleteName),
    reason: 'file absent from fixture after protected deletion' }));
const siteName = 'site-' + stamp + '.html';
await caseRun('04', 'build-website',
  'Build a single-file HTML landing page in ' + siteName +
  ' with a heading, a styled CTA button, a responsive viewport meta tag and a CSS style element. Actually save the file.',
  ['fs.write','fs.read'], () => { const s = read(siteName);
    const checks = [['html',/<html/i],['heading',/<h[1-6]/i],['button',/<button/i],['style',/<style/i],['viewport',/viewport/i],
      ['button CSS rule or inline style',/(?:\bbutton(?:\.[\w-]+)?|\.cta|\.btn)\s*(?::[\w-]+)?\s*\{|<button\b[^>]*\bstyle\s*=/i]];
    const missing = checks.filter(([,re]) => !re.test(s)).map(([name]) => name);
    return { ok: missing.length === 0, reason: 'target_exists=' + has(siteName) +
      ', bytes=' + Buffer.byteLength(s) + ', missing=[' + missing.join(',') + ']' }; });
const agentName = 'my-agent-' + stamp + '.mjs';
await caseRun('05', 'build-ai-agent',
  'Actually create and save a working Node.js CLI agent module in ' + agentName +
  '. Export function respond(message) that returns a helpful non-placeholder response containing the message. ' +
  'Implement a real CLI entrypoint that reads process.argv.slice(2) at runtime and passes the actual received text to respond(message). ' +
  'When run as node ' + agentName + ' QA_PING, the CLI MUST print a response that includes QA_PING. ' +
  'When run again with a DIFFERENT argument, it MUST echo the newly received argument, not a hard-coded QA_PING example. ' +
  'Use ES module syntax: export function respond(message), NOT module.exports or require. ' +
  'Use actual source line breaks, NOT literal backslash-n separators. ' +
  'Use process.argv, not a fixed sample string. No external dependencies. Not just a placeholder or a function with no CLI.',
  ['fs.write','fs.read'], () => {
    const exists = has(agentName);
    const src = read(agentName);
    const parse = exists ? spawnSync(process.execPath, ['--check', f(agentName)], { encoding:'utf8',timeout:10000 }) : null;
    const exported = /export\s+(?:async\s+)?function\s+respond\s*\(|export\s+(?:const|let)\s+respond\b/.test(src);
    // Generated code executes in a read-only, unprivileged, NO-NETWORK
    // container with ONLY this temporary QA workspace mounted.
    const runCLI = marker => spawnSync('docker', ['run', '--rm', '--pull=never', '--network','none',
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=32','--memory=256m','--user=10001:10001',
      '-v',workspace+':/work:ro','-w','/work',
      'node:22-alpine','node','/work/'+agentName,marker],
      {encoding:'utf8',timeout:20000,maxBuffer:200000,env:{PATH:process.env.PATH || ''}});
    const first=exists && parse?.status===0 ? runCLI('QA_PING_'+stamp) : null;
    const second=first?.status===0 ? runCLI('QA_OTHER_'+stamp) : null;
    const out1=String(first?.stdout || '').trim(), out2=String(second?.stdout || '').trim();
    const ok=exists && parse?.status===0 && exported &&
      first?.status===0 && second?.status===0 && out1.includes('QA_PING_'+stamp) &&
      out2.includes('QA_OTHER_'+stamp) && out1!==out2;
    return { ok, reason: 'exists='+exists+', syntax='+String(parse?.status ?? 'missing')+
      ', exported='+exported+', sandboxCLI1='+String(first?.status ?? 'not-run')+
      ', sandboxCLI2='+String(second?.status ?? 'not-run')+
      ', output1='+out1.slice(0,80)+', output2='+out2.slice(0,80) };
  });
const jobIds = ['QA-IT-' + stamp, 'QA-SOC-' + stamp, 'QA-CLOUD-' + stamp];
write('jobs-' + stamp + '.json', JSON.stringify(jobIds.map((id,i)=>({id,title:['Local IT Technician','Junior SOC Analyst','Cloud Technician'][i],location:'Helsingborg',type:'synthetic QA fixture'})),null,2));
await caseRun('06', 'find-jobs',
  'Read jobs-' + stamp + '.json with fs.read. Create shortlist-' + stamp +
  '.md with all THREE job IDs, job titles and one reason for each. These are synthetic test jobs. Do not invent real vacancies.',
  ['fs.read','fs.write'], () => { const s = read('shortlist-' + stamp + '.md'); return {
    ok: jobIds.every(id=>s.includes(id)) && s.length > 100,
    reason: 'all three fixture job IDs independently found in saved shortlist' }; },
  { session: 'qa-jobs-' + stamp });
await caseRun('07', 'job-context-followup',
  'Continue the SAME job shortlist from earlier in this conversation. Take the SECOND job and create selected-' + stamp +
  '.txt containing its exact job ID. Do not ask me which jobs; you already read them.',
  ['fs.read','fs.write'], () => ({ ok: read('selected-' + stamp + '.txt').includes(jobIds[1]),
    reason: 'correct second job ID survived a multi-turn conversation' }),
  { session: 'qa-jobs-' + stamp });
const tokenName = 'ExampleToken-' + stamp + '.sol';
await caseRun('08', 'create-crypto-project-dry-run',
  'For a local QA demo ONLY, create ' + tokenName +
  ' containing a simple Solidity ERC-20-like demo contract called ExampleToken with totalSupply and transfer support. Write deployment-notes-' + stamp +
  '.md describing a testnet-only deployment, NO live chain, NO wallet keys and NO real funds. Save both files.',
  ['fs.write','fs.read'], () => { const s=read(tokenName), notes=read('deployment-notes-' + stamp + '.md'); return {
    ok: /contract\s+ExampleToken/.test(s) && /totalSupply/.test(s) && /transfer/.test(s) && /testnet/i.test(notes),
    reason: 'on-disk Solidity demo + explicit testnet deployment notes; NO live release' }; });
const shotSession = 'qa-browser-' + stamp;
allowedBrowserSessions.add(shotSession);
await caseRun('09', 'open-browser-and-save-image',
  'Open this local test page in your browser: ' + base +
  ' . Read the page and call browser.shot to save a screenshot. Do not describe an image without saving one.',
  ['browser.open','browser.read','browser.shot'], () => {
    const shots = path.join(workspace,'shots');
    const files = fs.existsSync(shots) ? fs.readdirSync(shots).filter(x => x.includes(shotSession) && x.endsWith('.png')) : [];
    const good = files.some(x => { const b=fs.readFileSync(path.join(shots,x)); return b.length > 500 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])); });
    return { ok: good, reason: 'actual PNG screenshot verified by file signature and size' };
  }, { session:shotSession });
const applySession = 'qa-apply-' + stamp;
allowedBrowserSessions.add(applySession);
await caseRun('10', 'submit-synthetic-job-form',
  'On this LOCAL QA job portal ONLY ' + base + ', use browser.open, browser.fill if needed, browser.click to tick the consent checkbox, and browser.click the Apply button. The job ID is QA-JOB-' + stamp +
  '. This is a fake job fixture, not a real employer. Actually submit it; do not invent a receipt.',
  ['browser.open','browser.read','browser.fill','browser.click'], () => ({
    ok: receipts.some(r => r.job === 'QA-JOB-' + stamp && r.receipt === receiptId),
    reason: 'independent local HTTP server received actual POST and issued ' + receiptId
  }), { session:applySession, timeoutMs:150000 });
await caseRun('11', 'real-public-web-research',
  'Use web.search to find the official Node.js documentation URL and save at least one actual URL to node-sources-' + stamp +
  '.md. Do not fabricate a search result.',
  ['web.search','fs.write'], () => ({
    ok: /https?:\/\/[^\s)]+/.test(read('node-sources-' + stamp + '.md')) &&
        /nodejs\.org|nodejs\.dev/.test(read('node-sources-' + stamp + '.md')),
    reason: 'public web search resulted in an independently saved official documentation URL'
  }));
clearInterval(approvalPoll);
// Close every browser session BEFORE the HTTP fixture, otherwise chromium's
// persistent socket can hold server.close open and the final verdict is lost.
const { closeFor } = await import('../../src/core/browser.js');
const { closeQaFixture } = await import('./fixture-teardown.mjs');
report.cleanup = await closeQaFixture({
  browserSessions: [...allowedBrowserSessions],
  closeBrowser: closeFor,
  server,
  runtime: rt,
});
report.finished = new Date().toISOString();
for (const status of ['PASS','FAIL','BLOCKED','NOT_TESTED']) report.summary[status] = report.cases.filter(c=>c.status===status).length;
report.summary.total = report.cases.length;
fs.writeFileSync(path.join(evidence,'prompt-battery.json'), JSON.stringify(report,null,2));
console.log('FINAL ' + JSON.stringify(report.summary));
console.log('CLEANUP ' + JSON.stringify(report.cleanup));
const code = report.summary.FAIL || report.summary.BLOCKED || !report.cleanup.ok ? 1 : 0;
// This process is a one-shot, isolated CI fixture. Persist verdicts before
// exiting, even if Chromium/Ollama left auxiliary handles running.
await new Promise(resolve => process.stdout.write('QA_EXIT ' + code + '\\n', resolve));
process.exit(code);
