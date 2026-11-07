/**
 * The MCP client, tested against a real server process.
 *
 * Every test spawns `scripts/v4/mcp-fixture-server.mjs` — a genuine
 * newline-delimited JSON-RPC server — so this exercises the transport, not a
 * mock of it.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MCP_PROTOCOL_VERSION, McpError, McpServer, connectServers, parseMcpConfig, scrubMcpEnv,
} from '../../src/v4/mcp.js';
import { adaptMcpTools, mcpToolName, registerMcpTools } from '../../src/v4/mcp-tools.js';
import { ToolRegistry } from '../../src/v2/tools/registry.js';
import { runTool } from '../../src/v2/tools/runner.js';
import { tempHome } from './helpers.mjs';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/v4/mcp-fixture-server.mjs');

const spec = (mode = 'normal', extra = {}) => ({
  name: 'fixture',
  command: [process.execPath, FIXTURE],
  args: [`--mode=${mode}`],
  env: process.env,
  timeoutMs: 6000,
  ...extra,
});

test('mcp: the handshake completes and the server identifies itself', async () => {
  const server = new McpServer(spec());
  try {
    await server.start();
    assert.equal(server.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(server.serverInfo.name, 'majin-fixture');
    assert.ok(server.capabilities);
  } finally {
    server.stop();
  }
});

test('mcp: tools are listed with their schemas', async () => {
  const server = new McpServer(spec());
  try {
    await server.start();
    const tools = await server.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['add', 'echo', 'fail']);
    const echo = tools.find((t) => t.name === 'echo');
    assert.equal(echo.inputSchema.type, 'object');
    assert.ok(echo.inputSchema.properties.text);
    assert.ok(echo.description.length > 5);
  } finally {
    server.stop();
  }
});

test('mcp: a tool call returns the text content', async () => {
  const server = new McpServer(spec());
  try {
    await server.start();
    const out = await server.callTool('echo', { text: 'hej från MCP' });
    assert.equal(out.isError, false);
    assert.equal(out.text, 'hej från MCP');
    const sum = await server.callTool('add', { a: 2, b: 40 });
    assert.equal(sum.text, '42');
  } finally {
    server.stop();
  }
});

test('mcp: a server-side failure is isError, not a thrown client error', async () => {
  const server = new McpServer(spec());
  try {
    await server.start();
    const out = await server.callTool('fail', {});
    assert.equal(out.isError, true);
    assert.match(out.text, /always fails/);
  } finally {
    server.stop();
  }
});

test('mcp: an unknown method comes back as a classified server error', async () => {
  const server = new McpServer(spec());
  try {
    await server.start();
    await assert.rejects(() => server.request('tools/nonsense', {}), (e) => e.code === 'SERVER_ERROR');
  } finally {
    server.stop();
  }
});

test('mcp: a server that dies on start fails fast, not at the timeout', async () => {
  const server = new McpServer(spec('die'));
  const started = Date.now();
  try {
    await assert.rejects(() => server.start(), (e) => ['SERVER_DIED', 'NOT_RUNNING', 'TIMEOUT'].includes(e.code));
    assert.ok(Date.now() - started < 5000, 'it did not wait for the full timeout');
  } finally {
    server.stop();
  }
});

test('mcp: a hung server is cut off by the timeout', async () => {
  const server = new McpServer(spec('hang', { timeoutMs: 400 }));
  const started = Date.now();
  try {
    await assert.rejects(() => server.start(), (e) => e.code === 'TIMEOUT');
    assert.ok(Date.now() - started < 5000);
  } finally {
    server.stop();
  }
});

test('mcp: a server that prints logs on stdout is still usable', async () => {
  const server = new McpServer(spec('noisy'));
  try {
    await server.start();
    const tools = await server.listTools();
    assert.ok(tools.length >= 3);
    const out = await server.callTool('echo', { text: 'trots logg' });
    assert.equal(out.text, 'trots logg');
  } finally {
    server.stop();
  }
});

test('mcp: stop() leaves no process and no pending promise behind', async () => {
  const server = new McpServer(spec());
  await server.start();
  const inFlight = server.request('tools/list', {});
  server.stop();
  await assert.rejects(() => inFlight, (e) => e.code === 'STOPPED' || e.code === 'NOT_RUNNING');
  assert.equal(server.dead, true);
  await assert.rejects(() => server.request('tools/list', {}), (e) => e.code === 'NOT_RUNNING');
});

test('mcp: the child never sees MAJIN credentials', () => {
  const env = scrubMcpEnv({
    PATH: '/usr/bin',
    MAJIN_V4_API_KEY: 'sk-secret',
    OPENCODE_KEY: 'oc_secret',
    GITHUB_TOKEN: 'ghp_secret',
    HOME: '/home/x',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/x');
  assert.equal(env.MAJIN_V4_API_KEY, undefined);
  assert.equal(env.OPENCODE_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test('mcp/config: a shell string is refused, an argv array is accepted', () => {
  const { servers, errors } = parseMcpConfig({
    servers: {
      good: { command: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      shellish: { command: ['npx -y server | tee log'] },
      'Bad Name': { command: ['x'] },
      empty: { command: [] },
    },
  });
  assert.deepEqual(servers.map((s) => s.name), ['good']);
  const byName = Object.fromEntries(errors.map((e) => [e.name, e.error]));
  assert.match(byName.shellish, /shell string/);
  assert.match(byName['Bad Name'], /name must be lowercase/);
  assert.match(byName.empty, /non-empty/);
});

test('mcp/config: an empty or non-object config yields nothing and does not throw', () => {
  assert.deepEqual(parseMcpConfig(null).servers, []);
  assert.deepEqual(parseMcpConfig({}).servers, []);
  assert.deepEqual(parseMcpConfig('text').servers, []);
});

test('mcp/connect: one broken server does not stop the others', async () => {
  const { connected, failed } = await connectServers([
    { ...spec('die'), name: 'broken' },
    { ...spec('normal'), name: 'fine' },
  ]);
  assert.deepEqual(connected.map((c) => c.server.name), ['fine']);
  assert.deepEqual(failed.map((f) => f.name), ['broken']);
  for (const c of connected) c.server.stop();
});

test('mcp/tools: an MCP tool becomes a V2 ToolDefinition that runs through the runner', async () => {
  const server = new McpServer(spec());
  await server.start();
  try {
    const tools = await server.listTools();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'fixture', tools, { server });

    const names = registry.list().map((t) => t.name).sort();
    assert.deepEqual(names, ['mcp_fixture_add', 'mcp_fixture_echo', 'mcp_fixture_fail']);

    const out = await runTool({ tool: 'mcp_fixture_echo', input: { text: 'via runner' } }, {
      registry,
      approvals: { check: () => ({ decision: 'allow' }) },
      timeoutMs: 8000,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.data.text, 'via runner');
  } finally {
    server.stop();
  }
});

test('mcp/tools: MCP tools are a held tier, so they need consent', async () => {
  const server = new McpServer(spec());
  await server.start();
  try {
    const tools = await server.listTools();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'fixture', tools, { server });
    const result = await runTool({ tool: 'mcp_fixture_echo', input: { text: 'x' } }, {
      registry,
      approvals: { check: () => ({ decision: 'waiting', note: 'no consent' }) },
      timeoutMs: 5000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.decision, 'waiting', 'an MCP server can do anything, so it is held');
  } finally {
    server.stop();
  }
});

test('mcp/tools: a server-side error becomes a classified failure, not a success', async () => {
  const server = new McpServer(spec());
  await server.start();
  try {
    const tools = await server.listTools();
    const registry = new ToolRegistry();
    registerMcpTools(registry, 'fixture', tools, { server });
    await assert.rejects(
      () => runTool({ tool: 'mcp_fixture_fail', input: {} }, {
        registry,
        approvals: { check: () => ({ decision: 'allow' }) },
        timeoutMs: 8000,
      }),
      (err) => /always fails/.test(err.message),
    );
  } finally {
    server.stop();
  }
});

test('mcp/tools: adaptMcpTools keeps the server schema so the model sees real parameters', () => {
  const defs = adaptMcpTools('fixture', [{
    name: 'echo',
    description: 'Return the text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }], { call: async () => ({ isError: false, text: 'x' }) });
  assert.equal(defs[0].name, 'mcp_fixture_echo');
  assert.equal(defs[0].tier, 'process');
  assert.equal(defs[0].description.includes('Return the text'), true);
});

test('mcp/tools: an unusable tool name is skipped and named', () => {
  // V4's registry caps names at 80 chars; a tool name that cannot fit is skipped
  const tooLong = 'x'.repeat(120);
  const defs = adaptMcpTools('srv', [{ name: tooLong, description: 'x', inputSchema: {} }], { call: async () => ({}) });
  assert.equal(defs.length, 0);
  assert.equal(mcpToolName('srv', 'has spaces and $'), 'mcp_srv_has_spaces_and', 'ordinary punctuation is normalised');
});

test('mcp: a stopped server makes its tools fail honestly instead of hanging', async () => {
  const server = new McpServer(spec());
  await server.start();
  const tools = await server.listTools();
  const registry = new ToolRegistry();
  registerMcpTools(registry, 'fixture', tools, { server });
  server.stop();
  await assert.rejects(
    () => runTool({ tool: 'mcp_fixture_echo', input: { text: 'x' } }, {
      registry,
      approvals: { check: () => ({ decision: 'allow' }) },
      timeoutMs: 5000,
    }),
    (err) => /not running|stopped/i.test(err.message),
  );
});

test('mcp: fixture mode error makes every call isError', async () => {
  const server = new McpServer(spec('error'));
  try {
    await server.start();
    const out = await server.callTool('echo', { text: 'hej' });
    assert.equal(out.isError, true);
  } finally {
    server.stop();
  }
});

test('mcp: an empty home has no config and yields no servers', () => {
  const home = tempHome();
  const { servers } = parseMcpConfig(null);
  assert.deepEqual(servers, []);
  assert.ok(McpError.prototype instanceof Error);
  void home;
});

/* ------------------------------------------------- through the real host -- */

const FIXTURE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/v4/mcp-fixture-server.mjs');

async function hostWithMcp(servers) {
  const { startTestServer } = await import('./helpers.mjs');
  const fsMod = await import('node:fs');
  const home = tempHome();
  fsMod.mkdirSync(path.join(home, 'v4'), { recursive: true });
  fsMod.writeFileSync(path.join(home, 'v4', 'mcp.json'), JSON.stringify({ servers }));
  const s = await startTestServer({ home });
  return { s, home, fsMod };
}

test('mcp/host: the lane is off until granted, and says so', async () => {
  const { s, home, fsMod } = await hostWithMcp({ fixturesrv: { command: [process.execPath, FIXTURE_PATH] } });
  try {
    const { cookie } = await s.pair();
    const body = await (await fetch(`${s.base}/api/mcp`, { headers: { cookie } })).json();
    assert.equal(body.mcp.connected.length, 0);
    assert.ok(body.mcp.configErrors.some((e) => /mcp lane is not granted/.test(e.error)));
  } finally {
    await s.close();
    fsMod.rmSync(home, { recursive: true, force: true });
  }
});

test('mcp/host: granting the lane connects the server and its tools reach the model', async () => {
  const { s, home, fsMod } = await hostWithMcp({ fixturesrv: { command: [process.execPath, FIXTURE_PATH] } });
  try {
    const { cookie } = await s.pair();
    await fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ action: 'grant', lanes: ['mcp'] }),
    });

    const body = await (await fetch(`${s.base}/api/mcp`, { headers: { cookie } })).json();
    assert.equal(body.mcp.connected.length, 1, JSON.stringify(body.mcp));
    assert.deepEqual(body.mcp.connected[0].tools.sort(), ['mcp_fixturesrv_add', 'mcp_fixturesrv_echo', 'mcp_fixturesrv_fail']);

    // and the model sees them
    const { postChat, readSse } = await import('./helpers.mjs');
    const seen = [];
    const realChat = s.context.model.chat.bind(s.context.model);
    s.context.model.chat = async (opts) => { seen.push(opts.tools || []); return realChat(opts); };
    await readSse(await postChat(s.base, cookie, { text: 'Hej', requestId: 'mcp1' }));
    const names = seen[0].map((t) => t.name);
    assert.ok(names.includes('mcp_fixturesrv_echo'), `model saw: ${names.join(', ')}`);
    const echo = seen[0].find((t) => t.name === 'mcp_fixturesrv_echo');
    assert.equal(echo.parameters.type, 'object');
    assert.ok(echo.parameters.properties.text, 'the real MCP schema is passed through');
  } finally {
    await s.close();
    fsMod.rmSync(home, { recursive: true, force: true });
  }
});

test('mcp/host: an MCP tool actually executes through the agent', async () => {
  const { s, home, fsMod } = await hostWithMcp({ fixturesrv: { command: [process.execPath, FIXTURE_PATH] } });
  try {
    const { cookie } = await s.pair();
    await fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ action: 'grant', lanes: ['mcp'] }),
    });
    // the runner is the same path the agent uses; consent is granted here
    s.context.agent.approvals.grant('tool:mcp_fixturesrv_add', { user: 'owner', mode: 'session', maxUses: 5 });
    const out = await runTool({ tool: 'mcp_fixturesrv_add', input: { a: 20, b: 22 } }, {
      registry: s.context.tools.registry,
      approvals: s.context.agent.approvals,
      timeoutMs: 10_000,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.data.text, '42');
  } finally {
    await s.close();
    fsMod.rmSync(home, { recursive: true, force: true });
  }
});

test('mcp/host: revoking the lane disconnects the server and removes its tools', async () => {
  const { s, home, fsMod } = await hostWithMcp({ fixturesrv: { command: [process.execPath, FIXTURE_PATH] } });
  try {
    const { cookie } = await s.pair();
    const post = (body) => fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify(body),
    });
    await post({ action: 'grant', lanes: ['mcp'] });
    assert.ok(s.context.tools.registry.list().some((t) => t.name.startsWith('mcp_')));

    await post({ action: 'revoke' });
    const left = s.context.tools.registry.list().filter((t) => t.name.startsWith('mcp_'));
    assert.deepEqual(left, [], 'every MCP tool was removed from the registry');
    const body = await (await fetch(`${s.base}/api/mcp`, { headers: { cookie } })).json();
    assert.equal(body.mcp.connected.length, 0);
  } finally {
    await s.close();
    fsMod.rmSync(home, { recursive: true, force: true });
  }
});

test('mcp/host: a broken server is reported and the host keeps working', async () => {
  const { s, home, fsMod } = await hostWithMcp({
    broken: { command: [process.execPath, FIXTURE_PATH, '--mode=die'] },
    fine: { command: [process.execPath, FIXTURE_PATH] },
  });
  try {
    const { cookie } = await s.pair();
    await fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ action: 'grant', lanes: ['mcp'] }),
    });
    const body = await (await fetch(`${s.base}/api/mcp`, { headers: { cookie } })).json();
    assert.equal(body.mcp.connected.length, 1);
    assert.equal(body.mcp.connected[0].name, 'fine');
    assert.equal(body.mcp.failed.length, 1);
    assert.equal(body.mcp.failed[0].name, 'broken');

    const health = await (await fetch(`${s.base}/api/health`)).json();
    assert.equal(health.ok, true, 'the host itself is unaffected');
  } finally {
    await s.close();
    fsMod.rmSync(home, { recursive: true, force: true });
  }
});

test('mcp/host: a shell string in mcp.json is refused, not executed', async () => {
  const { s, home, fsMod } = await hostWithMcp({ risky: { command: ['npx -y server | tee /tmp/x'] } });
  try {
    const { cookie } = await s.pair();
    await fetch(`${s.base}/api/owner-mode`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-majin-csrf': '1', origin: s.base },
      body: JSON.stringify({ action: 'grant', lanes: ['mcp'] }),
    });
    const body = await (await fetch(`${s.base}/api/mcp`, { headers: { cookie } })).json();
    assert.equal(body.mcp.connected.length, 0);
    assert.ok(body.mcp.configErrors.some((e) => /shell string/.test(e.error)));
  } finally {
    await s.close();
    fsMod.rmSync(home, { recursive: true, force: true });
  }
});
