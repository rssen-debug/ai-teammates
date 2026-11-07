/* MAJIN GRAND ARCHITECT — mission compiler: fritt mål → DAG → HYPERSWARM.
   Beslutet ANTAL workers fattas aldrig av modellen (analyzer i kod);
   modellen får bara FYLLA grafen. Fallnar kompilern: vanlig turn. GENESIS ZERO
   överlever ALLTID: mission kan aldrig krascha en tur. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-mission-'));

const { shouldMission, compileMission, runMission } = await import('../src/core/mission.js');
const { createRuntime } = await import('../src/core/runtime.js');
const { setScript, lastCalls, resetCalls } = await import('../src/core/provider/mock.js');

test('shouldMission: numrerad eller tydligt flerdelad uppgift känns igen — deskriptivt, aldrig godtyckligt', () => {
  const listig = shouldMission('1. Skriv filen a2.txt\n2. Rensa temporbobbelsen\n3. Rapportp överresultat till mig');
  assert.equal(listig.mission, true, 'numrerad lista = verktygsGo');
  assert.match(listig.reason, /3/);
  const komma = shouldMission('rensa Downloads, sortera filerna efter typ, zip de viktigaste, flytta arkivet till backuper');
  assert.equal(komma.mission, true, 'fyra komma-separerade verbit');
  const enkel = shouldMission('vad heter Sveriges huvudstad?');
  assert.equal(enkel.mission, false);
  const kort = shouldMission('hjälp');
  assert.equal(kort.mission, false);
});

test('compileMission: modellen formulerar DAG-en, ANALYZATORN validera: cycles, max-noder, skadade deps', async () => {
  const empty = await compileMission('vad ska jag ata till middag', { cfg: null });
  assert.equal(empty.kind, 'single', 'icke-mission compilerar aldrig');

  const cfg = await (await import('../src/core/config.js')).load();
  cfg.patch({
    models: { routes: { tasks: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
  }, { persist: false });

  /* (a) ren JSON → mission med 3 noder, deps ur parsing */
  const good = JSON.stringify({ nodes: [
    { id: 'n1', input: 'write three facts about mars', deps: [], estMs: 30000 },
    { id: 'n2', input: 'collect venus stats', deps: [], estMs: 30000 },
    { id: 'n3', input: 'summarize both research notes', deps: ['n1', 'n2'], estMs: 30000 },
  ] });
  setScript('mission:compile', [{ text: good }]);
  const ok = await compileMission('1. research mars\n2. research venus\n3. skriv sammanfattning', { cfg });
  assert.equal(ok.kind, 'mission', JSON.stringify(ok).slice(0, 200));
  assert.equal(ok.nodes.length, 3);
  assert.deepEqual(ok.nodes[2].deps, ['n1', 'n2']);

  /* (b) modellbrak PA ett icke-listigt input → single med ärlig orsak, aldrig krasch.
     (pa listigt input triktrar den deterministiska reserven istallet — se nasta test) */
  setScript('mission:compile', [{ text: 'absolutely not json, tycker jag själt' }]);
  const bad = await compileMission('rensa meddelanden, flytta mappen, skriv rapport', { cfg });
  assert.equal(bad.kind, 'single');
  assert.match(bad.reason || '', /json|parse|extract/i);

  /* (c) cyklisk graf avvisarras: beslut i kod */
  setScript('mission:compile', [{ text: JSON.stringify({ nodes: [
    { id: 'a', input: 'x', deps: ['b'], estMs: 1000 },
    { id: 'b', input: 'y', deps: ['a'], estMs: 1000 },
  ] }) }]);
  const cyc = await compileMission('1. äpple\n2. päron\n3. morot', { cfg });
  assert.equal(cyc.kind, 'single');
  assert.match(cyc.reason || '', /cyclic|invalid/i);

  /* (d) för många noder → negr: aldrig överlocked swamord */
  setScript('mission:compile', [{ text: JSON.stringify({ nodes: Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i, input: 'v' + i, deps: [], estMs: 1000 })) }) }]);
  const many = await compileMission('1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\n8. h\n9. i\n10. j\n11. k\n12. l', { cfg });
  assert.equal(many.kind, 'single');
  assert.match(many.reason || '', /too many|nodes|limit/i);
});

test('compileMission: modell fallerar på JSON → LISt-fallback producerar mission ändå (små lokala modellers styrka)', async () => {
  const cfg = await (await import('../src/core/config.js')).load();
  cfg.patch({ models: { routes: { tasks: 'demo/demo-fast' } }, providers: { demo: { kind: 'mock', apiKey: 'demo' } } }, { persist: false });
  setScript('mission:compile', [{ text: 'jag kan inte ge dig json, men jag kan roera din värld!' }]);
  const r = await compileMission('1. Skriv filen a.txt\n2. Rensa bobbelmappen\n3. Skriv resultatrapport', { cfg });
  assert.equal(r.kind, 'mission', `heuristic-fallback ska rädda: ${JSON.stringify(r)}`);
  assert.equal(r.origin, 'heuristic-fallback');
  assert.equal(r.nodes.length, 3);
  assert.match(r.nodes[0].input, /Skriv filen/);
});

test('agent.turn: en deskriptivt flerdelsuppgift körs som mission MED äkta workers (mock-rout)', async () => {
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: Object.fromEntries(['tasks', 'chat', 'router', 'analysis', 'plan', 'research', 'code', 're', 'final', 'aggregator'].map((j) => [j, 'demo/demo-fast'])) },
    guard: { mode: 'off' },
    moa: { policy: 'off' },
  }, { persist: false });

  const dag = JSON.stringify({ nodes: [
    { id: 'r1', input: 'research mars facts', deps: [], estMs: 30000 },
    { id: 'r2', input: 'research venus facts', deps: [], estMs: 30000 },
    { id: 'r3', input: 'research jupiter facts', deps: [], estMs: 30000 },
  ] });
  setScript('mission:compile', [{ text: dag }]);
  setScript('sub:tasks', [{ text: 'mars-notering' }, { text: 'venus-notering' }, { text: 'jupiter-notering' }]);

  const events = [];
  const t0 = performance.now();
  const r = await rt.agent.turn({
    input: '1. Research Mars\n2. Research Venus\n3. Research Jupiter\nThen tell me it is done.',
    session: 'mission-demo',
    onEvent: (e) => events.push(e),
  });
  const wall = performance.now() - t0;

  assert.ok(r.mission, `svaret ska vara en mission: ${JSON.stringify(Object.keys(r))}`);
  assert.equal(r.mission.nodes, 3);
  assert.equal(r.mission.workers, 3, 'analysatorn: 3 oberoende => 3 workers');
  assert.equal(r.mission.okCount, 3);
  assert.match(r.text || '', /3\/3|klar|done/i, 'sammanfattningen säger ärligt status');
  assert.ok(events.some((e) => e.type === 'mission'), 'mission-event emitteras');
  assert.ok(wall < 8000, `3 mock-turner parallellt: ${wall.toFixed(0)}ms`);
  await rt.shutdown();
});

test('agent.turn: enkelfråga tas ALDRIG den mission-vägen (GENESIS ZERO intakt)', async () => {
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: Object.fromEntries(['tasks', 'chat', 'router', 'analysis', 'plan', 'research', 'code', 're', 'final', 'aggregator'].map((j) => [j, 'demo/demo-fast'])) },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' },
    moa: { policy: 'off' },
  }, { persist: false });
  setScript('main:research', [{ text: 'Stockholm är huvudstaden.' }]);
  const r = await rt.agent.turn({ input: 'vad är Sveriges huvudstad?', session: 'single-demo' });
  assert.ok(!r.mission, 'enkelsekraften ska INTE bli mission');
  assert.match(r.text || '', /Stockholm/);
  await rt.shutdown();
});

test('inline-numrerede lister udloser også mission (bug: radbrudnende krav missade)', () => {
  const cases = [
    'I need three things: (1) name one asteroid, (2) name one volcano, (3) name one ocean.',
    'Research three things and report back: 1) find the population of Tokyo 2) find the newest Mars rover 3) name the deepest ocean trench.',
    'Todo: (a) write the report (b) compress the folder (c) send the summary',
  ];
  for (const input of cases) {
    const r = shouldMission(input);
    assert.ok(r.mission, `ska utlosa mission pa inline-nummering: ${input.slice(0, 60)}... (fick "${r.reason}")`);
    assert.ok(/item|segment/i.test(r.reason), `reason ska forklara matchen, fick "${r.reason}"`);
  }
  const no = shouldMission('Read the report, summarize it.');
  assert.equal(no.mission, false, 'tva små korta far aldrig klaring mission');
});

test('compiler-fallback for inline-listor: sma modeller som inte kan JSON delar anda upp missionen', async () => {
  const { compileMission } = await import('../src/core/mission.js');
  const cfg = await (await import('../src/core/config.js')).load();
  cfg.patch({ models: { routes: { tasks: 'demo/demo-fast' } }, providers: { demo: { kind: 'mock', apiKey: 'demo' } } }, { persist: false });
  setScript('mission:compile', [{ text: 'igenkanlig: ingen json, bara dannor!' }]);
  const graph = await compileMission('Help woth three things: (1) name one asteroid, (2) name one volcano, (3) name one ocean.', { cfg });
  assert.equal(graph.kind, 'mission', JSON.stringify(graph).slice(0, 160));
  assert.equal(graph.origin, 'heuristic-fallback', 'markerar at reserven gav grafen');
  assert.equal(graph.nodes.length, 3, JSON.stringify(graph.nodes.map((n) => n.input)));
  assert.ok(/asteroid/.test(graph.nodes[0].input) && /ocean/.test(graph.nodes[2].input));
});


/* ---- Reality Engine: verify->repair mot fil-artefakter ---- */

test('mission verify->repair: en worker som PASTAAR att den skrivit en fil men inte gjort det markeras som MISSLYCKAD (inte ok)', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-msverify-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' },
    workspace: ws,
  }, { persist: false });
  const dag = JSON.stringify({ nodes: [
    { id: 'p1', input: 'write the file alpha.txt with a two-line poem', deps: [], estMs: 1000 },
    { id: 'p2', input: 'report the number of moons of mars and nothing more', deps: [], estMs: 1000 },
  ] });
  setScript('mission:compile', [{ text: dag }]);
  /* sub:tasks-scripten konsumeras strengt i ordning vid capOverride=1:
     p1 lyger (ingen tool-call, ingen fil), repair lyger igen, p2 svarar aert. */
  setScript('sub:tasks', [
    { text: 'Klart! alpha.txt är nu skriven.' },                 /* p1 första — ljuger */
    { text: 'alpha.txt är DEFINITIVT skriven nu, lovar.' },      /* p1 repair — ljuger igen */
    { text: 'Mars has two moons: Phobos and Deimos.' },          /* p2 */
  ]);
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'msverify', input: '1. write the file alpha.txt with a two-line poem\n2. report the number of moons of mars and nothing more', emit: () => {}, capOverride: 1 });
  assert.equal(m.kind, 'mission', JSON.stringify(m).slice(0, 200));
  assert.equal(m.okCount, 1, `p1 ska ha markerats fel, inte ok: ${JSON.stringify(m.textSummary)}`);
  assert.equal(m.failCount, 1, 'failCount ska vara 1 (p1 misslyckades ärligen)');
  assert.match(m.textSummary[0], /verification failed|missing or empty/, `p1-linjen ska bära verifieringsfelet: ${m.textSummary[0]}`);
  assert.match(m.textSummary[1], /not independently verifiable/, `p2-linjen ska sakna artifactens hävdan: ${m.textSummary[1]}`);
  assert.ok(!fs.existsSync(path.join(ws, 'alpha.txt')), 'lögnern ska aldrig bli till sanning i missionen');
  await rt.shutdown();
});

test('mission verify: en worker som VALIDt skriver filen (fs.write) faar VERIFIED-markering; repair kan riva en onyttig loogn', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-msverify2-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' },
    workspace: ws,
  }, { persist: false });
  const dag = JSON.stringify({ nodes: [
    { id: 'p1', input: 'write the file beta.txt with one greeting line', deps: [], estMs: 1000 },
    { id: 'p2', input: 'write the file gamma.txt with one number line', deps: [], estMs: 1000 },
  ] });
  setScript('mission:compile', [{ text: dag }]);
  setScript('sub:tasks', [
    { text: 'beta.txt är skapad.' },                                   /* p1 lyger först */
    { toolCalls: [{ name: 'fs.write', args: { path: 'beta.txt', content: 'hej från repair' } }] },  /* repair-runda: gör på riktigt */
    { text: 'beta.txt verifierad skriven.' },                          /* repair-svar */
    { toolCalls: [{ name: 'fs.write', args: { path: 'gamma.txt', content: '42' } }] }, /* p2 direkt av亨利 */
    { text: 'gamma.txt klar.' },
  ]);
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'msverify2', input: '1. write the file beta.txt with one greeting line\n2. write the file gamma.txt with one number line', emit: () => {}, capOverride: 1 });
  assert.equal(m.failCount, 0, `inget ska faila: ${JSON.stringify(m.textSummary)}`);
  assert.equal(m.okCount, 2);
  assert.equal(m.verifiedCount, 2, 'bägge artefakt-claim ska kunna verifieras');
  assert.equal(m.repairedCount, 1, 'p1 skampta reparerats och verifierats');
  assert.match(m.textSummary[0], /VERIFIED|verified|after repair/i, m.textSummary[0]);
  assert.ok(fs.readFileSync(path.join(ws, 'beta.txt'), 'utf8').includes('repair'), 'repair skrev filen på riktigt');
  assert.equal(fs.readFileSync(path.join(ws, 'gamma.txt'), 'utf8'), '42', 'p2:s innehåll landade');
  await rt.shutdown();
});

test('VERIFICATION CONTRACTS: file_contains — a lying worker is caught on the CONTENT, not just existence', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ctrA-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  const dag = JSON.stringify({ nodes: [{ id: 'p1', input: 'write the file song.txt containing the word "needle"', deps: [], estMs: 1000 }, { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 }] });
  setScript('mission:compile', [{ text: dag }]);
  /* re-run order with cap=1: p1-run (2 modelkalls), p2-run (1), REPAIR-p1 (2)
     — verify+repair happens efter swarm, så repair-entriesna ligger sist */
  setScript('sub:tasks', [
    { toolCalls: [{ name: 'fs.write', args: { path: 'song.txt', content: 'hay hay hay' } }] },
    { text: 'song.txt skriven med "needle".' },                 /* lie: content is hay-ish */
    { text: 'done done done.' },
    { toolCalls: [{ name: 'fs.write', args: { path: 'song.txt', content: 'needle in a haystack' } }] },
    { text: 'song.txt innehåller nu "needle".' },
  ]);
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'ctrA', input: '1. write the file song.txt containing the word "needle"\n2. tell me it is done', emit: () => {}, capOverride: 1 });
  assert.equal(m.failCount, 0, JSON.stringify(m.textSummary));
  assert.equal(m.repairedCount, 1, 'content lie krävde en repair-runda');
  assert.match(m.textSummary[0], /needle/, m.textSummary[0]);
  assert.equal(fs.readFileSync(path.join(ws, 'song.txt'), 'utf8'), 'needle in a haystack');
  await rt.shutdown();
});

test('VERIFICATION CONTRACTS: count — a worker that invents a number is re-counted by CODE and caught', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ctrB-'));
  fs.mkdirSync(path.join(ws, 'store'));
  for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(ws, 'store', f), f);
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  const dag = JSON.stringify({ nodes: [{ id: 'p1', input: 'report the number of files in store/', deps: [], estMs: 1000 }, { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 }] });
  setScript('mission:compile', [{ text: dag }]);
  setScript('sub:tasks', [
    { text: 'There are 7 files in store/.' },              /* p1 — lögnen */
    { text: 'done done done.' },                            /* p2 */
    { text: 'There are 3 files in store/.' },              /* REPAIR-p1 — ärligt */
  ]);
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'ctrB', input: '1. report the number of files in store/\n2. tell me it is done', emit: () => {}, capOverride: 1 });
  assert.equal(m.failCount, 0, JSON.stringify(m.textSummary));
  assert.equal(m.okCount, 2, 'p1 verifieard efter repair, p2 ok utan kontrakt');
  assert.equal(m.repairedCount, 1, 'räkne-lögnen KRÄVDE repair innan godkännande');
  assert.match(m.textSummary[0], /3 files \(independently counted\)/, `proveniens ska matcha oberoende räkning: ${m.textSummary[0]}`);
  await rt.shutdown();
});

test('VERIFICATION CONTRACTS: count — correct first answer verified WITHOUT needing repair', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ctrC-'));
  fs.mkdirSync(path.join(ws, 'store'));
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(ws, 'store', f), f);
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  const dag = JSON.stringify({ nodes: [{ id: 'p1', input: 'report the number of files in store/', deps: [], estMs: 1000 }, { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 }] });
  setScript('mission:compile', [{ text: dag }]);
  setScript('sub:tasks', [{ text: 'There are 2 files in store/.' }, { text: 'done done done.' }]);
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'ctrC', input: '1. report the number of files in store/\n2. tell me it is done', emit: () => {}, capOverride: 1 });
  assert.equal(m.repairedCount, 0, 'ärlig worker behöver ingen repair');
  assert.equal(m.verifiedCount, 1);
  await rt.shutdown();
});

/* ---------------- Del 4C: hard limits respected, in code ---------------- */

test('PRODUCTION LIMITS: worker-calls never exceed repair+replan caps even with a permanently lying worker [LIMIT:REPLAN]', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-4c-retry-'));
  fs.writeFileSync(path.join(ws, 'song.txt'), 'Darwin was a naturalist.'); /* needle never contains "survival of the fittest" */
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
    mission: { limits: { repairRounds: 2, timeoutMs: 0, tokenBudget: 99999999 } },
  }, { persist: false });
  const dag = JSON.stringify({ nodes: [
    { id: 'p1', input: 'write song.txt that contains the exact phrase "survival of the fittest"', deps: [], estMs: 1000 },
    { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 },
  ] });
  setScript('mission:compile', [{ text: dag }]);
  /* initial + 2 lying repairs + 1 lying REPLAN (2C) — needle never written */
  setScript('sub:tasks', [
    { text: 'I wrote the phrase survival of the fittest into song.txt.' },
    { text: 'done done done.' },
    { text: 'Repair 1 done: song.txt now says survival of the fittest.' },
    { text: 'Repair 2 done: song.txt now says survival of the fittest.' },
    { text: 'REPLANNED approach done: song.txt now says survival of the fittest. (still lying)' },
    { text: 'SHOULD NEVER BE CONSUMED — more attempts would violate the caps.' },
  ]);
  resetCalls();
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'limR', input: '1. write song.txt that contains the exact phrase "survival of the fittest"\n2. tell me it is done', emit: () => {}, capOverride: 1 });
  const taskCalls = lastCalls().filter((c) => c.key === 'sub:tasks').length;
  assert.equal(taskCalls, 5, `expected 1 initial + 1 trivial + 2 repairs + 1 replan = 5 worker calls, got ${taskCalls} — caps not enforced`);
  assert.match(m.textSummary.join('\n'), /\[LIMIT:REPLAN\]/, 'repair exhausted + replan exhausted must carry the LIMIT:REPLAN marker');
  assert.ok(m.limitsHit.includes('replan'), JSON.stringify(m.limitsHit));
  assert.equal(m.failCount, 1, 'p1 must fail honestly after repair AND replan, never loop forever');
  await rt.shutdown();
});

test('PRODUCTION LIMITS: token budget aborts the mission mid-flight with [LIMIT:BUDGET] and no overspend beyond the abort point', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-4c-budget-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
    mission: { limits: { repairRounds: 1, timeoutMs: 0, tokenBudget: 40 } }, /* instantly exceeded by the first fat answer */
  }, { persist: false });
  const dag = JSON.stringify({ nodes: [
    { id: 'p1', input: 'say done in three words, no more', deps: [], estMs: 1000 },
    { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 },
  ] });
  setScript('mission:compile', [{ text: dag }]);
  const fat = 'token '.repeat(120); /* ~600 chars => mock usage well over the 40-token budget */
  setScript('sub:tasks', [
    { text: fat },
    { text: 'SECOND NODE MUST NEVER RUN — the budget abort must stop the swarm.' },
  ]);
  resetCalls();
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'limB', input: '1. summarize the project journal\n2. summarize the token ledger', emit: () => {}, capOverride: 1 });
  const taskCalls = lastCalls().filter((c) => c.key === 'sub:tasks').length;
  assert.equal(taskCalls, 1, `budget abort must stop the second worker from ever starting; got ${taskCalls} calls`);
  assert.ok(m.limitsHit.includes('budget'), JSON.stringify(m.limitsHit));
  assert.match(m.textSummary.join('\n'), /\[LIMIT:BUDGET\]/, 'summary must carry the LIMIT:BUDGET marker');
  assert.ok(m.usedTokens > 40, `usedTokens should reflect the real measured spend, got ${m.usedTokens}`);
  await rt.shutdown();
});

test('PRODUCTION LIMITS: a mission that overruns its wall-clock budget is stopped by [LIMIT:TIMEOUT], not by waiting for the worker', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-4c-time-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
    mission: { limits: { repairRounds: 1, timeoutMs: 120, tokenBudget: 0 } }, /* mock sleeps ~4 ms per word; the scripted answer is 400+ words */
  }, { persist: false });
  const dag = JSON.stringify({ nodes: [
    { id: 'p1', input: 'say done in three words, no more', deps: [], estMs: 1000 },
    { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 },
  ] });
  setScript('mission:compile', [{ text: dag }]);
  const slow = 'word '.repeat(420); /* ≈1.7 s of mock streaming => far past the 120 ms cap */
  setScript('sub:tasks', [{ text: slow }, { text: 'MUST NEVER RUN — deadline already fired.' }]);
  const t0 = Date.now();
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'limT', input: '1. summarize the project journal\n2. summarize the token ledger', emit: () => {}, capOverride: 1 });
  const wall = Date.now() - t0;
  assert.ok(m.limitsHit.includes('timeout'), JSON.stringify(m.limitsHit));
  assert.match(m.textSummary.join('\n'), /\[LIMIT:(TIMEOUT|BUDGET)\]/, 'summary must name the limit that fired');
  assert.ok(wall < 1500, `mission returned in ${wall} ms — the run must be cut by the deadline, not by the slow worker (~1.7 s)`);
  assert.equal(m.okCount, 0, 'nothing may be marked ok after the deadline fired mid-flight');
  await rt.shutdown();
});

test('RESILIENCE: a provider flake mid-mission is absorbed by ONE bounded replacement — mission still verifies', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-3c-live-'));
  fs.mkdirSync(path.join(ws, 'store'));
  fs.writeFileSync(path.join(ws, 'store', 'a.txt'), 'a');
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
    mission: { limits: { repairRounds: 1, timeoutMs: 0, tokenBudget: 0, transientRetries: 1 } },
  }, { persist: false });
  setScript('mission:compile', [{ text: JSON.stringify({ nodes: [{ id: 'p1', input: 'report the number of files in store/', deps: [], estMs: 1000 }, { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 }] }) }]);
  /* p1 flakes once (transient), p2 answers, then p1's REPLACEMENT answers.
     Consumption order with cap=1: p1-a1 throw -> p2 -> p1-a2. */
  /* retry lands FIRST in node order (p1 relaunchable before p2 is reached): */
  setScript('sub:tasks', [
    { throw: 'fetch failed: ECONNRESET to provider' },
    { text: 'There are 1 files in store/.' },
    { text: 'done done done.' },
  ]);
  const events = [];
  resetCalls();
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'resS', input: '1. report the number of files in store/\n2. tell me it is done', emit: (e) => events.push(e), capOverride: 1 });
  const taskCalls = lastCalls().filter((c) => c.key === 'sub:tasks').length;
  assert.equal(taskCalls, 3, `2 workers + 1 replacement = 3 calls, got ${taskCalls}`);
  assert.equal(m.okCount, 2, JSON.stringify(m.textSummary));
  assert.equal(m.failCount, 0);
  const retry = events.find((e) => e.type === 'worker_retry');
  assert.ok(retry, 'worker_retry must be visible in mission events');
  assert.equal(retry.attempt, 2);
  assert.match(String(retry.why), /ECONNRESET/i);
  assert.ok((fs.readdirSync(path.join(ws)) || []).length >= 0);
  await rt.shutdown();
});

/* ---------------- Del 2C: ambiguity, change and failure-driven replanning ---------------- */

test('CLARIFY: a dangerously ambiguous goal is answered with a question — zero workers, zero side effects', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-2c-clar-'));
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  setScript('mission:compile', [{ text: '{"clarify":"Which file do you mean — song.txt or budget.txt? They both exist."}' }]);
  setScript('sub:tasks', [{ text: 'NO WORKER SHOULD EVER RUN.' }]);
  resetCalls();
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'clarS', input: '1. fixen the file now\n2. tell me it is done done done done done', emit: () => {}, capOverride: 1 });
  assert.equal(m.kind, 'clarify', JSON.stringify(m.textSummary));
  assert.ok(/song\.txt/.test(m.question) && /budget\.txt/.test(m.question), 'question must name the missing choice');
  assert.equal(lastCalls().filter((c) => c.key === 'sub:tasks').length, 0, 'a question costs ZERO worker calls');
  assert.match(m.textSummary.join('\n'), /Clarify before I touch anything/);
  assert.deepEqual(fs.readdirSync(ws), [], 'workspace untouched until the user answers');
  await rt.shutdown();
});

test('REPLAN: when repair keeps lying, ONE strategy-change attempt produces the real evidence and is VERIFIED', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-2c-replan-'));
  fs.writeFileSync(path.join(ws, 'song.txt'), 'Darwin was a naturalist.');
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  setScript('mission:compile', [{ text: JSON.stringify({ nodes: [{ id: 'p1', input: 'write song.txt that contains the exact phrase "survival of the fittest"', deps: [], estMs: 1000 }, { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 }] }) }]);
  setScript('sub:tasks', [
    { text: 'I wrote the phrase survival of the fittest into song.txt.' },          /* 1: initial lie */
    { text: 'done done done.' },                                                     /* 2: p2 */
    { toolCalls: [{ name: 'fs.write', args: { path: 'song.txt', content: 'repair attempt: wallace was a naturalist.' } }] }, /* 3: repair TOOL writes WRONG content */
    { text: 'Repair done: song.txt now says survival of the fittest. (still a lie)' },/* 4: repair prose contradicts disk */
    { toolCalls: [{ name: 'fs.write', args: { path: 'song.txt', content: 'REPLANNED: survival of the fittest — Darwin 1859.' } }] }, /* 5: replan TOOL writes the REAL phrase */
    { text: 'New strategy: rewrote song.txt with the exact phrase survival of the fittest.' }, /* 6: replan prose matches disk */
    { text: 'SHOULD NEVER BE CONSUMED — a verified replan ends the loop.' },
  ]);
  resetCalls();
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'rplS', input: '1. write song.txt that contains the exact phrase "survival of the fittest"\n2. tell me it is done', emit: () => {}, capOverride: 1 });
  assert.equal(m.failCount, 0, JSON.stringify(m.textSummary));
  assert.equal(m.replannedCount, 1, 'the strategy-change attempt produced the evidence');
  assert.equal(lastCalls().filter((c) => c.key === 'sub:tasks').length, 6, 'exactly 1+1+2+2 worker calls');
  assert.match(m.textSummary.join('\n'), /contains "survival of the fittest", after replan\]/);
  const final = fs.readFileSync(path.join(ws, 'song.txt'), 'utf8');
  assert.ok(final.includes('survival of the fittest'), 'the DISK (not the prose) must carry the phrase');
  await rt.shutdown();
});

test('REPLAN KNOB: with replanRounds=0 a dead contract skips the strategy change entirely (respects the cap)', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-2c-knob-'));
  fs.writeFileSync(path.join(ws, 'song.txt'), 'Darwin was a naturalist.');
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
    mission: { limits: { repairRounds: 1, timeoutMs: 0, tokenBudget: 0, transientRetries: 1, replanRounds: 0 } },
  }, { persist: false });
  setScript('mission:compile', [{ text: JSON.stringify({ nodes: [{ id: 'p1', input: 'write song.txt that contains the exact phrase "survival of the fittest"', deps: [], estMs: 1000 }, { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 }] }) }]);
  setScript('sub:tasks', [
    { text: 'I wrote the phrase survival of the fittest into song.txt.' },
    { text: 'done done done.' },
    { text: 'Repair done: song.txt now says survival of the fittest. (lie)' },
    { text: 'SHOULD NEVER BE CONSUMED — replanRounds=0 forbids the strategy change.' },
  ]);
  resetCalls();
  const m = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'rplK', input: '1. write song.txt that contains the exact phrase "survival of the fittest"\n2. tell me it is done', emit: () => {}, capOverride: 1 });
  assert.equal(lastCalls().filter((c) => c.key === 'sub:tasks').length, 3, '1 initial + 1 trivial + 1 repair = 3; a replan would be #4');
  assert.match(m.textSummary.join('\n'), /\[LIMIT:RETRY\]/, 'without replan the honest failure keeps the LIMIT:RETRY marker');
  assert.ok(m.limitsHit.includes('retry'));
  assert.equal(m.replannedCount, 0);
  await rt.shutdown();
});

test('CARRY: changing the objective mid-flight keeps VERIFIED parts — they are never re-run and keep their provenance', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-2c-carry-'));
  fs.mkdirSync(path.join(ws, 'store'));
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(ws, 'store', f), f);
  const rt = await createRuntime({ channels: false, scheduler: false });
  rt.cfg.patch({
    models: { provider: 'demo', routes: { tasks: 'demo/demo-fast', tools: 'demo/demo-fast', chat: 'demo/demo-fast' } },
    providers: { demo: { kind: 'mock', apiKey: 'demo' } },
    guard: { mode: 'off' }, moa: { policy: 'off' }, workspace: ws,
  }, { persist: false });
  setScript('mission:compile', [
    { text: JSON.stringify({ nodes: [{ id: 'p1', input: 'report the number of files in store/', deps: [], estMs: 1000 }] }) },
    { text: JSON.stringify({ nodes: [{ id: 'p1', input: 'report the number of files in store/', deps: [], estMs: 1000 }, { id: 'p2b', input: 'say changed in three words, no more', deps: [], estMs: 1000 }] }) },
  ]);
  /* objective A: single-part run overcompile? compile forces min 2 nodes — so add p2 for A too */
  setScript('mission:compile', [
    { text: JSON.stringify({ nodes: [{ id: 'p1', input: 'report the number of files in store/', deps: [], estMs: 1000 }, { id: 'p2', input: 'say done in three words, no more', deps: [], estMs: 1000 }] }) },
    { text: JSON.stringify({ nodes: [{ id: 'p1', input: 'report the number of files in store/', deps: [], estMs: 1000 }, { id: 'p2b', input: 'say changed in three words, no more', deps: [], estMs: 1000 }] }) },
  ]);
  setScript('sub:tasks', [
    { text: 'There are 2 files in store/.' },
    { text: 'done done done.' },
    { text: 'changed changed changed.' },
    { text: 'SHOULD NEVER BE CONSUMED — carried parts cost zero calls.' },
  ]);
  resetCalls();
  const m1 = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'carS', input: '1. report the number of files in store/\n2. tell me it is done', emit: () => {}, capOverride: 1 });
  assert.equal(m1.verifiedCount, 1, JSON.stringify(m1.textSummary));
  /* objective changes: keep p1, replace p2 with p2b. carry the verified verdict. */
  const carry = { p1: { value: { text: 'There are 2 files in store/.' }, verified: true, verifiedSummary: m1.nodes ? m1.textSummary[0].match(/VERIFIED: ([^\]]+)\]/)?.[1] : 'store/ has 2 files (independently counted)' } };
  const m2 = await runMission({ cfg: rt.cfg, registry: rt.registry, session: 'carS', input: '1. report the number of files in store/\n2. now tell me something CHANGED instead', emit: () => {}, capOverride: 1, carry });
  const calls = lastCalls().filter((c) => c.key === 'sub:tasks').length;
  assert.equal(calls, 3, `p1 initial + p2 + p2b = 3; carrying p1 must cost ZERO new calls, got ${calls}`);
  assert.equal(m2.carriedCount, 1, JSON.stringify(m2.textSummary));
  assert.match(m2.textSummary.join('\n'), /carried from previous objective/);
  assert.match(m2.textSummary.join('\n'), /changed changed changed\./);
  await rt.shutdown();
});
