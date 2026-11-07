/**
 * Naturallyspråk → config. Det här är kärnan i "agenten ställer in sig själv".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, Config, clone } from '../src/core/config.js';
import { parseIntent, findModelRefs } from '../src/core/routes.js';

function cfg0(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majin-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = new Config(clone(DEFAULTS), path.join(dir, 'c.json'));
  c.save = () => true;
  return c;
}

test('hittar modellreferenser utan att äta "deep" i "deepseek"', () => {
  const a = findModelRefs('använd deepseek/deepseek-v4-pro för kod');
  assert.ok(a.length >= 1);
  assert.equal(a[0].ref, 'deepseek/deepseek-v4-pro');
  const refs = findModelRefs('kör med deepseek-chat');
  assert.ok(refs.some((r) => r.ref.includes('deepseek')), JSON.stringify(refs));
  assert.deepEqual(findModelRefs('ingen modell här'), []);
  assert.deepEqual(findModelRefs('openrouter/deepseek/deepseek-flash'), [{ provider: 'openrouter', model: 'deepseek/deepseek-flash', ref: 'openrouter/deepseek/deepseek-flash' }]);
});

test('sätter API-nyckel per provider', (t) => {
  const c = cfg0(t);
  const i = parseIntent('min nyckel är sk-1234567890abcdef för deepseek', c);
  assert.equal(i.matched, true);
  assert.equal(i.patch.providers.deepseek.apiKey, 'sk-1234567890abcdef');
  const applied = c.patch(i.patch);
  assert.equal(applied.ok, true);
  assert.equal(c.get('providers.deepseek.apiKey'), 'sk-1234567890abcdef');
  assert.equal(c.needsSetup(), false);
});

test('rutter per jobb, alltid = permanent', (t) => {
  const c = cfg0(t);
  const i = parseIntent('använd openrouter/deepseek/deepseek-v4-pro för kod alltid', c);
  assert.equal(i.matched, true, JSON.stringify(i));
  assert.equal(i.patch.models.routes.code, 'openrouter/deepseek/deepseek-v4-pro');
  assert.ok(i.notes.join(' ').includes('code'), i.notes.join('|'));
  c.patch({ providers: { openrouter: { apiKey: 'sk-or' } } });
  assert.equal(c.patch(i.patch).ok, true);
  assert.equal(c.get('models.routes.code'), 'openrouter/deepseek/deepseek-v4-pro');
});

test('"kör allt med X" sätter alla 13 jobb', (t) => {
  const c = cfg0(t);
  const i = parseIntent('kör allt med deepseek/deepseek-flash', c);
  assert.equal(i.matched, true);
  assert.equal(Object.keys(i.patch.models.routes).length, 13);
  for (const v of Object.values(i.patch.models.routes)) assert.equal(v, 'deepseek/deepseek-flash');
});

test('villkorsregler: "om X, använd Y"', (t) => {
  const c = cfg0(t);
  const i = parseIntent('om det är reverse engineering, använd deepseek/deepseek-v4-pro', c);
  assert.equal(i.matched, true, JSON.stringify(i));
  const rules = i.patch.routing.rules;
  assert.ok(Array.isArray(rules) && rules.length >= 1, JSON.stringify(i.patch));
  const added = rules[rules.length - 1];
  assert.equal(added.job, 're', JSON.stringify(added));
  assert.ok(added.match && added.model === 'deepseek/deepseek-v4-pro', JSON.stringify(added));
  assert.equal(c.patch(i.patch).ok, true);
  assert.ok(c.get('routing.rules').some((r) => r.job === 're'));
});

test('MOA, guard, budget, maxSteps, memory and persona — Swedish and English', (t) => {
  const c = cfg0(t);
  const cases = [
    ['slå på moa för allt', (i) => i.patch.moa.policy === 'always'],
    ['moa på hard', (i) => i.patch.moa.policy === 'hard'],
    ['kör med 5 referenser', (i) => i.patch.moa.width === 5],
    ['stäng av moa', (i) => i.patch.moa.policy === 'off'],
    ['fråga inte innan du raderar', (i) => i.patch.guard.mode === 'off'],
    ['bekräfta allt farligt', (i) => i.patch.guard.mode === 'strict' || i.patch.guard.mode === 'confirm'],
    ['max 12 steg', (i) => i.patch.agent.maxSteps === 12],
    ['budget 20 dollar i månaden', (i) => Number(i.patch.budget.monthlyUsd) === 20],
    ['spara inga minnen', (i) => i.patch.memory.auto === false],
    ['var mer rakt på sak', (i) => Boolean(i.patch.persona)],
    // English synonyms — voice control must work in the user's language too
    ['turn moa on for everything', (i) => i.patch.moa.policy === 'always'],
    ['run with 4 references', (i) => i.patch.moa.width === 4],
    ['use 3 models in parallel', (i) => i.patch.moa.width === 3],
    ['disable moa', (i) => i.patch.moa.enabled === false],
    ['stop asking', (i) => i.patch.guard.mode === 'off'],
    ['confirm everything', (i) => i.patch.guard.mode === 'strict'],
    ['ask before deleting', (i) => i.patch.guard.mode === 'confirm'],
    ['no more than 10 steps', (i) => i.patch.agent.maxSteps === 10],
    ['stop remembering', (i) => i.patch.memory.auto === false],
    ['be concise', (i) => Boolean(i.patch.persona)],
    ['reply in english', (i) => /English/.test(i.patch.persona.style)],
    ['budget 50 usd a month', (i) => Number(i.patch.budget.monthlyUsd) === 50],
  ];
  for (const [text, check] of cases) {
    const i = parseIntent(text, c);
    assert.equal(i.matched, true, `matchade inte: ${text}`);
    assert.ok(check(i), `fel patch för "${text}": ${JSON.stringify(i.patch)}`);
    assert.equal(c.patch(i.patch).ok, true, `patch nekades för "${text}"`);
  }
});

test('unknown intent leaves config untouched and flags', (t) => {
  const c = cfg0(t);
  const i = parseIntent('vad är vädret imorgon', c);
  assert.equal(i.matched, false);
  assert.deepEqual(i.patch, {});
  const before = JSON.stringify(c.raw());
  c.patch(i.patch);
  assert.equal(JSON.stringify(c.raw()), before);
});

test('a bare key lands on the default provider, a key inside a task does not', (t) => {
  const c = cfg0(t);
  const i = parseIntent('sk-abc123def45678901234567890', c);
  assert.equal(i.matched, true);
  const name = Object.keys(i.patch.providers)[0];
  assert.equal(c.get('models.provider'), 'deepseek', 'the default provider is deepseek');
  assert.equal(i.patch.providers[name].apiKey, 'sk-abc123def45678901234567890');
  // en nyckel som nämns i en uppgift är inte en konfigurationsbegäran
  const q = parseIntent('read notes.txt key sk-LIVESECRET1234567890AB', c);
  assert.equal(q.matched, false, 'a mentioned key must not rewrite the provider config');
  const r = parseIntent('what does this log line mean: user=sk-abcdefghijklmnop1234', c);
  assert.equal(r.patch.providers, undefined, 'no provider patch from a quoted log line');
  assert.equal(parseIntent('my openai key is sk-abcdefghijklmnop1234', c).patch.providers.openai.apiKey, 'sk-abcdefghijklmnop1234');
});
