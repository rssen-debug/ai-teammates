import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAppClient } from './codex-app-client.js';
import { checkedPath } from './codex-tools.js';

// Dedicated CODEX DRIVER backend. It never constructs GrandArchitect/ProviderManager.
export function createCodexHost(options, { client = new CodexAppClient(options) } = {}) {
  const streams = new Set();
  let sequence = 0; const events = [];
  const publish = (type, payload) => {
    const event = { id: ++sequence, type, payload };
    events.push(event); if (events.length > 500) events.shift();
    for (const res of streams) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  client.on('event', value => publish('event', value));
  client.on('request', value => publish('request', value));
  client.on('disconnected', value => publish('disconnected', value));
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('application/json required');
    let size = 0; const chunks = [];
    for await (const part of req) { size += part.length; if (size > 8 * 1024 * 1024) throw new Error('Request exceeds 8 MB'); chunks.push(part); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: 'Local same-origin access required' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && options.uiDir && !url.pathname.startsWith('/api/')) {
        const base = path.resolve(options.uiDir);
        const target = checkedPath(base, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(res, 404, { error: 'Asset not found' });
        const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
        fs.createReadStream(target).pipe(res); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/codex/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const since = Number(req.headers['last-event-id'] || 0);
        for (const event of events.filter(e => e.id > since)) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        streams.add(res); req.on('close', () => streams.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/codex/status') return json(res, 200, await client.status());
      if (req.method !== 'POST') return json(res, 404, { error: 'Unknown route' });
      const data = await body(req); let result;
      if (url.pathname === '/api/codex/login') result = await client.login();
      else if (url.pathname === '/api/codex/message') {
        const files = (data.attachments || []).map(p => checkedPath(client.workspace, p));
        result = await client.send(String(data.text || '') + (files.length ? `\nAttached workspace files (read with Majin tools):\n${files.join('\n')}` : ''));
      } else if (url.pathname === '/api/codex/steer') result = await client.steer(String(data.text || ''));
      else if (url.pathname === '/api/codex/interrupt') result = await client.interrupt();
      else if (url.pathname === '/api/codex/reply') { client.reply(data.id, data.result); result = { replied: true }; }
      else if (url.pathname === '/api/codex/attachment') {
        if (typeof data.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) throw new Error('Valid base64 required');
        const filename = `${randomUUID()}-${path.basename(String(data.name || 'attachment')).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const target = checkedPath(client.workspace, `attachments/${filename}`);
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(data.base64, 'base64'), { flag: 'wx' });
        result = { path: target, bytes: fs.statSync(target).size };
      } else return json(res, 404, { error: 'Unknown route' });
      json(res, 200, result);
    } catch (error) { json(res, 400, { error: error.message }); }
  });
  return { client, server,
    async start() { await client.start(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); }); return { url: `http://127.0.0.1:${server.address().port}` }; },
    async stop() { for (const stream of streams) stream.end(); await client.close(); await new Promise(resolve => server.close(resolve)); },
  };
}
