/**
 * The inventory is a guard, not a document.
 *
 * The failure this prevents: V1 has 26 tool modules. V4 originally adapted 12
 * lanes and said nothing about the other 14. Capabilities did not disappear
 * loudly — they were simply never mentioned. Now a module without a decision
 * fails the build.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildInventory, renderInventoryMarkdown } from '../../src/v4/inventory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('inventory: every V1 tool module and every V2/V3 file has a recorded decision', async () => {
  const inv = await buildInventory({ root });
  assert.deepEqual(inv.undecided, [], `undecided capabilities: ${inv.undecided.join(', ')}`);

  const files = fs.readdirSync(path.join(root, 'src', 'core', 'tools'))
    .filter((f) => f.endsWith('.js') && !['index.js', 'registry.js'].includes(f));
  assert.equal(inv.v1.modules.length, files.length, 'a tool module is missing from the inventory');

  for (const mod of inv.v1.modules) {
    if (mod.decision.status === 'lane' || mod.decision.status === 'reused-engine') continue;
    assert.ok(mod.decision.reason && mod.decision.reason.length > 40,
      `${mod.file} is excluded without a real reason`);
    assert.ok(['replaced', 'excluded'].includes(mod.decision.status), `${mod.file} has an unknown decision`);
  }
});

test('inventory: totals are internally consistent', async () => {
  const inv = await buildInventory({ root });
  const tools = inv.v1.modules.flatMap((m) => m.tools);
  assert.equal(inv.v1.totals.tools, tools.length);
  assert.equal(inv.v1.totals.integrated, tools.filter((t) => t.status === 'integrated').length);
  assert.equal(inv.v1.totals.excluded, tools.filter((t) => t.status === 'excluded').length);
  assert.equal(
    inv.v1.totals.integrated + inv.v1.totals.excluded,
    inv.v1.totals.tools,
    'every tool is either integrated or excluded, never unaccounted for',
  );

  // Runtime gates are stated, not hidden inside "integrated".
  assert.ok(tools.filter((t) => t.requires === 'browser runtime').every((t) => t.name.startsWith('browser.')),
    'only browser.* tools may require a browser runtime');
});

test('inventory: the lane map covers the modules it claims to reuse', async () => {
  const inv = await buildInventory({ root });
  for (const mod of inv.v1.modules.filter((m) => m.decision.status === 'lane')) {
    assert.ok(mod.lanes.length > 0, `${mod.file} claims a lane but names none`);
    for (const lane of mod.lanes) {
      assert.ok(['net', 'screen', 'desktop', 'computer', 'files', 'shell', 'shelltools', 'sys', 'power', 'web',
        'research', 'jobs', 'flows', 'github', 'channels', 'audit', 'learn', 'marketing', 're', 'trading'].includes(lane.lane),
        `unknown lane ${lane.lane} for ${mod.file}`);
    }
  }
});

test('inventory: the markdown renders every section without throwing', async () => {
  const inv = await buildInventory({ root });
  const md = renderInventoryMarkdown(inv);
  for (const heading of ['## Totals', '## V1 tool modules', '## V1 tools', '## V2 components',
    '## V3 components', '## V4 lanes on this host']) {
    assert.ok(md.includes(heading), `missing section ${heading}`);
  }
  assert.ok(!md.includes('UNDECIDED'), 'a rendered inventory may not contain undecided rows');
});
