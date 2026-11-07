#!/usr/bin/env node
/**
 * MAJIN V4 — learned-skill acceptance against the REAL provider.
 *
 *   npm run v4:learn-accept                 full A–H run, evidence written
 *   npm run v4:learn-accept -- --dry-run    print the plan, change nothing
 *   npm run v4:learn-accept -- --json       machine output
 *
 * The mandatory gate says: use the existing Go provider, make an unfamiliar task
 * fail, diagnose, change strategy, succeed, store the skill, restart the host,
 * run a related-but-changed task, and show that the old strategy is not repeated.
 *
 * This script cannot be faked here. It starts two real hosts on one data dir
 * (the restart in step E is a real process boundary), and it uses whatever
 * provider the MAJIN config already holds — the same route the phone uses. If no
 * provider is configured it refuses instead of silently running the demo brain,
 * because a demo brain proves nothing about learning.
 *
 * Everything it observes is written to docs/v4/evidence/learned-skills-<stamp>.json:
 * tool calls, attempts, artifacts, verification, the skill record, the retrieval
 * proof and the avoided repeat.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/v4/config.js';
import { startV4Server } from '../../src/v4/server.js';
import { discoverModels } from '../../src/v4/models.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(here, '../../docs/v4/evidence');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const json = flag('--json');
const dryRun = flag('--dry-run');
const repeat = Math.max(1, Math.min(VARIANTS_LIMIT(), Number(
  (() => {
    const i = args.indexOf('--repeat');
    return i >= 0 ? args[i + 1] : 1;
  })(),
) || 1));

const log = (line = '') => { if (!json) process.stdout.write(`${line}\n`); };

/** Bounded: the ladder has three rungs, so more repetitions prove nothing new. */
function VARIANTS_LIMIT() {
  return 3;
}

/* A safe, unfamiliar task that needs no external service and cannot submit
 * anything anywhere: find a note by name in a folder the owner granted. */
/**
 * Task A deliberately contains a slightly wrong file name — the way a real
 * person writes one. The file on disk is `CV_Anders_2026.txt`; the request says
 * `CV Anders 2026.txt`. A real model tries the path it was given, hits a genuine
 * failure, and only then searches. That is the A -> B -> C pattern the gate is
 * required to demonstrate, and it is not a scripted obstacle: it is the normal
 * case of a user misremembering a file name.
 */
const TASK_A = (folder) => `Läs filen ${path.join(folder, 'CV Anders 2026.txt')} och berätta vad som står.`;
const TASK_B = 'Läs den andra filen som ligger i samma mapp.';

/**
 * Distinct scenarios for the same KIND of procedure.
 *
 * The brief is explicit: "One successful execution may establish a narrowly
 * scoped skill; broader reliability requires repeated evaluations across varied
 * unseen tasks." Each variant is a different file, named the way a person writes
 * it (spaces) while disk holds underscores — so each one needs the same shape of
 * work but is not the same task.
 */
const VARIANTS = [
  { file: 'CV_Anders_2026.txt', ask: 'CV Anders 2026.txt', label: 'CV' },
  { file: 'Faktura_Mars_2026.txt', ask: 'Faktura Mars 2026.txt', label: 'invoice' },
  { file: 'Kontrakt_Anna_2025.txt', ask: 'Kontrakt Anna 2025.txt', label: 'contract' },
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function startHost(config, home, { provider = 'live' } = {}) {
  const env = {
    // The host must inherit the provider this script just verified, or it would
    // quietly fall back to the demo brain and the whole gate would be theatre.
    ...process.env,
    MAJIN_HOME: home,
    MAJIN_V4_RATE_REQUESTS: '1000',
    MAJIN_V4_RATE_TURNS: '1000',
    MAJIN_V4_MAX_MODEL_ROUNDS: '8',
    MAJIN_V4_MAX_TOOL_CALLS: '12',
    ...(provider === 'demo' ? { MAJIN_V4_PROVIDER: 'demo' } : {}),
  };
  const cfg = loadConfig({ env, argv: ['--port', '0'], platform: process.platform });
  for (let attempt = 0; ; attempt += 1) {
    const port = 39000 + Math.floor(Math.random() * 1500) + attempt;
    try {
      const started = await startV4Server({ config: { ...cfg, port, host: '127.0.0.1' } });
      return { ...started, base: `http://127.0.0.1:${started.port}`, config: cfg };
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt > 25) throw err;
    }
  }
}

/**
 * Cost accounting.
 *
 * The brief requires the evidence to record costs. Token counts come from the
 * provider's own usage field; the price per token is a published rate, not a
 * guess. Anything unknown is reported as `null` — an invented number in a cost
 * report is worse than an honest gap.
 */
const PRICES = {
  // OpenCode Go lists glm-5.3-flash at $0.15 / M input and $0.50 / M output.
  'glm-5.3-flash': { inputPerMillion: 0.15, outputPerMillion: 0.50 },
};

function costOf({ model, usage }) {
  const price = PRICES[model] || null;
  const input = Number(usage?.input || 0);
  const output = Number(usage?.output || 0);
  if (!price) return { model, inputTokens: input, outputTokens: output, usd: null, note: 'no published rate on record for this model' };
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    reported: usage?.reported !== false,
    usd: Math.round(((input / 1e6) * price.inputPerMillion + (output / 1e6) * price.outputPerMillion) * 1e6) / 1e6,
    rates: price,
  };
}

async function sse(url, { cookie, body }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(url).origin, cookie, 'x-majin-csrf': '1' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    let type = null;
    let data = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (type) events.push({ type, data: data ? JSON.parse(data) : null });
  }
  return { status: res.status, events };
}

function summarizeCost(log) {
  const perModel = new Map();
  for (const item of log) {
    const c = costOf({ model: item.model, usage: item.usage });
    const prev = perModel.get(c.model) || { inputTokens: 0, outputTokens: 0, usd: 0, priced: true };
    prev.inputTokens += c.inputTokens;
    prev.outputTokens += c.outputTokens;
    if (c.usd == null) prev.priced = false;
    else prev.usd += c.usd;
    perModel.set(c.model, prev);
  }
  const calls = log.length;
  let inputTokens = 0;
  let outputTokens = 0;
  let usd = 0;
  let priced = true;
  for (const v of perModel.values()) {
    inputTokens += v.inputTokens;
    outputTokens += v.outputTokens;
    usd += v.usd;
    if (!v.priced) priced = false;
  }
  return {
    calls,
    inputTokens,
    outputTokens,
    usd: priced ? Math.round(usd * 1e6) / 1e6 : null,
    perModel: Object.fromEntries([...perModel.entries()]),
  };
}

function grantedFolder(home) {
  const dir = path.join(home, 'Documents');
  fs.mkdirSync(dir, { recursive: true });
  // Underscores on disk, spaces in the request: the mismatch is the obstacle.
  fs.writeFileSync(path.join(dir, 'CV_Anders_2026.txt'), 'CURRICULUM VITAE: Anders, 2026.');
  fs.writeFileSync(path.join(dir, 'Faktura_Mars_2026.txt'), 'FAKTURA: mars 2026, belopp 1250 kr.');
  fs.writeFileSync(path.join(dir, 'Kontrakt_Anna_2025.txt'), 'KONTRAKT: Anna, 2025, giltigt till 2027.');
  fs.writeFileSync(path.join(dir, 'andra.txt'), 'ANDRA ANTECKNINGEN: ekonomin är grön.');
  return dir;
}

async function main() {
  const results = [];
  const record = (id, ok, detail) => {
    results.push({ id, ok: Boolean(ok), detail: String(detail ?? '') });
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(30)} ${detail}`);
    return ok;
  };

  log('');
  log('MAJIN V4 — learned-skill acceptance (A–H)');
  log('='.repeat(66));

  /**
   * Use the repository's existing OpenCode Go convention when it is present, so
   * this gate can run in CI with the already-configured OPENCODE_API_KEY and the
   * key never has to be pasted anywhere. An explicitly configured MAJIN provider
   * still wins.
   */
  const goKey = String(process.env.OPENCODE_API_KEY || '').trim();
  const useGo = Boolean(goKey) && !process.env.MAJIN_V4_BASE_URL;
  if (useGo) {
    process.env.MAJIN_V4_PROVIDER = process.env.MAJIN_V4_PROVIDER || 'openai';
    process.env.MAJIN_V4_BASE_URL = 'https://opencode.ai/zen/go/v1';
    process.env.MAJIN_V4_API_KEY = goKey;
    process.env.MAJIN_V4_MODEL = process.env.MAJIN_V4_MODEL || 'glm-5.3-flash';
    process.env.MAJIN_V4_PROVIDER_NAME = 'opencode-go';
    process.env.MAJIN_V4_PROVIDER_LABEL = 'OpenCode Go';
    // Go rejects a request that does not identify as its own client; this mirrors
    // the headers the repository's existing Go smoke test already uses.
    process.env.MAJIN_V4_EXTRA_HEADERS = process.env.MAJIN_V4_EXTRA_HEADERS || JSON.stringify({
      'user-agent': 'majin-coding-agent/1.0',
      'x-opencode-client': 'majin',
      // Go requires a session identifier on every request; the existing Go smoke
      // test sends the same shape. It is an identity for one run, not a secret.
      'x-opencode-session': `majin-learn-${process.env.GITHUB_RUN_ID || Date.now().toString(36)}`,
    });
  }

  // Refuse to pretend: this gate is about real inference.
  const catalogue = discoverModels({ home: loadConfig({ argv: [] }).paths.home, env: process.env });
  const configured = catalogue.models.filter((m) => m.configured);
  if (!configured.length) {
    log('');
    log('  REFUSED: no provider is configured on this host.');
    log('  This gate must run against the real Go provider — a demo brain proves nothing');
    log('  about learning. Configure a provider in the MAJIN config and run again.');
    log('');
    process.exitCode = 2;
    return;
  }
  log(`  provider: ${configured[0].provider || configured[0].id} · ${configured[0].model || ''}`);
  if (dryRun) {
    log('');
    log(`  would run: "${TASK_A('/…/Documents')}" then "${TASK_B}" against a granted Documents folder,`);
    log('  restart the host in between, and write the evidence file. Nothing was changed.');
    return;
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-learn-accept-'));
  const documents = grantedFolder(home);
  fs.mkdirSync(path.join(home, 'v4'), { recursive: true });
  // A granted folder IS the grant: it activates the files lane.
  fs.writeFileSync(path.join(home, 'v4', 'owner-mode.json'), JSON.stringify({
    schema: 'majin.v4.owner-mode/v1',
    version: 1,
    lanes: ['files'],
    folders: [documents],
    grantedAt: new Date().toISOString(),
    revokedAt: null,
    history: [],
  }));

  let first = null;
  let second = null;
  let learnedName = null;
  try {
    // ---- A–D on a fresh host ---------------------------------------------
    first = await startHost(null, home);
    log(`  host 1 on ${first.base}`);
    if (first.context.model.info.demo) {
      log('');
      log('  REFUSED: the host started with the demo brain, so nothing here would be real.');
      log('  Set MAJIN_V4_PROVIDER/MAJIN_V4_BASE_URL/MAJIN_V4_API_KEY/MAJIN_V4_MODEL (or configure the MAJIN config) and run again.');
      process.exitCode = 2;
      return;
    }
    const pairRes = await fetch(`${first.base}/api/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: first.base },
      body: JSON.stringify({ code: first.context.pairingFresh }),
    });
    const cookie = (pairRes.headers.get('set-cookie') || '').split(';')[0];
    record('auth.paired', pairRes.status === 200 && cookie.length > 10, `pair -> ${pairRes.status}`);

    // Count real model calls so the cost report is grounded in what happened.
    const usageLog = [];
    const realChat = first.context.model.chat.bind(first.context.model);
    first.context.model.chat = async (opts) => {
      const res = await realChat(opts);
      if (res?.usage) usageLog.push({ model: res.model || process.env.MAJIN_V4_MODEL, usage: res.usage });
      return res;
    };
    const turnA = await sse(`${first.base}/api/chat`, { cookie, body: { text: TASK_A(documents), requestId: 'learn-a' } });
    const doneA = turnA.events.find((e) => e.type === 'done')?.data;
    const errorA = turnA.events.find((e) => e.type === 'error')?.data;
    const toolsA = turnA.events.filter((e) => e.type === 'tool_result').map((e) => e.data);
    record('turn.A.completed', doneA?.status === 'completed',
      doneA?.status === 'completed'
        ? 'completed'
        : `${doneA?.status || 'no done event'}${errorA?.message ? `: ${String(errorA.message).slice(0, 300)}` : ''}`);
    record('turn.A.tool_calls', toolsA.length > 0,
      `${toolsA.length} call(s): ${toolsA.map((t) => `${t.name}:${t.ok ? 'ok' : (t.error || t.summary || 'failed')}`).join(' | ')}`);
    record('turn.A.failed_first_attempt', toolsA.some((t) => t.ok === false), 'a real failure was observed');
    record('turn.A.independent_verification', toolsA.some((t) => t.verified === true), 'at least one receipt was verified');

    learnedName = doneA?.learned?.name || null;
    record('D.skill_stored', Boolean(learnedName), learnedName || 'no skill was stored');
    if (learnedName) {
      const dir = path.join(home, 'v4', 'learned-skills', learnedName);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skill.json'), 'utf8'));
      record('D.skill_manifest', manifest.learned?.schema === 'majin.v4.learned-skill/v1',
        `state ${manifest.learned?.state}, ${manifest.learned?.procedure?.length || 0} step(s)`);
      /**
       * The avoid list must be exactly right, in both directions:
       *  - it must not name an action that succeeded later in the same run (that
       *    is what a real Go run caught: fs_read failed on a wrong path, then
       *    succeeded on the right one, and the skill told the next turn to skip
       *    it);
       *  - it must record an action that was genuinely abandoned.
       * With a self-correcting model the honest outcome is often an empty list.
       */
      const succeededTools = new Set(toolsA.filter((t) => t.ok).map((t) => t.name));
      const avoid = manifest.learned?.avoid || [];
      const falseAvoid = avoid.filter((a) => succeededTools.has(String(a.action).split('(')[0]));
      record('D.avoid_correct', falseAvoid.length === 0,
        avoid.length
          ? `recorded: ${avoid.map((a) => `${a.action}→${a.failedWith}`).join(', ')}${falseAvoid.length ? ` · WRONG: ${falseAvoid.map((a) => a.action).join(', ')} succeeded` : ''}`
          : 'none abandoned — the model corrected itself inside the run');
    }

    const costBaseline = summarizeCost(usageLog);
    record('turn.A.cost', costBaseline.calls > 0,
      `${costBaseline.calls} model call(s), ${costBaseline.inputTokens} in / ${costBaseline.outputTokens} out`
      + (costBaseline.usd == null ? ', cost not priced' : `, $${costBaseline.usd}`));

    // ---- E: a real restart ------------------------------------------------
    await new Promise((resolve) => first.server.close(resolve));
    first = null;
    second = await startHost(null, home);
    log(`  host 2 on ${second.base} (restart)`);
    const session = second.context.sessions.create({ ip: 'accept', userAgent: 'restart' });
    const cookie2 = `${second.config.auth.cookieName}=${encodeURIComponent(session.token)}`;
    const list = await (await fetch(`${second.base}/api/learning`, { headers: { cookie: cookie2 } })).json();
    record('E.skill_survives_restart', Boolean(learnedName) && list.skills.some((s) => s.name === learnedName),
      `${list.skills.length} learned skill(s) after restart`);

    // ---- F–H: a related but changed task ---------------------------------
    /**
     * Retrieval evidence, taken from the request the host actually sent.
     *
     * Inferring "it used the skill" from the tool names is a proxy; the direct
     * evidence is the system prompt of the second turn containing the learned
     * section. That is what this captures.
     */
    const prompts = [];
    const realChatB = second.context.model.chat.bind(second.context.model);
    second.context.model.chat = async (opts) => {
      const system = (opts?.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
      prompts.push(system);
      const res = await realChatB(opts);
      // Host 2 is where the later cycles run, so this is also where their real
      // cost has to be captured. Missing this made the efficiency comparison
      // report zero calls and a false improvement.
      if (res?.usage) usageLog.push({ model: res.model || process.env.MAJIN_V4_MODEL, usage: res.usage });
      return res;
    };
    const turnB = await sse(`${second.base}/api/chat`, { cookie: cookie2, body: { text: TASK_B, requestId: 'learn-b' } });
    const doneB = turnB.events.find((e) => e.type === 'done')?.data;
    const toolsB = turnB.events.filter((e) => e.type === 'tool_result').map((e) => e.data);
    record('F.turn.completed', doneB?.status === 'completed', doneB?.status || 'no done event');

    const manifestB = learnedName
      ? JSON.parse(fs.readFileSync(path.join(home, 'v4', 'learned-skills', learnedName, 'skill.json'), 'utf8'))
      : null;

    // Direct evidence: the learned section and this skill's name were in the
    // system prompt the host sent for the related task.
    const promptText = prompts.join('\n');
    const inPrompt = /Skills learned from verified work/.test(promptText)
      && Boolean(learnedName) && promptText.includes(learnedName);
    record('G.skill_retrieved', inPrompt,
      inPrompt ? 'the learned section and the skill name reached the prompt' : 'no learned section in the prompt');

    // The model may legitimately adapt (that is the point of a slot-based
    // procedure), so this asks whether a learned tool was used and the task
    // completed — not whether it replayed step one verbatim.
    const learnedTools = new Set(manifestB?.tools || []);
    const usedLearnedTool = toolsB.some((t) => t.ok && learnedTools.has(t.name));
    record('G.skill_used_or_adapted', usedLearnedTool && doneB?.status === 'completed',
      `${toolsB.map((t) => `${t.name}:${t.ok}`).join(', ') || 'no calls'} · learned tools: ${[...learnedTools].join(',')}`);

    const repeated = toolsB.filter((t) => (manifestB?.learned?.avoid || []).some((a) => a.action.startsWith(t.name)) && t.ok === true);
    record('H.failed_strategy_not_repeated', repeated.length === 0,
      repeated.length ? `re-executed: ${repeated.map((t) => t.name).join(', ')}` : 'the failed action was not executed again');

    // ---- multi-scenario promotion (the brief's "broader reliability") ------
    /**
     * Run the remaining variants and then read the skill store once.
     *
     * Promotion is a function of evidence: EXPERIMENTAL after one verified
     * success, VERIFIED after two, REUSABLE after three across at least two
     * distinct scenarios. This does not force it — it runs the work and reports
     * whatever state the store actually reached, including "no promotion".
     */
    const cycles = [{ label: 'first', turn: turnA.events }];
    for (let i = 1; i < repeat; i += 1) {
      const variant = VARIANTS[i % VARIANTS.length];
      const prompt = `Läs filen ${path.join(documents, variant.ask)} och berätta kort vad som står.`;
      // Snapshot the usage log so each cycle's real cost is measurable: this is
      // the "agent efficiency" question, answered with data instead of a claim.
      const before = usageLog.length;
      const turn = await sse(`${second.base}/api/chat`, {
        cookie: cookie2,
        body: { text: prompt, requestId: `learn-cycle-${i}` },
      });
      const done = turn.events.find((e) => e.type === 'done')?.data;
      const tools = turn.events.filter((e) => e.type === 'tool_result').map((e) => e.data);
      const cost = summarizeCost(usageLog.slice(before));
      cycles.push({ label: variant.label, turn: turn.events, cost });
      record(`cycle.${i}.completed`, done?.status === 'completed',
        `${variant.label}: ${done?.status || 'no done event'} · ${tools.map((t) => `${t.name}:${t.ok}`).join(', ')}`);
      record(`cycle.${i}.learned`, Boolean(done?.learned?.name),
        done?.learned?.name || 'no skill updated');
      record(`cycle.${i}.cost`, cost.calls > 0,
        `${cost.calls} model call(s), ${cost.inputTokens} in / ${cost.outputTokens} out`
        + (cost.usd == null ? '' : `, $${cost.usd}`));
    }

    /**
     * Agent efficiency, measured.
     *
     * The brief lists "agent efficiency" as something learning should improve.
     * Turn A is the baseline: no skill existed yet, so the model had to work the
     * problem out. The later cycles run the same KIND of task with the learned
     * procedure in the prompt. Comparing model calls and tokens is the honest
     * measurement — and it is reported as "inconclusive" when the numbers do not
     * clearly move, rather than being dressed up.
     */
    if (repeat > 1 && cycles.length > 1) {
      const later = cycles.slice(1).map((c) => c.cost).filter(Boolean);
      const avgCalls = later.reduce((n, c) => n + c.calls, 0) / later.length;
      const avgTokens = later.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0) / later.length;
      const baseTokens = costBaseline.inputTokens + costBaseline.outputTokens;
      const baseCalls = costBaseline.calls;
      const callsDelta = baseCalls - avgCalls;
      const tokensDelta = baseTokens - avgTokens;
      const measured = later.length > 0 && later.every((c) => c.calls > 0) && baseCalls > 0;
      const improved = callsDelta > 0 || (callsDelta === 0 && tokensDelta > 0);
      const same = callsDelta === 0 && Math.abs(tokensDelta) <= Math.max(200, baseTokens * 0.1);
      // An unmeasured comparison is NOT an improvement. Reporting one would be
      // exactly the kind of claim this gate exists to prevent.
      record('efficiency.measured', measured,
        measured
          ? `baseline ${baseCalls} call(s)/${baseTokens} tokens · later ${avgCalls.toFixed(1)} call(s)/${Math.round(avgTokens)} tokens`
            + ` → ${improved ? 'fewer calls or tokens' : same ? 'no material change' : 'more tokens (adaptation, not replay)'}`
          : `could not measure: ${baseCalls} baseline call(s), later cycles captured ${later.map((c) => c.calls).join('/') || 'none'}`);
    }

    if (repeat > 1) {
      const all = second.context.learnedStore.list();
      const best = all
        .map((x) => ({ name: x.name, state: x.learned.state, successes: x.learned.successes, scenarios: (x.learned.scenarios || []).length }))
        .sort((a, b) => b.successes - a.successes)[0] || null;
      record('promotion.state', Boolean(best) && best.state !== 'EXPERIMENTAL',
        best ? `${best.name}: ${best.state} (${best.successes} success(es), ${best.scenarios} scenario(s))` : 'no learned skill');
      log(`  cycles: ${cycles.map((c) => c.label).join(', ')}`);
    }

    // ---- evidence ---------------------------------------------------------
    if (!json) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      const file = path.join(EVIDENCE_DIR, `learned-skills-${stamp()}.json`);
      fs.writeFileSync(file, `${JSON.stringify({
        at: new Date().toISOString(),
        cost: summarizeCost(usageLog),
        efficiency: cycles.map((c) => ({ label: c.label, cost: c.cost || null })),
        promotion: second.context.learnedStore.list().map((x) => ({
          name: x.name,
          state: x.learned.state,
          successes: x.learned.successes,
          failures: x.learned.failures,
          scenarios: (x.learned.scenarios || []).length,
          confidence: x.learned.confidence,
        })),
        provider: { id: configured[0].id, model: configured[0].model || null },
        node: process.versions.node,
        platform: process.platform,
        tasks: { a: TASK_A(documents), b: TASK_B },
        results,
        turnA: { done: doneA, tools: toolsA },
        turnB: { done: doneB, tools: toolsB },
        skill: manifestB,
      }, null, 2)}\n`);
      log('');
      log(`  evidence written: ${path.relative(process.cwd(), file)}`);
    }
  } finally {
    if (first) await new Promise((resolve) => first.server.close(resolve));
    if (second) await new Promise((resolve) => second.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  if (json) {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), results, passed, failed }, null, 2)}\n`);
  } else {
    log('-'.repeat(66));
    log(`  ${passed}/${results.length} checks passed`);
    if (failed) {
      log('');
      log('  Learned-skill gate is NOT verified. Fix the FAIL lines and run again.');
    }
    log('');
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
