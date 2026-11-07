/**
 * MAJIN — systemverktyg för Windows (och allt annat).
 * Inga native-moduler: PowerShell/.NET och CLI-verktyg räcker.
 */
import os from 'node:os';
import path from 'node:path';
import { def } from './registry.js';
import { runShell, IS_WIN } from './shell.js';

export const sysTools = [
  def({
    name: 'sys.info',
    group: 'system',
    risk: 'read',
    desc: 'Machine status: OS, architecture, CPU, memory, home dir, workspace, node version.',
    params: {},
    async run(_a, ctx) {
      const cpus = os.cpus();
      /* R5 (s25 real-world audit 2026-10-20): dynamic import() here crashed the
         PACKAGED exe (vm context without importModuleDynamically →
         ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING). os is already a static import —
         never re-import it dynamically. */
      const free = os.freemem();
      return {
        result: JSON.stringify(
          {
            platform: `${os.type()} ${os.release()}`,
            arch: os.arch(),
            hostname: os.hostname(),
            user: os.userInfo().username,
            uptime: `${(os.uptime() / 3600).toFixed(1)} h`,
            cpu: `${cpus[0]?.model?.trim() || '?'} × ${cpus.length}`,
            memoryGb: { total: +(os.totalmem() / 1e9).toFixed(2), free: +(free / 1e9).toFixed(2) },
            home: os.homedir(),
            workspace: ctx.cfg.get('workspace'),
            dataDir: path.dirname(ctx.cfg.file),
            node: process.version,
            shell: IS_WIN ? 'powershell' : 'bash/sh',
            paths: { downloads: path.join(os.homedir(), 'Downloads'), desktop: path.join(os.homedir(), 'Desktop'), appdata: process.env.APPDATA || path.join(os.homedir(), '.config') },
          },
          null,
          1,
        ),
        summary: `${os.type()} ${os.arch()} · ${cpus.length} cpu · ${os.userInfo().username}`,
      };
    },
  }),

  def({
    name: 'sys.ps',
    group: 'system',
    risk: 'read',
    desc: 'Process list (name, pid, memory, cpu). Filterable with a regex.',
    params: { filter: 'string: regex against process names (optional)', sortBy: 'string: mem | cpu | name. optional (default: mem) [mem|cpu|name]', limit: 'number: max lines (default: 40)' },
    async run({ filter, sortBy = 'mem', limit = 40 }) {
      const cmd = IS_WIN
        ? `Get-Process | Select-Object Name,Id,Responding,@{n='WS_MB';e={[math]::Round($_.WorkingSet64/1MB,1)}},@{n='CPU_s';e={if($_.CPU){[math]::Round($_.CPU,1)}else{0}}} | ConvertTo-Csv -NoTypeInformation`
        : "ps -eo pid,rss,pcpu,comm --sort=-rss | head -200";
      const r = await runShell(cmd, { timeoutSec: 25, maxChars: 200000 });
      const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
      let rows;
      if (IS_WIN) {
        rows = lines.slice(1).map(parseCsvRow).filter(Boolean).map((c) => ({ name: c[0], pid: Number(c[1]), responding: c[2] !== 'False', mb: Number(c[3]) || 0, cpu: Number(c[4]) || 0 }));
      } else {
        rows = lines.slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4).map((c) => ({ pid: Number(c[0]), mb: Math.round(Number(c[1]) / 1024), cpu: Number(c[2]), name: c.slice(3).join(' ') }));
      }
      if (filter) {
        const re = safeRe(filter);
        rows = rows.filter((x) => re?.test(x.name));
      }
      rows.sort((a, b) => (sortBy === 'cpu' ? b.cpu - a.cpu : sortBy === 'name' ? String(a.name).localeCompare(String(b.name)) : b.mb - a.mb));
      const top = rows.slice(0, limit);
      return {
        result: `${rows.length} processes (showing ${top.length}, sorted by ${sortBy}):\n${top.map((x) => `${String(x.pid).padStart(7)}  ${String(x.mb).padStart(7)}MB  ${String(x.cpu ?? '').padStart(7)}s  ${x.name}`).join('\n')}`,
        meta: { count: rows.length },
        summary: `${rows.length} processer`,
      };
    },
  }),

  def({
    name: 'sys.ports',
    group: 'system',
    risk: 'read',
    desc: 'Listening ports + pid. Use it to see what already runs (e.g. the MAJIN ui, frida, ollama).',
    params: { port: 'number: filter on one port (optional)' },
    async run({ port }) {
      const cmd = IS_WIN
        ? "Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort | ConvertTo-Csv -NoTypeInformation"
        : '(netstat -ltnp 2>/dev/null || ss -ltnp) | head -100';
      const r = await runShell(cmd, { timeoutSec: 25, maxChars: 120000 });
      let rows = [];
      if (IS_WIN) {
        rows = (r.stdout || '').split(/\r?\n/).slice(1).map(parseCsvRow).filter(Boolean).map((c) => ({ addr: c[0], port: Number(c[1]), pid: Number(c[2]) }));
      } else {
        for (const l of (r.stdout || '').split(/\r?\n/)) {
          const m = /(?:tcp6?|udp)[\s/]*\S+\s+\S+\s+([^\s:]+):(\d+)/.exec(l) || /:(\d+)\s/.exec(l);
          if (m) rows.push({ addr: m[1] || '*', port: Number(m[2] || m[1]), pid: Number((l.match(/\/(\d+)\s*$/) || [])[1] || 0) });
        }
        const seen = new Set();
        rows = rows.filter((x) => !seen.has(`${x.addr}:${x.port}`) && seen.add(`${x.addr}:${x.port}`));
      }
      if (port) rows = rows.filter((x) => x.port === Number(port));
      const text = rows.length ? rows.map((x) => `${String(x.addr).padEnd(16)}:${String(x.port).padEnd(6)} pid ${x.pid || '?'}`).join('\n') : 'no listening ports';
      return { result: `lyssnande portar (${rows.length}):\n${text}`, meta: { count: rows.length }, summary: `${rows.length} lyssnande portar` };
    },
  }),

  def({
    name: 'sys.fs_usage',
    group: 'system',
    risk: 'read',
    desc: 'Disks and free space. Handy before unpacking something big.',
    params: {},
    async run() {
      const cmd = IS_WIN ? 'Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free | ConvertTo-Csv -NoTypeInformation' : 'df -h | head -12';
      const r = await runShell(cmd, { timeoutSec: 25 });
      const rows = (r.stdout || '').split(/\r?\n/).filter(Boolean);
      const out = IS_WIN
        ? rows.slice(1).map(parseCsvRow).filter(Boolean).map((c) => `${c[0]}: ${gb(c[1])} used, ${gb(c[2])} free`).join('\n')
        : rows.join('\n');
      return { result: out || 'ingen data', summary: 'diskusage' };
    },
  }),

  def({
    name: 'sys.procs_top',
    group: 'system',
    risk: 'read',
    desc: 'Quick top-N by CPU/memory with the command line — used to spot suspicious processes.',
    params: { n: 'number: how many (default 8) (optional)' },
    async run({ n = 8 }) {
      const cmd = IS_WIN
        ? `Get-CimInstance Win32_Process | Sort-Object WorkingSetSize -Descending | Select-Object -First ${Number(n) || 8} ProcessId,Name,CommandLine,WorkingSetSize | ConvertTo-Csv -NoTypeInformation`
        : `ps -eo pid,rss,args --sort=-rss | head -${Number(n) || 8}`;
      const r = await runShell(cmd, { timeoutSec: 30, maxChars: 60000 });
      const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
      const body = IS_WIN
        ? lines.slice(1).map((l) => {
            const c = parseCsvRow(l);
            return `pid ${c[0]} ${(Number(c[3]) / 1e6).toFixed(0)}MB ${c[1]}\n    ${String(c[2]).slice(0, 200)}`;
          }).join('\n')
        : lines.join('\n');
      return { result: body || 'ingen data', summary: `top ${n} processer` };
    },
  }),

  def({
    name: 'sys.services',
    group: 'system',
    risk: 'read',
    desc: 'Services/processes that start automatically — persistence check (RE and plain debugging).',
    params: { filter: 'string: regex (optional)' },
    async run({ filter }) {
      const cmd = IS_WIN
        ? "Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User | ConvertTo-Csv -NoTypeInformation; '---RUN---'; Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue | ConvertTo-Csv -NoTypeInformation"
        : "systemctl list-unit-files --type=service --state=enabled --no-pager 2>/dev/null | head -60; ls ~/.config/autostart 2>/dev/null";
      const r = await runShell(cmd, { timeoutSec: 35, maxChars: 60000 });
      let text = (r.stdout || '').replace(/\r/g, '');
      if (filter) {
        const re = safeRe(filter);
        text = text.split('\n').filter((l) => re?.test(l)).join('\n') || 'no hits';
      }
      return { result: `autostart/persistence:\n${text.slice(0, 8000)}`, summary: 'persistence-poster listade' };
    },
  }),
];

function parseCsvRow(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else q = !q;
      continue;
    }
    if (c === ',' && !q) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.length > 1 ? out : null;
}

const safeRe = (s) => {
  try {
    return new RegExp(s, 'i');
  } catch {
    return null;
  }
};

const gb = (v) => `${(Number(v) / 1e9).toFixed(1)} GB`;
