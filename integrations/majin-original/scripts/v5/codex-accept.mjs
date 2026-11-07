import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/core/version.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), `majin-codex-accept-${randomUUID()}`));
fs.mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, [path.join(repo, 'bin/majin-codex-mcp.mjs'), '--workspace', output,
  '--state-dir', path.join(output, 'state'), '--desktop'], { stdio: ['pipe','pipe','pipe'], windowsHide: true });
child.stderr.on('data', b => process.stderr.write(b));
const pending = new Map(); let seq = 0;
readline.createInterface({ input: child.stdout }).on('line', line => {
  const msg = JSON.parse(line); const p = pending.get(msg.id);
  if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 65000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const runId = `MAJIN_CODEX_${randomUUID().replaceAll('-', '').toUpperCase()}`;
const report = { runId, host: os.hostname(), platform: process.platform, node: process.version,
  physicalWindowsVerified: false, protocolVerified: false, steps: [] };
let count = 0;
async function call(name, args = {}) {
  const response = await request('tools/call', { name, arguments: { ...args, operationId: `${runId}-${++count}` } });
  report.steps.push(response.structuredContent);
  for (const item of response.content || []) if (item.type === 'image') fs.writeFileSync(path.join(output, 'notepad.png'), Buffer.from(item.data, 'base64'));
  if (response.isError) throw new Error(`${name}: ${response.structuredContent?.blocker || response.content[0]?.text}`);
  return response.structuredContent;
}
try {
  report.initialize = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'majin-codex-accept', version: VERSION } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  report.tools = (await request('tools/list', {})).tools.map(t => t.name);
  await call('driver_status'); report.protocolVerified = true;
  await call('desktop_open_notepad');
  const windows = await call('control_list_windows');
  const target = windows.result.meta.windows.find(w => w.class === 'Notepad');
  if (!target) throw new Error('Notepad window not observed');
  const window = `hwnd:${target.hwnd}`;
  await call('control_type', { window, text: runId });
  const read = await call('control_read', { window });
  if (!read.result.result.includes(runId)) throw new Error('Readback does not contain unique task ID');
  await call('desktop_capture_window', { hwnd: target.hwnd, path: 'notepad.png' });
  report.physicalWindowsReadback = true;
  report.blocker = 'Codex must inspect notepad.png before marking physicalWindowsVerified.';
} catch (error) { report.blocker = error.message; process.exitCode = 1; }
finally {
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2));
  child.stdin.end();
  console.log(JSON.stringify({ output, runId, protocolVerified: report.protocolVerified, physicalWindowsReadback: report.physicalWindowsReadback || false, blocker: report.blocker }));
}
