import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collectInventory } from '../../src/v6/inventory.js';
import { ALL_TOOLS } from '../../src/core/tools/index.js';
import { browserTools } from '../../src/core/tools/browser.js';
import { desktopAppTools } from '../../src/core/tools/desktop-app.js';
import { ALL_MCP_TOOLS } from '../../src/v6/mcp.js';
import { parseArgs } from '../../src/v6/cli.js';

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');

test('the Windows launcher is dry-run capable and never mutates OpenCode, V5 or installs software', () => {
  const start = read('scripts/v6/start-v6.ps1');
  assert.match(start, /\[switch\]\$DryRun/);
  assert.match(start, /ValidateSet\('Doctor', 'Status', 'Worker', 'Inventory', 'Config'\)/);
  assert.match(start, /Refusing to run: the V6 home must not be the V5 data directory/);
  assert.match(start, /switch \(\$Action\)/);
  assert.match(start, /'Config' \{/);
  assert.match(start, /timeout\s*=\s*300000/);
  assert.doesNotMatch(start, /npm\s+(install|ci|i)\b/i);
  assert.doesNotMatch(start, /opencode\s+(auth|run|upgrade)\b/i);
  assert.doesNotMatch(start, /Set-Content[^\n]*opencode/i);
  assert.doesNotMatch(start, /C:\\MAJINCLI/i);
  assert.doesNotMatch(start, /-ExecutionPolicy\s+Bypass\s+-Command/i);
});

test('the registration script backs up, verifies and refuses JSONC instead of destroying it', () => {
  const register = read('scripts/v6/register-opencode-mcp.ps1');
  assert.match(register, /\[switch\]\$Apply/);
  assert.match(register, /Copy-Item -LiteralPath \$configFull -Destination \$backup/);
  assert.match(register, /ConvertFrom-Json/);
  assert.match(register, /Backup was not created/);
  assert.match(register, /JSONC configs are not edited automatically/);
  assert.match(register, /restored from \$backup/);
  assert.match(register, /DRY RUN\. Nothing was written/);
  assert.match(register, /mcp\['majin'\] = \$entry/);
  assert.doesNotMatch(register, /Remove-Item -LiteralPath \$configFull -Force\s*$/m);
  assert.doesNotMatch(register, /opencode\s+auth/i);
});

test('V6 never shells out to the GitHub CLI or rewrites the active installation', () => {
  const files = fs.readdirSync('src/v6', { recursive: true })
    .filter((file) => String(file).endsWith('.js'))
    .map((file) => path.join('src/v6', file));
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, /\bgh\.exe\b/i, `${file} must not invoke gh.exe`);
    assert.doesNotMatch(content, /exec(Sync|File)?\([^)]*\bgh\b/, `${file} must not invoke gh`);
    assert.doesNotMatch(content, /npm\s+(install|ci)\s+-g/i, `${file} must not install global packages`);
  }
  const network = files.filter((file) => /\bfetch(Impl)?\s*\(/.test(read(file))).map((file) => path.basename(file)).sort();
  assert.deepEqual(network, ['gmail.js', 'sync.js'], 'network access is limited to Gmail and the private sync API');
});

test('the calculated inventory matches the real registries', async () => {
  const inventory = await collectInventory({ deep: false, history: false });
  const expected = new Set([...ALL_TOOLS, ...browserTools, ...desktopAppTools].map((tool) => tool.name));
  assert.equal(inventory.counts.currentV1Entries, expected.size);
  assert.equal(inventory.counts.currentV1Universe, expected.size);
  assert.equal(inventory.counts.openCodeMcpTools, ALL_MCP_TOOLS.length);
  assert.equal(inventory.counts.openCodeDriverAdapters, null);
  assert.equal(inventory.deep.state, 'NOT_TESTED');
  assert.equal(inventory.tools.length, expected.size);
  assert.ok(inventory.tools.every((tool) => tool.name && tool.lane));
  assert.ok(inventory.tools.every((tool) => tool.executableOnHost === true || Boolean(tool.unavailableReason)));
});


test('CLI parsing does not let boolean flags swallow the command or option values', () => {
  const one = parseArgs(['status', '--json']);
  assert.deepEqual(one.positional, ['status']);
  assert.equal(one.flags.json, true);
  const two = parseArgs(['--v6-home=/tmp/v6', 'queue', 'add', '--kind', 'tool', '--json']);
  assert.deepEqual(two.positional, ['queue', 'add']);
  assert.equal(two.flags['v6-home'], '/tmp/v6');
  assert.equal(two.flags.kind, 'tool');
  assert.equal(two.flags.json, true);
  const three = parseArgs(['--json', 'status']);
  assert.deepEqual(three.positional, ['status'], 'a boolean flag must not consume the command');
  assert.equal(three.flags.json, true);
});
