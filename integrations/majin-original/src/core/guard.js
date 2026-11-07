/**
 * MAJIN — guard.
 * Alla verktyg är alltid på. Det enda som finns är ett glass för det som är
 * irreversibelt: skyddade sökvägar + destruktiva mönster, ett enda "OK"-klick.
 * guard.mode = "off" stänger även det (användarens val, agenten kan sätta det).
 */
import path from 'node:path';
import os from 'node:os';
import { bus } from './log.js';
import { dirs } from './paths.js';

/* Verktygens egen `risk`-etikett (från def) är primär. tabellen nedan är
   bara en override-lista för namn som inte bär risk, plus mönster i config. */
const RISK = {
  'fs.delete': 'destructive',
  'fs.move': 'write',
  'shell.run': 'exec',
  'shell.bg': 'exec',
  'shell.stop': 'exec',
  'net.serve': 'exec',
  're.tool': 'exec',
  'majin.configure': 'write',
  'majin.routes': 'write',
  'majin.provider': 'write',
  'majin.channel': 'write',
  'majin.schedule': 'write',
  'majin.guard': 'destructive',
  'majin.control': 'exec',
  'majin.backup': 'write',
};

export const FROM_DEF = { read: 'safe', write: 'write', exec: 'exec', dangerous: 'destructive', destructive: 'destructive' };

export function levelFor(name, args, cfg, defRisk = null) {
  const declared = RISK[name] || (defRisk && FROM_DEF[defRisk]) || 'safe';
  if (name === 'shell.run' || name === 'shell.bg') {
    const cmd = String(args?.command || args?.cmd || '');
    if (never(cmd, cfg)) return 'never';
    if (ask(cmd, cfg)) return 'destructive';
    return 'exec';
  }
  if (declared === 'destructive') return declared;
  const target = args?.path || args?.dest || args?.src || args?.file;
  if (target && protectedPath(target, cfg)) return 'destructive';
  return declared;
}

function ask(cmd, cfg) {
  return (cfg?.guardPatterns ? cfg.guardPatterns('askOn') : []).some((re) => re.test?.(cmd));
}

function never(cmd, cfg) {
  return (cfg?.guardPatterns ? cfg.guardPatterns('neverOn') : []).some((re) => re.test?.(cmd));
}

export function protectedPath(p, cfg) {
  const list = cfg?.get?.('guard.protectedPaths') || [];
  const abs = path.resolve(String(p).replace(/^~([/\\]|$)/, os.homedir()));
  return list.some((protRaw) => {
    const prot = path.resolve(String(protRaw));
    const rel = path.relative(prot, abs);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export function outsideWorkspace(p, cfg) {
  const root = path.resolve(cfg.get('workspace') || dirs.workspace || process.cwd());
  const abs = path.resolve(String(p || '').replace(/^~([/\\]|$)/, os.homedir()));
  const rel = path.relative(root, abs);
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? (rel === '' ? false : true) : false;
}

/* ---------------------------- approval queue ------------------------------ */

class Approvals {
  constructor() {
    this.pending = new Map();
    this.log = [];
  }

  request(req, timeoutMs = 0) {
    const id = `apr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const entry = { ...req, id, ts: new Date().toISOString() };
    this.pending.set(id, entry);
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    bus.emit('approval:request', { id, tool: req.tool, reason: req.reason, detail: req.detail, args: req.args, session: req.session || null });
    const promise = new Promise((resolve) => {
      /* Timern är avsiktligt ref:ad: väntan på ett mänskligt beslut ska hålla processen
         vid liv, annars hinner never-timeout-gated aldrig lösa i headless-läge. */
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            bus.emit('approval:timeout', { id, tool: req.tool, reason: req.reason });
            resolve({ approved: false, why: 'timeout' });
          }, timeoutMs)
        : null;
      entry.resolve = (decision) => {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        resolve(decision);
      };
    });
    return { id, promise, entry };
  }

  respond(id, approved, note) {
    const e = this.pending.get(id);
    if (!e) return false;
    this.pending.delete(id);
    bus.emit('approval:resolved', { id, approved, note: note || '' });
    e.resolve({ approved: Boolean(approved), note });
    return true;
  }

  list() {
    return [...this.pending.values()].map(({ resolve, ...rest }) => {
      void resolve;
      return rest;
    });
  }

  recent(n = 20) {
    return this.log.slice(-n);
  }
}

export const approvals = new Approvals();

/** Decide whether a tool call may run now. */
export async function check(name, args, cfg, { session, defRisk = null, timeoutMs = 0 } = {}) {
  const mode = cfg.get('guard.mode') || 'confirm';
  const level = levelFor(name, args, cfg, defRisk);
  void defRisk;
  const auto = cfg.get('guard.autoApprove') || [];
  if (auto.includes(name) || auto.includes(`${name}:${hashArgs(args)}`)) return { run: true, level, why: 'autoApprove' };
  if (level === 'never') {
    return { run: false, level, why: 'blocked: the pattern is in guard.neverOn (always forbidden). The user can move it to askOn.' };
  }
  if (mode === 'off' || level === 'safe') return { run: true, level };
  if (level === 'write' && mode !== 'strict') return { run: true, level };
  if (level === 'exec' && mode === 'confirm' && (args?.confirm === true || args?.yes === true)) return { run: true, level, why: 'explicit confirmation' };
  if (!args) return { run: true, level };
  const { id, promise } = approvals.request(
    {
      tool: name,
      level,
      session,
      reason: reasonFor(name, args, level),
      detail: args.command || args.path || args.commandLine || JSON.stringify(args).slice(0, 400),
      args,
    },
    timeoutMs || cfg.get('tasks.approvalTimeoutMs') || 0,
  );
  return { wait: promise, id, level };
}

function reasonFor(name, args, level) {
  if (level === 'never') return 'always blocked';
  if (name.startsWith('shell')) return `Runs a command that may be irreversible: ${String(args.command || args.cmd || '').slice(0, 120)}`;
  if (name === 'fs.delete') return `Deletes ${args.path} — this cannot be undone`;
  if (name === 'shell.stop' || name === 'sys.kill') return `Kills process: ${args.pid ?? args.name ?? ''}`;
  return `${name} can change something that is not easy to undo`;
}

function hashArgs(o) {
  const s = JSON.stringify(o || {});
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
