import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexAppClient } from '../../src/v5/codex-app-client.js';

const output = path.resolve(process.argv[2]);
fs.mkdirSync(output, { recursive: true });
const workspace = path.join(output, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
const client = new CodexAppClient({ workspace, stateDir: path.join(output, 'state'), browser: true, processAccess: true });
const report = { host: os.hostname(), at: new Date().toISOString(), steps: [], results: {} };
const fixture = http.createServer((req, res) => {
  if (req.url === '/fixture.html') {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>MAJIN local acceptance</title><h1>Local test form</h1><label>Name <input id="name"></label><label>File <input id="file" type="file"></label><p id="proof"></p><script>file.onchange=()=>{proof.textContent="Selected file: "+file.files[0].name+" ("+file.files[0].size+" bytes)"}</script>');
  } else if (req.url === '/created.html') {
    res.setHeader('content-type', 'text/html'); res.end(fs.readFileSync(path.join(workspace, 'created.html')));
  } else { res.statusCode = 404; res.end('missing'); }
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
let sequence = 0;
async function call(tool, args = {}, operationId = `universal-${randomUUID()}-${++sequence}`) {
  const result = await client.request('mcpServer/tool/call', { threadId: client.threadId, server: 'majin', tool, arguments: { ...args, operationId } });
  report.steps.push(result.structuredContent);
  if (result.isError) throw new Error(`${tool}: ${result.structuredContent?.blocker}`);
  return result.structuredContent;
}
async function check(name, fn) {
  try { await fn(); report.results[name] = { passed: true }; }
  catch (error) { report.results[name] = { passed: false, error: error.message }; }
}
try {
  await client.start(); await client.openConversation();
  await check('A_document_read_and_summary', async () => {
    await call('fs_write', { path: 'test-document.txt', content: 'Project Cedar. Launch date: 14 November 2026. Budget: SEK 42000. Owner: Test User. Scope: local demonstration.' });
    const extracted = await call('documents_extract', { path: 'test-document.txt' });
    if (!JSON.stringify(extracted).includes('42000')) throw new Error('Document extraction mismatch');
    await call('fs_write', { path: 'summary.txt', content: 'Project Cedar is a local demonstration owned by Test User, launching 14 November 2026 with a budget of SEK 42000.' });
    const read = await call('fs_read', { path: 'summary.txt' });
    if (!JSON.stringify(read).includes('14 November 2026')) throw new Error('Summary readback mismatch');
  });
  await check('B_current_public_data_and_sources', async () => {
    const fetched = await call('web_fetch', { url: 'https://jobsearch.api.jobtechdev.se/search?q=python&limit=1', extract: 'json', maxChars: 5000 });
    await call('fs_write', { path: 'sources.json', content: JSON.stringify({ fetchedAt: new Date().toISOString(), source: fetched.result.meta.url, evidence: fetched.result.result }) });
  });
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  await check('C_visible_local_form_and_file_selection', async () => {
    await call('fs_write', { path: 'upload.txt', content: 'LOCAL ACCEPTANCE FILE' });
    await call('browser_open', { url: `${origin}/fixture.html`, headless: false });
    await call('browser_fill', { selector: '#name', value: 'MAJIN Test User' });
    await call('browser_upload', { selector: '#file', filePath: 'upload.txt' });
    const observation = await call('browser_inspect');
    if (!JSON.stringify(observation).includes('MAJIN Test User') || !JSON.stringify(observation).includes('Selected file: upload.txt')) throw new Error('Page did not confirm form values and selected file');
  });
  await check('D_create_and_inspect_page', async () => {
    await call('fs_write', { path: 'created.html', content: '<!doctype html><title>Created by Majin</title><h1>Verified local page</h1><p>Generated through MCP.</p>' });
    await call('browser_open', { url: `${origin}/created.html`, headless: false });
    if (!JSON.stringify(await call('browser_inspect')).includes('Verified local page')) throw new Error('Rendered page text missing');
  });
  await check('E_observe_failure_and_repair_code', async () => {
    await call('fs_write', { path: 'repair/calc.mjs', content: 'if (2 + 2 !== 5) process.exit(1);' });
    let observed = false;
    try { await call('shell_run', { command: 'node repair/calc.mjs' }); } catch { observed = true; }
    if (!observed) throw new Error('Intentional failure was not observed');
    await call('fs_patch', { path: 'repair/calc.mjs', edits: [{ find: '!== 5', replace: '!== 4' }] });
    await call('shell_run', { command: 'node repair/calc.mjs' });
  });
  await check('F_test_CV_and_five_current_jobs', async () => {
    const cv = 'Test User. Software developer. Python, SQL, JavaScript, Git and REST APIs. Stockholm.';
    await call('fs_write', { path: 'test-cv.txt', content: cv });
    await call('documents_extract', { path: 'test-cv.txt' });
    const found = await call('jobs_search', { query: 'python', limit: 5 });
    const jobs = found.result.result.jobs;
    if (jobs.length !== 5) throw new Error(`Only ${jobs.length} current jobs returned`);
    const matches = [];
    for (const job of jobs) {
      const match = await call('jobs_match', { cv, title: job.title, description: job.description, mustHave: job.mustHave, niceToHave: job.niceToHave });
      matches.push({ title: job.title, url: job.url, deadline: job.deadline, keywordEvidence: match.result.result });
    }
    await call('fs_write', { path: 'job-matches.json', content: JSON.stringify({ fetchedAt: new Date().toISOString(), matches }, null, 2) });
  });
  await call('browser_close');
} finally {
  await client.close(); fixture.close();
  fs.writeFileSync(path.join(output, 'universal-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, results: report.results }));
}
