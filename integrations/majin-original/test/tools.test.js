/**
 * Registry + fil-/shellverktyg. Kör mot en tillfällig workspace, ingen nätverk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, Config, clone } from '../src/core/config.js';
import { ALL_TOOLS, buildRegistry } from '../src/core/tools/index.js';
import { levelFor, approvals, check } from '../src/core/guard.js';
import { globToRe, hexdump, resolveIn } from '../src/core/tools/files.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-tools-'));
process.env.MAJIN_HOME = home;
const WS = path.join(home, 'workspace');
fs.mkdirSync(WS, { recursive: true });

function make(t, patch = {}) {
  const cfg = new Config(clone(DEFAULTS), path.join(home, 'config.json'));
  cfg.save = () => true;
  cfg.patch({ workspace: WS, guard: { mode: 'off' }, ...patch });
  const ctx = { cfg, emit: () => {}, approvals, memory: null, skills: null, usage: null };
  const registry = buildRegistry(ctx);
  t.after(() => cfg.subs.clear?.());
  return { cfg, registry, ctx };
}

test('registry: every tool has a description, risk and JSON schema', () => {
  assert.ok(ALL_TOOLS.length >= 70, `för få verktyg: ${ALL_TOOLS.length}`);
  const names = ALL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'dubbletter i verktygsnamn');
  for (const t of ALL_TOOLS) {
    assert.ok(t.desc && t.desc.length > 20, `${t.name}: för kort desc`);
    assert.ok(['read', 'write', 'exec', 'destructive'].includes(t.risk), `${t.name}: risk ${t.risk}`);
    assert.equal(t.parameters.type, 'object', t.name);
    assert.ok(Array.isArray(t.parameters.required), t.name);
    for (const [k, spec] of Object.entries(t.raw)) assert.equal(typeof spec, 'string', `${t.name}.${k}`);
    assert.equal(typeof t.run, 'function', t.name);
  }
});

test('registry: unknown tools suggest the closest match, bad args are coerced', async (t) => {
  const { registry } = make(t);
  const bad = await registry.exec('fs.reed', { path: 'x' }, { session: 'test' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'unknown_tool');
  assert.match(bad.error.hint || '', /fs\.read/, 'borde föreslå fs.read');
  const fixed = await registry.exec('fs.read', { path: path.join(WS, 'finns-icke'), maxBytes: '400' }, { session: 'test' });
  assert.ok(fixed.ok === false);
  assert.equal(fixed.error.code, 'ENOENT', 'string numbers must coerce and the error be the real one');
});

test('registry: tool data reaches the filesystem (write → read → patch → grep → tar)', async (t) => {
  const { registry } = make(t);
  const file = path.join(WS, 'prov.txt');
  const w = await registry.exec('fs.write', { path: 'prov.txt', content: 'rad en\nrad två\nrad tre\n' }, { session: 'test' });
  assert.equal(w.ok, true, JSON.stringify(w.error));
  assert.equal(fs.readFileSync(file, 'utf8'), 'rad en\nrad två\nrad tre\n');
  const r = await registry.exec('fs.read', { path: 'prov.txt' }, { session: 'test' });
  assert.match(r.result, /rad två/);
  assert.match(r.result, /^\s+2 \|/m, 'radnummer ska finnas');
  const p = await registry.exec('fs.patch', { path: 'prov.txt', edits: [{ find: 'rad två', replace: 'RÄTTAD' }] }, { session: 'test' });
  assert.equal(p.ok, true, JSON.stringify(p.error));
  assert.match(fs.readFileSync(file, 'utf8'), /RÄTTAD/);
  const dry = await registry.exec('fs.patch', { path: 'prov.txt', edits: [{ find: 'rad en', replace: 'NY' }], dry: true }, { session: 'test' });
  assert.match(dry.result, /DRY-RUN/);
  assert.match(fs.readFileSync(file, 'utf8'), /rad en/, 'a dry run must not write');
  const miss = await registry.exec('fs.patch', { path: 'prov.txt', edits: [{ find: 'oväntat ord', replace: 'x' }] }, { session: 'test' });
  assert.equal(miss.ok, false);
  assert.match(miss.error.message, /found no/);
  const g = await registry.exec('fs.grep', { path: '.', pattern: 'RÄTTAD' }, { session: 'test' });
  assert.match(g.result, /prov\.txt/);
  const s = await registry.exec('fs.search', { path: '.', pattern: 'RÄTTAD' }, { session: 'test' });
  assert.match(s.result, /prov\.txt/);
  const mv = await registry.exec('fs.move', { from: 'prov.txt', to: 'under/prov2.txt' }, { session: 'test' });
  assert.equal(mv.ok, true, JSON.stringify(mv.error));
  assert.ok(fs.existsSync(path.join(WS, 'under', 'prov2.txt')));
  const cp = await registry.exec('fs.copy', { from: 'under/prov2.txt', to: 'under/kopia.txt' }, { session: 'test' });
  assert.equal(cp.ok, true);
  const tar = await registry.exec('fs.tar', { op: 'create', archive: 'backup.tar', path: 'under' }, { session: 'test' });
  assert.equal(tar.ok, true, JSON.stringify(tar.error));
  assert.ok(fs.existsSync(path.join(WS, 'backup.tar')));
});

test('fs.delete: refuses the workspace root and an empty path', async (t) => {
  const { registry } = make(t);
  const empty = await registry.exec('fs.delete', {}, { session: 'test' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'bad_args');
  const root = await registry.exec('fs.delete', { path: WS }, { session: 'test' });
  assert.equal(root.ok, false, JSON.stringify(root));
  assert.match(root.error.message + root.result, /rot|skydda|workspace|skydd/i);
  assert.ok(fs.existsSync(path.join(WS, 'under')), 'the workspace must survive');
  const single = await registry.exec('fs.delete', { path: 'under/kopia.txt', permanent: true }, { session: 'test' });
  assert.equal(single.ok, true, JSON.stringify(single.error));
  assert.ok(!fs.existsSync(path.join(WS, 'under', 'kopia.txt')));
});

test('guard: risk levels, neverOn and the approval queue', async (t) => {
  const { cfg, registry } = make(t);
  cfg.patch({
    guard: { mode: 'confirm', neverOn: [...(cfg.get('guard.neverOn') || []), '\\bmkfs\\b'] },
    tasks: { approvalTimeoutMs: 400 },
  });
  assert.equal(levelFor('fs.list', {}, cfg, 'read'), 'safe', 'reading must not need approval');
  assert.equal(levelFor('fs.write', { path: 'a.txt' }, cfg, 'write'), 'write');
  assert.equal(levelFor('fs.delete', { path: 'a.txt' }, cfg, 'write'), 'destructive');
  assert.equal(levelFor('shell.run', { command: 'bash -c "rm -rf /"' }, cfg, 'exec'), 'destructive', 'quotes must not launder a dangerous command');
  assert.equal(levelFor('shell.run', { command: 'rm -rf .' }, cfg, 'exec'), 'destructive');
  assert.equal(levelFor('shell.run', { command: 'dd if=/dev/zero of=/dev/sda' }, cfg, 'exec'), 'never', 'neverOn');
  assert.equal(levelFor('shell.run', { command: 'mkfs.ext4 /dev/sda1' }, cfg, 'exec'), 'never', 'anpassad neverOn');

  /*-confirm-läge: write går igenom utan fråga */
  const w = await registry.exec('fs.write', { path: 'ok.txt', content: '1' }, { session: 'guard-test' });
  assert.equal(w.ok, true, JSON.stringify(w.error));

  /* exec kräver beslut — avslaget ska verktyget stoppas och kön tömmas */
  const deniedP = registry.exec('shell.run', { command: 'echo hej' }, { session: 'guard-test' });
  await until(() => approvals.list().length > 0);
  assert.equal(approvals.list().length, 1, 'exactly one queue entry');
  assert.match(approvals.list()[0].reason, /command|approval|decision/i);
  assert.equal(approvals.respond(approvals.list()[0].id, false, 'test'), true);
  const denied = await deniedP;
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(approvals.list().length, 0, 'the queue must drain after a decision');

  /* godkänt beslut släpper igenom samma verktyg */
  const okP = registry.exec('shell.run', { command: 'echo hej' }, { session: 'guard-test' });
  await until(() => approvals.list().length > 0);
  approvals.respond(approvals.list()[0].id, true, 'ok');
  const okRun = await okP;
  assert.equal(okRun.ok, true, JSON.stringify(okRun.error));

  /* time utan svar = nej (inget evigt hängande) */
  const timeoutP = registry.exec('shell.run', { command: 'echo tyst' }, { session: 'guard-test' });
  const timeoutRun = await timeoutP;
  assert.equal(timeoutRun.ok, false, 'no decision inside the window means no run');
  assert.match(timeoutRun.error.message, /timeout|ingen beslut|avslog/i, JSON.stringify(timeoutRun.error));

  /* neverOn går aldrig in i kön */
  const blocked = await registry.exec('shell.run', { command: 'mkfs.ext4 /dev/sdb1' }, { session: 'guard-test' });
  assert.equal(blocked.ok, false);
  assert.equal(approvals.list().length, 0);
  assert.match(blocked.error.message, /neverOn|alltid/i);

  /* radering utanför workspace: skyddad rot, ingen kö */
  const outside = await registry.exec('fs.delete', { path: '/etc/passwd', permanent: true }, { session: 'guard-test' });
  assert.equal(outside.ok, false, JSON.stringify(outside));
  t.after(() => approvals.list().forEach((r) => approvals.respond(r.id, false, 'cleanup')));
});

async function until(fn, ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

test('shell.run: captures stdout, cwd and the timeout', async (t) => {
  const { registry } = make(t);
  const r = await registry.exec('shell.run', { command: 'echo hej-från-shell && pwd' }, { session: 'test' });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.match(r.result, /hej-från-shell/);
  const env = await registry.exec('shell.env', {}, { session: 'test' });
  assert.match(env.result, /shell|PATH|=/i);
  const to = await registry.exec('shell.run', { command: 'sleep 5', timeoutSec: 1 }, { session: 'test' });
  assert.ok(to.ok === false || /timeout|time/i.test(String(to.result) + String(to.error?.message || '')), JSON.stringify(to));
});

test('resolveIn + globToRe + hexdump', () => {
  const ctx = { cfg: { get: () => WS } };
  assert.equal(resolveIn(ctx, 'a.txt').abs, path.join(WS, 'a.txt'));
  assert.equal(resolveIn(ctx, path.join(WS, 'b.txt')).outside, false);
  assert.equal(resolveIn(ctx, '../../etc/passwd').outside, true);
  const err = (() => {
    try {
      resolveIn(ctx, '');
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err && err.code === 'bad_args', 'an empty path must be refused');
  assert.ok(globToRe('*.js').test('x.js'), 'ändat mönster');
  assert.equal(globToRe('*.js').test('x.mjs'), false);
  assert.equal(globToRe('*.js').test('a/x.js'), false, '* får inte korsa sökväg');
  assert.ok(globToRe('**/*.txt').test('a/b/c.txt'), '** måste korsa mappar');
  const BS = String.fromCharCode(92);
  assert.ok(globToRe('build' + BS + '?et').test('build' + BS + 'bet'), 'the pattern must tolerate Windows separators');
  assert.ok(globToRe('src/**/*.js').test('src/a/b/c.js'), 'mönster i mitten');
  const hx = hexdump(Buffer.from('MZ\u0090\u0000hej världen 1234567890'));
  assert.match(hx, /^0{8} /m, 'hexdump starts at offset 0');
  assert.match(hx, /4d 5a/);
});


test('shell.run reports real command failure rather than pretending Blender or scripts succeeded', async (t) => {
  const { registry } = make(t);
  const ok = await registry.exec('shell.run', { command: 'node -e "process.exit(0)"' }, { session: 'shell-ok' });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.meta.exitCode, 0);
  const failed = await registry.exec('shell.run', { command: 'node -e "process.exit(7)"' }, { session: 'shell-fail' });
  assert.equal(failed.ok, false, 'a failed external app must never look like a successful MAJIN action');
  assert.notEqual(failed.meta.exitCode, 0, 'PowerShell and bash may normalize different nonzero codes');
  assert.equal(failed.error.code, 'shell_exit_nonzero');
});
