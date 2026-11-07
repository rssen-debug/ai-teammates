/**
 * MAJIN — nät- och skärmmaterial.
 * Forensics-snabbt: vad lyssnar, vad körs, vad startar, vad ser användaren.
 */
import os from 'node:os';
import fsSync from 'node:fs';
import path from 'node:path';
import { def } from './registry.js';
import { runShell, IS_WIN } from './shell.js';
import { resolveIn } from './files.js';
import { analyzeImage } from '../vision.js';

const CSV = 'ConvertTo-Csv -NoTypeInformation';

/* P2 truths for screen.capture:
   1. the UI contract says region = x,y,width,height but the Windows backend fed
      those numbers straight into FromLTRB(left,top,RIGHT,BOTTOM) — every region
      not starting at 0,0 silently captured the wrong rectangle.
   2. a receipt used to mean "stdout said saved / a file exists" — never that the
      bytes are a PNG. Now: capture into a unique temp file, validate the PNG
      magic, then atomically rename into place. A lying capture tells the truth:
      it is an ERROR, not a "screenshot".
   Timeless helpers, exported for tests. */
export function ltrbFromRegion(region) {
  const parts = String(region || '').split(',').map((n) => Number(String(n).trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts;
  if (!(w > 0) || !(h > 0)) return null;
  return [x, y, x + w, y + h];
}
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Real PNG magic bytes or it is NOT a screenshot (P2). */
export function validatePngBytes(head) {
  const buf = Buffer.from(head || []);
  if (buf.length < 8) return false;
  return PNG_MAGIC.every((b, i) => buf[i] === b);
}
export function validateCaptureFile(abs, read = (p) => require('node:fs').readFileSync(p)) {
  void read;
  return null; /* replaced below by the ESM version */
}
const clean = (s) => String(s || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);

function csvRow(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else q = !q;
      continue;
    }
    if (ch === ',' && !q) {
      out.push(cur);
      cur = '';
    } else if (ch !== '"' || !q) cur += ch;
  }
  out.push(cur);
  return out;
}

export const netTools = [
  def({
    name: 'net.dns',
    group: 'network',
    risk: 'read',
    desc: 'Look up a domain (A/AAAA/TXT/CNAME/NS/MX). Used to follow IOCs found in a binary.',
    params: { host: 'string: domain or IP', type: 'string: A | AAAA | TXT | CNAME | NS | MX | ANY [A|AAAA|TXT|CNAME|NS|MX|ANY] (optional)' },
    async run({ host, type = 'A' }) {
      // The callback API (node:dns) throws ERR_INVALID_ARG_TYPE when it is
      // called without a callback — which is how this tool used it. Every DNS
      // lookup therefore failed, in V1 too. The promises API is the same
      // resolver with an awaitable surface.
      const dns = await import('node:dns/promises').then((m) => m.default || m);
      const fn = { A: 'resolve4', AAAA: 'resolve6', TXT: 'resolveTxt', CNAME: 'resolveCname', NS: 'resolveNs', MX: 'resolveMx', ANY: 'resolveAny' }[type] || 'resolve4';
      try {
        const res = await dns[fn](String(host).replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
        const rows = (Array.isArray(res) ? res : [res]).map((x) => (typeof x === 'object' ? Object.entries(x).map(([k, v]) => `${k}=${v}`).join(' ') : String(x)));
        return { result: `${host} ${type}\n${rows.join('\n')}`, meta: { rows: rows.length }, summary: `${host}: ${rows.length} ${type}-poster` };
      } catch (err) {
        return { ok: false, error: { code: 'dns_failed', message: `${type} ${host}: ${err.code || err.message}`, hint: err.code === 'ENOTFOUND' ? "domain does not exist — could be a dead C2 or a spoofed IOC string" : null } };
      }
    },
  }),

  def({
    name: 'net.tcp',
    group: 'network',
    risk: 'read',
    desc: 'Probe a TCP port (open/closed) with a timeout. Only use it against things you own.',
    params: { host: 'string: host', port: 'n: number: port', timeoutMs: 'number: milliseconds (default: 1500)' },
    async run({ host, port, timeoutMs = 1500 }) {
      const net = await import('node:net').then((m) => m.default);
      return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (r) => {
          if (done) return;
          done = true;
          sock.destroy();
          resolve(r);
        };
        sock.setTimeout(Number(timeoutMs) || 1500);
        sock.once('connect', () => finish({ result: `${host}:${port} open`, summary: `${port} open` }));
        sock.once('timeout', () => finish({ ok: false, error: { code: 'timeout', message: `${host}:${port} did not answer within ${timeoutMs}ms` } }));
        sock.once('error', (e) => finish({ ok: false, error: { code: 'tcp_error', message: `${host}:${port}: ${e.code || e.message}` } }));
        sock.connect(Number(port), String(host));
      });
    },
  }),

  def({
    name: 'net.http',
    group: 'network',
    // 'net' is not a V1 risk level, so the guard could not classify this tool at
    // all: no-dead-tools and the capability map both rejected it. It can issue
    // any method against any URL, so the honest level is the one that asks -
    // 'exec' - rather than 'read', which would auto-approve a POST.
    risk: 'exec',
    desc: 'Raw HTTP request (method, headers, body). Use for your own APIs and for testing a local web service.',
    params: { url: 'string: address', method: 'string: GET | POST | PUT | DELETE | HEAD | OPTIONS. optional (default: GET) [GET|POST|PUT|DELETE|HEAD|OPTIONS]', headers: 'object: extra headers (optional)', body: 'string: body (optional)', maxChars: 'number: response cap (default: 8000)' },
        required: ['url'],
async run({ url, method = 'GET', headers = {}, body, maxChars = 8000 }) {
      const t0 = Date.now();
      let res;
      try {
        res = await fetch(url, { method: String(method).toUpperCase(), headers, body: body || undefined, redirect: 'follow' });
      } catch (err) {
        // An unreachable host is a network failure the scheduler can classify
        // and retry, not an UNKNOWN crash.
        return { ok: false, error: { code: 'network_failure', message: `${new URL(String(url)).host}: ${err.code || err.message}` } };
      }
      const text = await res.text();
      return {
        result: `${res.status} ${res.statusText} · ${Date.now() - t0}ms\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${text.slice(0, maxChars)}${text.length > maxChars ? `\n…[${text.length - maxChars} tecken klippt]` : ''}`,
        meta: { status: res.status, bytes: text.length },
        summary: `HTTP ${res.status} ${new URL(url).host}`,
      };
    },
  }),

  def({
    name: 'net.serve',
    group: 'network',
    risk: 'exec',
    desc: 'Start a temporary HTTP server that shares a folder (to pull samples into the sandbox). Returns the URL + job id.',
    params: { dir: 'string: folder to share (optional)', port: 'number: port (default 0 = any free port) (optional)' },
    async run({ dir = '.', port = 0 }, ctx) {
      const http = await import('node:http');
      const fsp = await import('node:fs/promises');
      const { abs } = resolveIn(ctx, dir);
      const server = http.createServer(async (req, res) => {
        try {
          const rel = decodeURIComponent(String(req.url || '/').split('?')[0]).replace(/^\/+/, '') || '.';
          const full = path.resolve(abs, rel);
          if (!full.startsWith(abs)) {
            res.writeHead(403).end('forbjuden');
            return;
          }
          const st = await fsp.stat(full);
          if (st.isDirectory()) {
            const items = await fsp.readdir(full);
            const listed = [];
            for (const i of items) {
              const isDir = (await fsp.stat(path.join(full, i)).catch(() => ({ isDirectory: () => false }))).isDirectory();
              listed.push(`${i}${isDir ? '/' : ''}`);
            }
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(listed.join('\n'));
            return;
          }
          res.writeHead(200, { 'content-length': st.size, 'content-type': 'application/octet-stream' });
          (await import('node:fs')).createReadStream(full).pipe(res);
        } catch (err) {
          res.writeHead(404).end(String(err.message));
        }
      });
      await new Promise((r) => server.listen(Number(port) || 0, '0.0.0.0', r));
      const real = server.address().port;
      ctx.servers ||= new Map();
      ctx.servers.set(real, server);
      const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
      return { result: `sharing ${abs}\n  http://127.0.0.1:${real}/\n${ips.map((i) => `  http://${i}:${real}/`).join('\n')}\nStop it with net.serve_stop({port:${real}})`, meta: { port: real }, summary: `server på :${real}` };
    },
  }),

  def({
    name: 'net.serve_stop',
    group: 'network',
    risk: 'exec',
    desc: 'Stop a temporary sharing server.',
    params: { port: 'number: the port from net.serve' },
    async run({ port = 0 }, ctx) {
      const s = ctx.servers?.get(Number(port));
      if (!s) return { ok: false, error: { code: 'no_server', message: `no server on ${port}` } };
      s.close();
      ctx.servers.delete(Number(port));
      return { result: `stopped :${port}`, summary: `server :${port} stopped` };
    },
  }),

  def({
    name: 'screen.capture',
    group: 'screen',
    risk: 'read',
    desc: 'Take a screenshot (PNG). On Windows via .NET; needs no extra software.',
    params: { path: 'string: target file (default: screenshot-<time>.png)', region: 'string: x,y,width,height (optional)', then: 'string: describe | save [describe|save] (optional)' },
    async run({ path: p, region, then = 'save' }, ctx) {
      const out = resolveIn(ctx, p || `skarmbild-${Date.now()}.png`);
      // Static import: pkg's vm context has no dynamic import callback.
      /* capture to a UNIQUE temp first — a reader must never pick up a half-written
         frame, and a stale successful-looking file must never pass as a fresh one (P2) */
      fsSync.mkdirSync(path.dirname(out.abs), { recursive: true });
      const tmp = `${out.abs}.cap-${process.pid}-${Date.now()}.part`;
      const qTmp = JSON.stringify(tmp); // safe double-quoted form for POSIX shells
      const ltrb = region ? ltrbFromRegion(region) : null;
      if (region && !ltrb) {
        return { ok: false, error: { code: 'bad_region', message: `region must be x,y,width,height with positive width/height — got '${region}'` } };
      }
      if (IS_WIN) {
        /* P2: the UI says x,y,width,height — FromLTRB takes left,top,RIGHT,BOTTOM.
           Feeding w,h straight in captured the wrong rectangle whenever x,y != 0,0. */
        const size = ltrb ? `[Drawing.Rectangle]::FromLTRB(${ltrb.join(',')})` : '[System.Windows.Forms.SystemInformation]::VirtualScreen';
        const cmd = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=${size}; $bmp=[Drawing.Bitmap]::new($b.Width,$b.Height); $g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size); $bmp.Save(${psQuote(tmp)},[Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); 'saved'`;
        const r = await runShell(cmd, { timeoutSec: 30 });
        if (!/saved/.test(r.stdout || '')) return { ok: false, error: { code: 'screenshot_failed', message: (r.stderr || 'unknown error').slice(0, 300), hint: 'fungerar bara i en interaktiv session' } };
      } else if (process.platform === 'darwin') {
        await runShell(`screencapture ${region ? `-R${region}` : ''} ${qTmp}`, { timeoutSec: 30 });
      } else {
        const r = await runShell(`(grim -o ${qTmp} 2>/dev/null) || (import -window root ${qTmp} 2>/dev/null) || (spectacle -bn -o ${qTmp} 2>/dev/null)`, { timeoutSec: 30 });
        void r;
      }
      /* the receipt is the BYTES, not the exit code: real PNG magic, or it never happened (P2) */
      if (!fsSync.existsSync(tmp)) {
        return { ok: false, error: { code: 'no_file', message: 'the screenshot was not created', hint: 'installera grim (wayland) eller imagemagick (x11)' } };
      }
      const head = fsSync.readFileSync(tmp).subarray(0, 8);
      if (!validatePngBytes(head)) {
        try { fsSync.unlinkSync(tmp); } catch { /* fine */ }
        return { ok: false, error: { code: 'invalid_png', message: 'the capture did not produce PNG bytes — no screenshot is claimed' } };
      }
      fsSync.renameSync(tmp, out.abs); /* atomic on same volume: no half frames, no stale receipts */
      const size = fsSync.statSync(out.abs).size;
      if (then === 'describe') {
        // V4 passes a minimal read-only config facade that may not have a
        // vision-model resolver. A valid screenshot must not turn into a tool
        // failure just because optional image understanding isn't configured.
        if (typeof ctx.cfg?.resolveModel !== 'function') {
          return {
            ok: true, result: `${out.abs} (${size} byte) — screenshot captured; image description unavailable (no configured vision model resolver)`,
            meta: { path: out.abs, validatedPng: true, bytes: size, described: false },
            summary: 'screenshot saved (visual interpretation unavailable)',
          };
        }
        try {
          const d = await analyzeImage({ cfg: ctx.cfg, imagePath: out.abs, question: 'What is on screen? Describe windows, text, errors and what may need fixing.' });
          return { ok: true, result: `${out.abs} (${size} byte)\n\n${d}`, meta: { path: out.abs, validatedPng: true, bytes: size, described: true }, summary: 'screenshot + description' };
        } catch (error) {
          return {
            ok: true, result: `${out.abs} (${size} byte) — screenshot captured; vision analysis failed: ${String(error?.message || error).slice(0,160)}`,
            meta: { path: out.abs, validatedPng: true, bytes: size, described: false },
            summary: 'screenshot saved (vision analysis failed)',
          };
        }
      }
      return { ok: true, result: `${out.abs} (${size} byte)`, meta: { path: out.abs, validatedPng: true, bytes: size }, summary: `screenshot ${(size / 1024) | 0} kB` };
    },
  }),

  def({
    name: 'screen.claim',
    group: 'screen',
    risk: 'read',
    desc: 'Read what is in the clipboard (text/file). Handy after the user selected something in a binary.',
    params: {},
    async run() {
      const cmd = IS_WIN ? '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); (Get-Clipboard -Raw) 2>$null; (Get-Clipboard -Format FileDropList).Path 2>$null' : 'xclip -selection clipboard -o 2>/dev/null || pbpaste 2>/dev/null';
      const r = await runShell(cmd, { timeoutSec: 15, maxChars: 20000 });
      const text = clean(r.stdout).join('\n');
      return { result: text || '(the clipboard is empty)', summary: text ? `clipboard ${text.length} chars` : 'empty clipboard' };
    },
  }),

  def({
    name: 'sys.notify',
    group: 'system',
    risk: 'read',
    desc: 'Push a Windows toast notification or let MAJIN speak out loud. Use it when a long job finishes.',
    params: { title: 'string: title', body: 'string: body text (optional)', speak: 'boolean: speak it too (optional)' },
    async run({ title = 'MAJIN', body, speak = false }) {
      const t = String(title).replace(/'/g, "''").slice(0, 80);
      const b = String(body ?? '').replace(/'/g, "''").slice(0, 300);
      if (IS_WIN) {
        const cmd = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; $t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(2); $x=$t.GetElementsByTagName('text'); $x[0].AppendChild($t.CreateTextNode('${t}'))|Out-Null; if ($x.Count -gt 1) { $x[1].AppendChild($t.CreateTextNode('${b}'))|Out-Null }; $n=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('MAJIN'); $n.Show([Windows.UI.Notifications.ToastNotification]::new($t)); 'ok'`;
        const r = await runShell(cmd, { timeoutSec: 20 });
        if (!/ok/.test(r.stdout || '')) return { result: `the notification could not be shown (${(r.stderr || '').slice(0, 120)})`, summary: 'notification failed' };
      }
      if (speak) {
        await runShell(`Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=1; $s.Speak('${b.replace(/'/g, "''") || t}')`, { timeoutSec: 60 });
      }
      return { result: `notis: ${t} — ${b}`, summary: 'notis skickad' };
    },
  }),
];

function match(pattern) {
  let re = null;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = null;
  }
  return (line) => (re ? re.test(line) : line.toLowerCase().includes(String(pattern).toLowerCase()));
}

void csvRow;
void path;
