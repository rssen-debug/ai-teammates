import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const source = `
import { z } from 'zod';
import { ToolRegistry } from './src/v2/tools/registry.js';
import { runTool } from './src/v2/tools/runner.js';
const registry = new ToolRegistry();
registry.define({ name: 'timer_probe', tier: 'read', description: 'Controlled process exit probe',
  inputSchema: z.object({}), outputSchema: z.object({ ok: z.literal(true) }),
  execute: async () => { if (process.argv[1] === 'throw') throw Error('controlled failure'); return process.argv[1] === 'schema' ? { ok: false } : { ok: true }; },
});
try { await runTool({ tool: 'timer_probe', input: {} }, { registry, timeoutMs: 30000 }); }
catch (error) { if (process.argv[1] === 'success') throw error; }
console.log('probe finished');
`;

for (const outcome of ['success', 'throw', 'schema']) test(`tool deadline does not keep a finished ${outcome} process alive`, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, outcome], { cwd, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.error, undefined, `child must exit naturally before its unused 30s deadline: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /probe finished/);
});
