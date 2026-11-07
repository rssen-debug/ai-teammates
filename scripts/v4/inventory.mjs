#!/usr/bin/env node
/**
 * MAJIN V4 — write the capability inventory.
 *
 *   node scripts/v4/inventory.mjs            write docs/v4/CAPABILITY_INVENTORY.{json,md}
 *   node scripts/v4/inventory.mjs --check    fail if a V1 module or V2/V3 file has no decision
 *   node scripts/v4/inventory.mjs --json     print the inventory
 *
 * Exit code 1 on an undecided module: forgetting a capability is how a
 * "universal" agent quietly stops being one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory, renderInventoryMarkdown } from '../../src/v4/inventory.js';

const args = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inv = await buildInventory({ root });

if (args.includes('--json')) {
  process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
  process.exit(inv.undecided.length ? 1 : 0);
}

const outDir = path.join(root, 'docs', 'v4');
fs.mkdirSync(outDir, { recursive: true });
const jsonFile = path.join(outDir, 'CAPABILITY_INVENTORY.json');
const mdFile = path.join(outDir, 'CAPABILITY_INVENTORY.md');

process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`.length ? '' : '');
fs.writeFileSync(jsonFile, `${JSON.stringify(inv, null, 2)}\n`);
fs.writeFileSync(mdFile, `${renderInventoryMarkdown(inv)}\n`);

const t = inv.v1.totals;
process.stdout.write('\nMAJIN V4 capability inventory\n');
process.stdout.write('='.repeat(66) + '\n');
process.stdout.write(`  V1  ${t.modules} modules, ${t.tools} tools: ${t.integrated} integrated, ${t.excluded} excluded with a reason\n`);
process.stdout.write(`  V2  ${inv.v2.totals.reused}/${inv.v2.totals.components} components imported by V4\n`);
process.stdout.write(`  V3  ${inv.v3.totals.reused}/${inv.v3.totals.components} components imported by V4\n`);
process.stdout.write(`  V4  ${inv.v4.builtinTools} built-ins, ${inv.v4.registeredOnThisHost} tools registered on ${inv.platform}\n`);
process.stdout.write(`  written: docs/v4/CAPABILITY_INVENTORY.json and .md\n`);
if (inv.undecided.length) {
  process.stdout.write(`\n  UNDECIDED (${inv.undecided.length}) — every capability needs a decision:\n`);
  for (const item of inv.undecided) process.stdout.write(`    ${item}\n`);
  process.exit(1);
}
process.stdout.write('\n  every V1 module and every V2/V3 component has a recorded decision\n\n');
