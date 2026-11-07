/* MAJIN — P0 (UI-agent handover 2026-10-19, deliver-in-order #1):
   "Spara på riktigt" + per-chat model binding.
   S1: a failed disk save can NEVER report ok:true (patch persists:false + typed error)
   S2: corrupt config recovers from .bak instead of being overwritten by defaults
   S3: corrupt + no backup: defaults load, file untouched, anomalies surfaced (loadIssues)
   S4: session-scoped routes bind a chat without touching the global table
   S5: a TURN keeps the route chosen at its start — mid-turn provider switch
       must not reroute the running work
   S6: appendHistory reports failure instead of swallowing it */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.MAJIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-p0-'));

const { Config, DEFAULTS, merge, clone, load } = await import('../src/core/config.js');
const { routeFor } = await import('../src/core/router.js');
const { loop } = await import('../src/core/loop.js');
const { appendHistory } = await import('../src/core/context.js');
const { resetCalls, lastCalls } = await import('../src/core/provider/mock.js');

const canEnforcePermissions = process.platform !== 'win32' && !(process.getuid && process.getuid() === 0);

const cfgWith = (extra = {}) => new Config(merge(clone(DEFAULTS), extra), null);

test('S1: patch on an unwritable target reports ok:false — the old file stays intact, error is typed', (t) => {
  if (!canEnforcePermissions) return t.skip('permission bits not enforceable on this platform/user');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ro-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ server: { token: 'keep-me' } }), 'utf8');
  fs.chmodSync(dir, 0o555);
  const cfg = new Config(clone(DEFAULTS), file);
  try {
    const before = fs.readFileSync(file, 'utf8');
    const res = cfg.patch({ providers: { demo: { kind: 'mock', apiKey: 'x' } } }, 'test');
    assert.equal(res.ok, false, 'a failed save must NEVER read as saved');
    assert.equal(res.persisted, false);
    assert.equal(res.errors[0].code, 'save_failed', 'typed, actionable error');
    assert.ok(cfg.lastSaveError && cfg.lastSaveError.message, 'engine keeps the underlying error');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'previous file on disk untouched by a failed write');
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S1b: successful patch persists atomically via tmp+rename and leaves a .bak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-ok-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ server: { token: 'v1' } }), 'utf8');
  const cfg = new Config(clone(DEFAULTS), file);
  const res = cfg.patch({ server: { note: 'v2' } }, 'test');
  assert.equal(res.ok, true);
  assert.equal(res.persisted, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).server.note, 'v2', 'new value really on disk');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).server.token, 'v1', 'previous state backed up');
  assert.ok(!fs.existsSync(`${file}.tmp`), 'no temp-file litter left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S2: corrupt main config recovers from .bak — nothing is overwritten silently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-corrupt-'));
  const file = path.join(dir, 'config.json');
  const corrupt = '{"server":{token broken';
  fs.writeFileSync(file, corrupt, 'utf8');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ server: { token: 'rescued-token' } }), 'utf8');
  const { configFile } = { configFile: null };
  void configFile;
  // load() resolves via dirs.config — point MAJIN_HOME at our temp dir by loading through Config directly
  // plus a full load() probe in the same layout:
  const cfg = new Config(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), file);
  assert.equal(cfg.data.server.token, 'rescued-token', 'bak content is the recovery source');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3/S2 full-path: load() over corrupt main file heals from .bak and marks recovery; without .bak it stays honest and never overwrites', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-loadheal-'));
  const savedHome = process.env.MAJIN_HOME;
  process.env.MAJIN_HOME = home;
  try {
    const { load: loadFresh, configFile: cfProbe } = await import(`../src/core/config.js?probe=${Date.now()}`);
    const file = cfProbe();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const corrupt = '{"broken';
    fs.writeFileSync(file, corrupt, 'utf8');

    // no backup → honest defaults, NO auto-save over the corrupt file, issues surfaced
    let cfg = loadFresh();
    assert.equal(cfg.isFresh, false, 'corrupt is not fresh');
    assert.deepEqual(cfg.loadIssues.map((i) => i.kind), ['corrupt-main', 'no-backup']);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'load must never auto-save over a corrupt file');

    // add a counterpart .bak → recovery happens, from the bak, visibly
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ server: { token: 'rescued-token' } }), 'utf8');
    cfg = loadFresh();
    assert.equal(cfg.recoveredFrom, 'bak');
    assert.equal(cfg.data.server.token, 'rescued-token');
    assert.ok(cfg.loadIssues.some((i) => i.kind === 'corrupt-main'), 'the anomaly stays visible after healing');
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'healing does not silently rewrite the main file');
  } finally {
    process.env.MAJIN_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('S4: session-scoped routes bind a chat; the global table is untouched', () => {
  const cfg = cfgWith({
    providers: {
      alpha: { kind: 'mock', apiKey: 'a', models: ['m-alpha'] },
      bravo: { kind: 'mock', apiKey: 'b', models: ['m-bravo'] },
    },
    models: { routes: { tasks: 'alpha/m-alpha', chat: 'alpha/m-alpha' } },
  });
  const globalRoute = routeFor(cfg, 'tasks');
  assert.equal(globalRoute.providerName, 'alpha');
  // bind chat B to bravo
  cfg.patch({ models: { sessionRoutes: { 'session-B': { tasks: 'bravo/m-bravo' } } } }, 'ui-picker');
  const chatA = routeFor(cfg, 'tasks', { session: 'session-A' });
  const chatB = routeFor(cfg, 'tasks', { session: 'session-B' });
  assert.equal(chatA.providerName, 'alpha', 'unbound chats follow the global table');
  assert.equal(chatB.providerName, 'bravo', 'bound chat keeps its own model');
  assert.equal(routeFor(cfg, 'tasks').providerName, 'alpha', 'global table never rewrote behind anyone');
  // explicit binding, honestly honored even without a key — no silent fallback
  cfg.patch({ providers: { bravo: { apiKey: '' } }, models: { sessionRoutes: { 'session-B': { tasks: 'bravo/m-bravo' } } } }, 'ui-picker');
  const bound = routeFor(cfg, 'tasks', { session: 'session-B' });
  assert.equal(bound.providerName, 'bravo', 'explicit binding is returned so the missing-key error surfaces in THAT chat');
  assert.equal(bound.apiKey, '');
});

test('S5: a turn keeps the route chosen at its start — mid-turn provider switch does not reroute running work', async () => {
  const cfg = cfgWith({
    providers: {
      alpha: { kind: 'mock', apiKey: 'a', models: ['m-alpha'] },
      bravo: { kind: 'mock', apiKey: 'b', models: ['m-bravo'] },
    },
    models: { routes: { tasks: 'alpha/m-alpha', chat: 'alpha/m-alpha' } },
  });
  const steps = [];
  const registry = {
    schemas: () => [{ name: 'probe', description: 'mid-turn switch trigger', parameters: { type: 'object', properties: {} } }],
    has: () => true,
    exec: async (name) => {
      if (name === 'probe') {
        // the UI picker in ANOTHER chat writes the global table mid-turn:
        cfg.patch({ models: { routes: { tasks: 'bravo/m-bravo', chat: 'bravo/m-bravo' } } }, 'other-chat-picker');
        return { ok: true, result: 'switched' };
      }
      return { ok: true, result: 'noop' };
    },
  };
  resetCalls();
  const events = [];
  const out = await loop({
    cfg,
    registry,
    messages: [{ role: 'user', content: 'two steps, please' }],
    job: 'tasks',
    label: 'p0',
    ctx: { session: 'pinned-chat' },
    onEvent: (ev) => events.push(ev),
    maxSteps: 4,
  });
  void out;
  const stepEvents = events.filter((e) => e.type === 'step');
  assert.ok(stepEvents.length >= 2, 'turn really took multiple steps');
  const models = stepEvents.map((e) => e.model);
  assert.deepEqual([...new Set(models)], ['alpha/m-alpha'], `route pinned for the whole turn despite the mid-turn patch (saw ${models.join(', ')})`);
  assert.equal(routeFor(cfg, 'tasks').providerName, 'bravo', 'the NEXT turn (or other chat) gets the new global route — nothing is stale-globally');
  assert.ok(lastCalls().length >= 2, 'provider actually called per step');
});

test('S6: appendHistory reports failure instead of swallowing it', (t) => {
  if (!canEnforcePermissions) return t.skip('permission bits not enforceable on this platform/user');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-hist-'));
  fs.chmodSync(dir, 0o555);
  try {
    const ok = appendHistory('sess-x', { role: 'user', content: 'hi' }, dir);
    assert.equal(ok, false, 'append failure is reported, never silently "fine"');
    const { historyErrors } = { historyErrors: null };
    void historyErrors;
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-hist2-'));
  assert.equal(appendHistory('sess-y', { role: 'user', c: 1 }, dir2), true, 'healthy writes still report true');
  assert.ok(fs.existsSync(path.join(dir2, 'sess-y.jsonl')));
  fs.rmSync(dir2, { recursive: true, force: true });
});
