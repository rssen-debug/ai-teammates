import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexAppClient } from '../../src/v5/codex-app-client.js';
const output = path.resolve(process.argv[2]); fs.mkdirSync(output, { recursive: true });
const client = new CodexAppClient({ workspace: path.join(output, 'workspace'), stateDir: path.join(output, 'state') });
try {
  await client.start();
  const auth = await client.status(); await client.openConversation();
  const inventory = await client.request('mcpServerStatus/list', { threadId: client.threadId, serverName: 'majin', detail: 'toolsAndAuthOnly' });
  const call = await client.request('mcpServer/tool/call', { threadId: client.threadId, server: 'majin', tool: 'driver_status', arguments: { operationId: randomUUID() } });
  const report = { host: os.hostname(), ...auth, threadId: client.threadId,
    toolCount: Object.keys(inventory.data.find(s => s.name === 'majin').tools).length, call };
  if (process.argv.includes('--inference')) {
    fs.writeFileSync(path.join(client.workspace, 'source.txt'), 'Project Cedar launches 14 November 2026. Budget SEK 42000. Owner Test User.');
    const events = []; report.inferenceEvents = events;
    const completed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inference acceptance timed out')), 180000);
      client.on('event', event => {
        if (['item/started','item/completed','turn/completed'].includes(event.method)) events.push(event);
        if (event.method === 'turn/completed') { clearTimeout(timer); resolve(event.params.turn); }
      });
      client.on('request', request => {
        const params = request.params;
        // This acceptance run is authorized to read source.txt and write/read summary.txt only.
        // Do not approve arbitrary model requests or persist broader grants.
        const allowed = request.method === 'mcpServer/elicitation/request' && params.serverName === 'majin' &&
          params._meta?.codex_approval_kind === 'mcp_tool_call' &&
          /^Allow the majin MCP server to run tool "fs_(read|write)"\?$/.test(params.message) &&
          ['source.txt','summary.txt'].includes(params._meta.tool_params?.path);
        if (allowed) { client.reply(request.id, { action: 'accept', content: {} }); return; }
        events.push({ method: request.method, requiresUser: true });
        fs.writeFileSync(path.join(output, 'pending-client-request.json'), JSON.stringify(request, null, 2));
        clearTimeout(timer); reject(new Error(`Client request requires handling: ${request.method}`));
      });
    });
    await client.send('Local acceptance test: using only the majin MCP tools, read source.txt and write a concise accurate Swedish summary to summary.txt. Use a unique operationId for each tool action. Include the project name, date, budget and owner. Do not use shell or other providers. Verify by reading summary.txt back.');
    report.inferenceTurn = await completed;
    report.inferenceVerified = report.inferenceTurn.status === 'completed';
    report.summaryCorrect = fs.existsSync(path.join(client.workspace, 'summary.txt')) &&
      /Cedar/.test(fs.readFileSync(path.join(client.workspace, 'summary.txt'), 'utf8')) &&
      /42.?000/.test(fs.readFileSync(path.join(client.workspace, 'summary.txt'), 'utf8'));
  }
  fs.writeFileSync(path.join(output, 'app-server-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ connected: auth.connected, signedIn: auth.signedIn, toolCount: report.toolCount,
    inferenceVerified: report.inferenceVerified || false, summaryCorrect: report.summaryCorrect || false }));
} finally { await client.close(); }
