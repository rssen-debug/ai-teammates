import path from 'node:path';
import { def } from './registry.js';
import { LessonStore, renderStats, VERSION } from '../learn.js';
import { resolveData, dirs } from '../paths.js';

const storeFor = (ctx) => new LessonStore(resolveData(ctx.cfg?.get('learn.dir') || 'learn', path.join(dirs.memory, 'learn')));

export const learnTools = [
  def({
    name: 'ma.learn',
    group: 'ma',
    risk: 'write',
    desc: 'W10 learning-loop: record a MEASURED failure as a durable lesson. Same trigger re-recorded AFTER it was verified = the proof did not hold → lesson auto-DEMOTED (honest, loud). Verify later with ma.verify_lesson against concrete proof.',
    params: {
      trigger: 'string: concrete description of the failure (≥8 chars) — required',
      lesson: 'string: what MAJIN should do differently — optional-but-expected',
      fix: 'string: what was changed this time — optional-but-expected',
      source: 'string: where the failure was observed (optional)',
    },
    examples: ['ma.learn({trigger:"browser.click clicked the WRONG node after DOM rerender", lesson:"always refresh refs first", fix:"browser.click now fails ref_stale honestly"})'],
    async run({ trigger, lesson, fix, source }, ctx) {
      const store = storeFor(ctx);
      const r = store.record({ trigger, lesson, fix, source });
      if (!r.ok) return r;
      const text = `lesson ${r.record.id} ${r.occasion === 'new' ? 'recorded (UNVERIFIED — call ma.verify_lesson with real proof when measured)' : r.occasion === 'regression' ? `RE-OCCURRED → demoted: ${r.honest}` : `re-occurrence #${r.record.count} (still ${r.record.status})`}`;
      return { ok: true, result: text, meta: { version: VERSION, ...r }, summary: r.occasion === 'regression' ? 'lesson DEMOTED — old proof did not hold' : text };
    },
  }),
  def({
    name: 'ma.verify_lesson',
    group: 'ma',
    risk: 'write',
    desc: 'Mark a lesson VERIFIED — only against a concrete proof string (command + result, test name + outcome, observed behaviour). Minimum 20 chars; a bald "fixed" is refused by design.',
    params: { id: 'string: lesson id from ma.lessons or ma.learn — required', proof: 'string: the measurement, ≥20 chars — required' },
    examples: ['ma.verify_lesson({id:"les-ab12cd34ef56", proof:"npm test: 653/635/0/18 incl. new regression gate stream-switch 6b PASS"})'],
    async run({ id, proof }, ctx) {
      const r = storeFor(ctx).verify({ id, proof });
      if (!r.ok) return r;
      return { ok: true, result: `lesson ${id} VERIFIED at ${r.record.verifiedAt} (${(r.record.proofs || []).length} proof(s) archived)`, meta: { ...r }, summary: `lesson ${id} verified` };
    },
  }),
  def({
    name: 'ma.lessons',
    group: 'ma',
    risk: 'read',
    desc: 'List durable lessons + loop stats. Open items (unverified/regressed) reported FIRST — the loop exists to close them, not to celebrate the done pile.',
    params: { status: 'string: unverified|verified|regressed (optional — all by default)' },
    examples: ['ma.lessons({})', 'ma.lessons({status:"regressed"})'],
    async run({ status }, ctx) {
      const store = storeFor(ctx);
      const rows = store.list({ status: status || null });
      const stats = store.stats();
      const lines = rows.slice(0, 30).map((r) => `- [${r.status}${r.demotions ? ' demoted×' + r.demotions : ''}] ${r.id} ×${r.count} — ${r.trigger}${r.status === 'verified' ? ` (proofs: ${r.proofs.length})` : ''}`);
      const text = `${renderStats(stats, VERSION)}${rows.length ? '\n' + lines.join('\n') : '\n  no lessons recorded yet'}`;
      return { ok: true, result: text, meta: { version: VERSION, stats, lessons: rows }, summary: `${stats.total} lessons, ${stats.openness} open` };
    },
  }),
];
