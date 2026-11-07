/* MAJIN — Persistent Session & Agent Handoff: modellen SKA fa historiken,
   byten mellan modeller behaller kontexten, checkpoints overlever restart.
   Fail-first: servervagen skickade aldrig historiken (bug gen historiet
   skrevs noggrannt till disk — det las aldrig in i prompten). */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-handoff-'));
process.env.MAJIN_HOME = home;
process.env.MAJIN_NO_UPDATE_CHECK = '1';

const { createRuntime } = await import('../src/core/runtime.js');
const { setScript, lastCalls, resetCalls } = await import('../src/core/provider/mock.js');

const demoRt = async () => {
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: Object.fromEntries(['tasks', 'chat', 'router', 'analysis', 'plan', 'research', 'code', 're', 'final', 'aggregator'].map((j) => [j, 'demo/demo-fast'])) },
    guard: { mode: 'off' },
    moa: { policy: 'off' },
  }, { persist: false });
  return rt;
};

test('historiken i sessionen gar tillbaka till modellen vid nasta meddelande (KALL-bristen)', async () => {
  const rt = await demoRt();
  resetCalls();
  setScript('main:chat', [{ text: 'Jag minns att du heter Kalle.' }]);

  await rt.agent.turn({ input: 'Mitt namn är Kalle.', session: 'hista' });
  resetCalls();
  setScript('main:chat', [{ text: 'Du sa att du heter Kalle.' }]);
  const r2 = await rt.agent.turn({ input: 'Vad sa jag att jag hette?', session: 'hista' });

  const calls = lastCalls();
  const joined = calls.map((c) => c.messages.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`).join(' | ')).join('\n');
  assert.match(joined, /Mitt namn är Kalle/, `meddelande 1 ska nas modellen vid meddelande 2! funnen kedja: ${joined.slice(0, 250)}`);
  assert.match(joined, /Jag minns att du heter Kalle/, `aven tidigare MODELL-svar ska vara med (full kontext): ${joined.slice(0, 250)}`);
  assert.match(r2.text || '', /Kalle/);
  await rt.shutdown();
});

test('sessioner lar sig ALDRIG kitring varandra (fullstandig isolation)', async () => {
  const rt = await demoRt();
  resetCalls();
  setScript('main:tasks', [{ text: 'antecknat.' }]);
  await rt.agent.turn({ input: 'hemligheten ar RABARB', session: 'histaA' });
  resetCalls();
  await rt.agent.turn({ input: 'berätta något helt annat', session: 'histaB' });
  /* task-blistningen (awareText) lagar medvetet arbets-briefs over alla
     sessioner — det ar noatboken, inte historiken. Vi testar HISTORIK-sargen. */
  const histJoined = lastCalls()
    .flatMap((c) => c.messages)
    .filter((m) => m.role !== 'system')
    .map((m) => String(m.content || ''))
    .join('\n');
  assert.ok(!histJoined.includes('RABARB'), `session B ska aldrig se As historik: ${histJoined.slice(0, 200)}`);
  await rt.shutdown();
});

test('modellbyte mitt i samtalet: ny modell far HELA neskonkon (handoff-testet i praktiken)', async () => {
  const rt = await demoRt();
  resetCalls();
  setScript('main:tools', [{ text: 'Ko.de start: jag bygger spelet in i game.js, steg 1 av 3 klart.' }]);
  await rt.agent.turn({ input: 'Bygg ett spel med DeepSeek.', session: 'spelskiftet' });
  /* anvandaren byter modell (intent: use qwen) */
  rt.cfg.patch({ models: { provider: 'qwin-like', routes: { tasks: 'demo/demo-fast' } } }, { persist: false });
  setScript('main:chat', [{ text: 'Jag fortsätter bygningetwei: steg 2 av 3 nu, i samma game.js.' }]);
  const h = await rt.agent.handoff?.({ session: 'spelskiftet', to: 'demo/demo-fast' });
  resetCalls();
  const r = await rt.agent.turn({ input: 'Fortsätt med Qwen.', session: 'spelskiftet' });
  const joined = lastCalls().map((c) => c.messages.map((m) => `${m.role}: ${m.content||''}`).join(' | ')).join('\n');
  assert.match(joined, /Bygg ett spel med DeepSeek/, `malet forlorat vid byte: ${joined.slice(0, 200)}`);
  assert.match(joined, /steg 1 av 3 klart/, `framstegslaget forlorat vid byte: ${joined.slice(0, 200)}`);
  assert.ok(h, 'handoff() ska producera en checkpoint');
  assert.ok(!h.skipped, 'handoff far aldrig vara en no-op');
  await rt.shutdown();
});

test('plan/checkpoint overlever fullstandig restart av runtimen', async () => {
  const rt1 = await demoRt();
  setScript('main:tasks', [{ text: 'steg 1 gjort.' }]);
  const r1 = await rt1.agent.turn({ input: 'Lista tre steg och kör steg ett: 1. planera 2. bygga 3. testa', session: 'hallbart' });
  rt1.agent.setPlan('hallbart', [
    { text: 'planera', status: 'done' },
    { text: 'bygga', status: 'doing' },
    { text: 'testa', status: 'todo' },
  ], 'från användarens trepunktslista');
  const plan = rt1.agent.planSnapshot?.('hallbart');
  assert.equal(plan.count, 3, 'planSnapshot innan restart');
  await rt1.shutdown();

  /* NY runtime — massigren ska aldrig sakna knolskap checkpoints */
  const rt2 = await demoRt();
  resetCalls();
  setScript('main:tasks', [{ text: 'steg 2: fortsatter enligt plan.' }]);
  const p2 = rt2.agent.planSnapshot?.('hallbart');
  assert.ok(p2, 'planSnapshot levererar alltid ett objekt');
  assert.equal(p2.count, 3, 'checkpointen ska överleva fullständig restart (checkpoint == planfil på disk)');
  assert.equal(p2.plan[1].status, 'doing', 'statusfältet ska följa med');
  assert.match(p2.plan.map((x) => x.text).join(','), /planera.*bygga.*testa/);
  const r2 = await rt2.agent.turn({ input: 'Fortsatt dar du slutade.', session: 'hallbart', handoff: p2 });
  const joined = lastCalls().map((c) => c.messages.map((m) => `${m.role}: ${m.content||''}`).join(' | ')).join('\n');
  assert.match(joined, /planera|bygga|testa|steg/i, `restartade kontexten ska ha planen + historien: ${joined.slice(0, 220)}`);
  await rt2.shutdown();
});
