/**
 * Språkgardin: allt som en modell eller användare ser ska vara engelska, medan
 * svenska får leva vidare som *indata*. Testet fångar både ord och åäö i sträng-
 * literaler, och släpper bara igenom de matchningslistor som finns för att svenska
 * meningar fortfarande ska routes:as, tolkas och godkännas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../scripts/i18n-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('i18n: no Swedish in shipped string literals', () => {
  const prev = process.cwd();
  process.chdir(root);
  let hits;
  try {
    hits = scan({ quiet: true });
  } finally {
    process.chdir(prev);
  }
  assert.equal(
    hits.length,
    0,
    `Swedish string literals found:\n${hits.slice(0, 12).map((h) => `  ${h.file}:${h.line} [${h.words}] ${h.text}`).join('\n')}`,
  );
});

test('i18n: Swedish input still understood (do not "translate" these away)', () => {
  // dessa rader är medvetet svenska — de är hur MAJIN förstår en svensk användare
  const cases = [
    ['src/core/routes.js', /job: 'tasks', words: \[[^\]]*'jobb'/, 'route keywords'],
    ['src/core/agent.js', /const JOBS_SV = \[/, 'job keywords in natural language'],
    ['src/core/config.js', /id: 'tasks', match: '\/\(fil\|mapp/, 'default routing rules'],
    ['src/core/schedule.js', /sön: 0/, 'swedish weekday names'],
    ['src/core/channels/index.js', /godk\[aä\]nn/, 'approval reply in chat'],
    ['src/ui/app.js', /forget\|glöm/, 'the /forget command alias'],
  ];
  for (const [file, re, what] of cases) assert.match(read(file), re, `${what} must keep working for Swedish input`);
});

test('i18n: model-facing prompts are English', () => {
  const agent = read('src/core/agent.js');
  const loop = read('src/core/loop.js');
  const ctx = read('src/core/context.js');
  assert.match(agent, /TOOLS: all \$\{tools\.length\} are always on/);
  assert.match(agent, /THIS TURN IS READ-ONLY/);
  assert.match(loop, /ERROR \[\$\{r\.out\.error\?\.code \|\| 'error'\}\]/);
  assert.match(ctx, /Summarise the conversation below/);
  assert.doesNotMatch(agent, /Klart\./, 'the self-config confirmation must not be Swedish');
});
