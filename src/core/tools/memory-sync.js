import path from 'node:path';
import { def } from './registry.js';
import { Memory } from '../memory.js';
import { syncPair, VERSION } from '../memory-sync.js';

export const memorySyncTools = [
  def({
    name: 'memory.sync',
    group: 'memory',
    risk: 'write',
    desc: 'W9 bidirectional memory sync between this MAJIN and another store dir (server MAJIN_HOME, shared drive, backup). Two-way delta exchange with tombstone-respect; dryRun measures without writing a byte.',
    params: {
      target: 'string: path to the OTHER memory dir (their data/memory or MAJIN_HOME memory dir) — required',
      dryRun: 'string: "true" = count what WOULD transfer, write nothing (optional, default "false")',
    },
    examples: ['memory.sync({target:"D:/shared/majin-memory", dryRun:"true"})'],
    async run({ target, dryRun }, ctx) {
      if (!target || !String(target).trim()) return { ok: false, error: { code: 'bad_input', message: 'memory.sync needs target=<other memory dir>' } };
      const tdir = path.resolve(String(target).trim());
      const local = ctx.memory;
      const remote = new Memory({ get: (k) => (k === 'memory.dir' ? tdir : local?.cfg?.get(k)) });
      const report = syncPair(local, remote, { dryRun: String(dryRun) === 'true' });
      if (!report.ok) return { ok: false, error: report.error };
      const moved = report.aReceived.applied + report.bReceived.applied;
      const text = [
        `memory-sync ${VERSION} ${report.dryRun ? '(DRY-RUN — nothing written)' : ''}`,
        `  local  ${report.stores.a.id} rev=${report.stores.a.rev} facts=${report.factsNow.a}`,
        `  remote ${report.stores.b.id} rev=${report.stores.b.rev} facts=${report.factsNow.b} (${tdir})`,
        `  received local:  applied=${report.aReceived.applied} dup=${report.aReceived.skippedDup} seen=${report.aReceived.skippedSeen} resurrected-echo=${report.aReceived.skippedResurrected} errors=${report.aReceived.errors.length}`,
        `  received remote: applied=${report.bReceived.applied} dup=${report.bReceived.skippedDup} seen=${report.bReceived.skippedSeen} resurrected-echo=${report.bReceived.skippedResurrected} errors=${report.bReceived.errors.length}`,
      ].join('\n');
      return { ok: true, result: text, meta: { version: VERSION, ...report }, summary: `memory sync: ${moved} fact(s) ${report.dryRun ? 'would move' : 'moved'}` };
    },
  }),
];
