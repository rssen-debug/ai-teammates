/* MAJIN — GENESIS OMEGA fas 2: relevant verktygs-subset i loopen.
   Fail-first: flaggan agent.toolSubset finns inte än. När den är på ska the
   loop bara skicka det deterministiska urvalet (search(input) + alltid
   tools.search) till modellen — noll LLM-tokens för själva urvalet. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-subset-'));

const { createRuntime } = await import('../src/core/runtime.js');
const { setScript } = await import('../src/core/provider/mock.js');

const JOBS = ['tasks', 'tools', 'chat', 'code', 'research', 'analysis', 'summarize', 'plan', 'final', 're'];

async function mkrt(subsetOn, limit = 12) {
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: Object.fromEntries(JOBS.map((j) => [j, 'demo/demo-fast'])) },
    moa: { policy: 'off' },
    guard: { mode: 'off' },
    agent: { toolSubset: subsetOn, toolSubsetLimit: limit, maxSteps: 6 },
  }, { persist: false });
  return rt;
}

test('standard är oförändrad: alla scheman skickas när flaggan är av', async () => {
  const rt = await mkrt(false);
  const sys = rt.agent.systemPrompt({ session: 's1', decision: { job: 'tasks', confidence: 1 }, turnPlan: {}, readOnly: false });
  assert.match(sys, /TOOLS: all 149 are always on/, 'prompten ska fortfarande deklarera alla verktyg');
  // loop-sidans kontrakt: utan subset-names i ctx kan hämtaren ge hela synliga ytan
  assert.equal(rt.registry.schemas().length, rt.registry.list().length);
  await rt.shutdown();
});

test('agent.toolSubset: true väljer relevanta verktyg per tur — deterministiskt och noll-token', async () => {
  const rt = await mkrt(true);
  const sel = rt.agent.toolSelection('write the text "bench ok" to bench.txt', {});
  assert.ok(sel.names.includes('fs.write'), `fs.write måste vara med i urvalet: [${sel.names}]`);
  assert.ok(sel.names.includes('tools.search'), 'tools.search är flyktvägen — får aldrig försvinna');
  assert.ok(sel.names.length <= 13, `limit 12 + flyktväg: ${sel.names.length}`);
  const again = rt.agent.toolSelection('write the text "bench ok" to bench.txt', {});
  assert.deepEqual(sel.names, again.names, 'samma input → samma urval, varje gång');
  await rt.shutdown();
});

test('urval respekterar readOnly: skrivverktyg ute, tools.search kvar', async () => {
  const rt = await mkrt(true);
  const sel = rt.agent.toolSelection('write x to a.txt', { readOnly: true });
  const risks = sel.names.map((n) => rt.registry.byName.get(n).risk);
  assert.ok(!risks.includes('write') && !risks.includes('exec') && !risks.includes('destructive'), `readOnly får inga sidoeffektsverktyg: [${sel.names}]`);
  assert.ok(sel.names.includes('tools.search'));
  await rt.shutdown();
});

test('loop skickar bara urvalet till modellen — och fyller i steg-info ärligt', async () => {
  const rt = await mkrt(true);
  setScript('main:tasks', [
    { text: 'Writing the file.', toolCalls: [{ name: 'fs.write', args: { path: 'subset.txt', content: 'sel ok\n' } }] },
    { text: 'Wrote subset.txt.' },
  ]);
  for (const k of ['final:aggregator', 'final:moa', 'final:escalate']) setScript(k, [{ text: 'Wrote subset.txt.' }]);
  const evs = [];
  const out = await rt.agent.turn({
    input: 'write the text "sel ok" to subset.txt',
    session: 'subset-turn',
    onEvent: (e) => evs.push(e),
  });
  const sub = evs.find((e) => e.type === 'tool_subset');
  assert.ok(sub, 'en subset-händelse ska deklarera vad som valdes');
  assert.ok(sub.names.includes('fs.write'), 'fs.write valdes in av urvalet');
  assert.ok(sub.names.length <= 13);
  const steps = evs.filter((e) => e.type === 'step');
  assert.ok(steps.length >= 1, 'steg-händelser');
  for (const st of steps) {
    assert.ok(Number.isFinite(st.toolsSent) && Number.isFinite(st.toolChars), 'varje steg raporterar vad modellen fick se');
    assert.ok(st.toolsSent <= sub.names.length, `steget skickade ${st.toolsSent} > urvalet ${sub.names.length}`);
  }
  assert.ok(!out.error, String(out.error || '').slice(0, 120));
  assert.ok(fs.existsSync(path.join(rt.cfg.get('workspace'), 'subset.txt')), 'verktyget rförde sig fortfarande verkligt');
  await rt.shutdown();
});

test('fallback: okänd input ger tools.search + ärligt tom yta — aldrig fejkade verktyg', async () => {
  const rt = await mkrt(true);
  const sel = rt.agent.toolSelection('xylophone quantifier spoon drawer', {});
  assert.deepEqual(sel.names.filter((n) => n !== 'tools.search'), [], 'noll seed även här');
  assert.ok(sel.names.includes('tools.search'));
  await rt.shutdown();
});
