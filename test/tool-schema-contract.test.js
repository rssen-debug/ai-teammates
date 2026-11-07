import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS } from '../src/core/tools/index.js';
import { def, toSchema } from '../src/core/tools/registry.js';

/** R1-låset (Fas 1, rotorsak d04/s18/b01, uppmätt mot installerad v1.0.0):
 *  ett verktygs required-mängd är DATA vid deklarationen — aldrig programtext.
 *  Före reparationen 2026-10-20 låste paketerad exe scheman källan inte kände
 *  (shell.run→[], fs.write→'append', browser.open→'headless'). */
const OPT = /\((optional|opt)\b/i;
const OPTSTR = (d) => OPT.test(String(d || '')) || String(d || '').includes('(default') || /\?/.test(String(d || '').split(':')[0] || '');

test('registry: required är data från markörer — aldrig position eller programtext', () => {
  const bad = [];
  for (const t of ALL_TOOLS) {
    const req = new Set(t.parameters.required || []);
    const keys = Object.keys(t.parameters.properties);
    for (const k of req) if (!keys.includes(k)) bad.push(`${t.name}: required '${k}' saknar deklaration`);
    for (const [k, p] of Object.entries(t.parameters.properties)) {
      const d = String(p.description || '');
      const clearlyOptional = OPT.test(d) || /\boptional\b/i.test(d) || d.includes('(default') || /\bdefault\b/i.test(d);
      if (clearlyOptional && req.has(k)) bad.push(`${t.name}: '${k}' både required och markerat optional`);
      if (!clearlyOptional && !req.has(k)) bad.push(`${t.name}: '${k}' saknar både required-status och optional-markör (derivation risker) `);
    }
  }
  assert.deepEqual(bad, [], 'marker/derivation-desync — varje parameter ska vara entydigt klassad');
});

test('registry: required-derivation överlever bundling/transpilation (run manglad)', () => {
  const tool = def({
    name: 'demo.out',
    group: 'demo',
    risk: 'read',
    desc: 'demo',
    params: { a: 'string: needed', b: 'string: optional (default 1)', c: 'bool: optional (default false)' },
    run() { return { ok: true }; },
  });
  Object.defineProperty(tool.run, 'toString', { value: () => '{__MAJIN_RUN_MANGLED_BY_BUNDLER__}' });
  const schema = toSchema({ a: 'string: needed', b: 'string: optional (default 1)', c: 'bool: optional (default false)' });
  assert.deepEqual(schema.required, ['a']);
  assert.equal(Object.keys(schema.properties).length, 3);
});

test('schema: gyllene mängder mot det verkliga bältet (d04-sanning nu ägd)', () => {
  const by = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, (t.parameters.required || []).slice().sort()]));
  const pins = {
    'shell.run': ['command'],
    'browser.open': ['url'],
    'fs.read': ['path'],
    'fs.write': ['content', 'path'],
    'fs.patch': ['edits', 'path'],
    'fs.copy': ['from', 'to'],
    'fs.move': ['from', 'to'],
    'fs.grep': ['path', 'pattern'],
    'net.tcp': ['host', 'port'],
    'net.http': ['url'],
    'web.fetch': ['url'],
    'web.download': ['url'],
    'web.search': ['query'],
    'majin.provider': [],
    'majin.memory': [],
  };
  for (const [name, want] of Object.entries(pins)) {
    assert.ok(by[name], `${name} måste finnas i bältet`);
    assert.deepEqual(by[name], want.sort(), `${name}: required avviker`);
  }
});

test('schema: the integrated tool layer has 149 unique tools, including control and power surfaces', () => {
  assert.equal(ALL_TOOLS.length, 149, 'registered tool count changed; review additions or removals deliberately');
  assert.equal(new Set(ALL_TOOLS.map((tool) => tool.name)).size, ALL_TOOLS.length, 'each tool name has one implementation');
  const groups = [...new Set(ALL_TOOLS.map((t) => t.group))];
  assert.ok(groups.includes('control'), 'control-gruppen måste vara shipped');
});
