/**
 * "Inga döda tools" — varje verktyg i registret ska vara synligt och körbart
 * genom provider-API:t. Det här testet är kontraktet för användarens krav:
 * alla tools skall användas. Om ett tool hamnar i ALL_TOOLS utan att modellen
 * kan se det, eller har en bruten schema, ska CI skrika.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS, buildRegistry } from '../src/core/tools/index.js';

const RISKS = new Set(['read', 'write', 'exec', 'destructive']); // verklig enum i registret

function ctxStub() {
  return { session: 'test', readOnly: false, cfg: { get: () => undefined } };
}

test('varje tool är komplett: namn/grupp/desc/schema/run/risk', () => {
  assert.ok(ALL_TOOLS.length >= 40, `registret ska vara stort (${ALL_TOOLS.length} tools)`);
  const seen = new Set();
  for (const t of ALL_TOOLS) {
    assert.ok(t.name && /^[a-z][a-z0-9_.-]+$/.test(t.name), `ogiltigt namn: ${t.name}`);
    assert.ok(!seen.has(t.name), `dubblett: ${t.name}`);
    seen.add(t.name);
    assert.ok(t.group, `${t.name} saknar grupp`);
    assert.ok(t.desc && t.desc.length >= 20, `${t.name} saknar en riktig beskrivning (${t.desc?.length || 0} tecken)`);
    assert.ok(t.parameters && t.parameters.type === 'object', `${t.name} saknar JSON-schema`);
    assert.equal(typeof t.run, 'function', `${t.name} saknar run()`);
    assert.ok(RISKS.has(t.risk), `${t.name} har ogiltig risk-nivå "${t.risk}"`);
    // required ⊆ properties — annan kan modellen aldrig anropa rätt
    const props = Object.keys(t.parameters.properties || {});
    for (const r of t.parameters.required || []) {
      assert.ok(props.includes(r), `${t.name}: required "${r}" finns inte i properties`);
    }
  }
});

test('registry: 100% av ALL_TOOLS blir modell-synliga via provider-API-schemat', () => {
  const reg = buildRegistry(ctxStub());
  const schemaNames = new Set(reg.schemas().map((s) => s.function?.name || s.name));
  const listNames = new Set(reg.list().map((t) => t.name));
  const missingFromSchema = ALL_TOOLS.filter((t) => !schemaNames.has(t.name)).map((t) => t.name);
  const missingFromList = ALL_TOOLS.filter((t) => !listNames.has(t.name)).map((t) => t.name);
  assert.deepEqual(missingFromSchema, [], `dessa tools dog i schemas(): ${missingFromSchema.join(', ')}`);
  assert.deepEqual(missingFromList, [], `dessa tools dog i list(): ${missingFromList.join(', ')}`);
  assert.equal(reg.schemas().length, ALL_TOOLS.length, 'exakt paritet krävs — en gem som inte når modellen är en död tool');
});

test('readOnly filtrerar bort write/run/danger men tappar inget READ-verktyg', () => {
  const reg = buildRegistry(ctxStub());
  const ro = new Set(reg.schemas({ readOnly: true }).map((s) => s.function?.name || s.name));
  for (const t of ALL_TOOLS.filter((x) => x.risk === 'read')) {
    assert.ok(ro.has(t.name), `readOnly-mode gömde READ-tool ${t.name}`);
  }
});

test('majin.doctor svarar hälsostatus även utan nätverk och utan providers', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { Config, DEFAULTS, clone } = await import('../src/core/config.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-doctor-'));
  const data = clone(DEFAULTS);
  for (const provider of Object.values(data.providers)) if (provider.kind !== 'mock') { provider.apiKey = ''; provider.keyEnv = null; }
  const cfg = new Config(data, path.join(dir, 'c.json'));
  const tool = ALL_TOOLS.find((t) => t.name === 'majin.doctor');
  assert.ok(tool, 'majin.doctor måste vara registrerad');
  const out = await tool.run({}, { cfg });
  assert.ok(out.result.includes('FIX   ai-key'), 'utan nyckel ska doktorn säga vad som saknas');
  assert.ok(out.result.includes('majin.provider'), 'fix-raden pekar på verktyget som lagar det');
  // med nyckel → OK
  cfg.patch({ providers: { deepseek: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', kind: 'openai' } }, models: { routes: Object.fromEntries(['chat', 'tools', 'router'].map((j) => [j, 'deepseek/deepseek-flash'])) } });
  const out2 = await tool.run({}, { cfg });
  assert.ok(out2.result.includes('OK    ai-key'), 'med nyckel ska ai-key vara OK');
  fs.rmSync(dir, { recursive: true, force: true });
});
