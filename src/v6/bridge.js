/**
 * MAJIN V6 — OpenCode tool bridge.
 *
 * Reuses the existing V5 deterministic CodexDriver and the owner's existing
 * owner-mode grants. It does not start a provider, does not change OpenCode's
 * model and does not write grants.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CodexDriver } from '../v5/codex-driver.js';
import { OwnerMode } from '../v4/owner-mode.js';
import { isAuthorized, filterCatalog, fingerprintGrants, requiredLane } from './policy.js';

export const BRIDGE_TOOLS = Object.freeze([
  {
    name: 'majin_status',
    description: 'Read the actual MAJIN bridge status, owner grants and available tool count. Performs no action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'majin_tools_search',
    description: 'Search the real owner-authorized MAJIN tool catalog. This is not a capability wish-list. Follow with majin_tool_schema, then majin_tool_call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search name, capability, description or lane' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    name: 'majin_tool_schema',
    description: 'Read the exact inputSchema for one authorized MAJIN tool. Does not execute it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact name from majin_tools_search' } },
      required: ['name'], additionalProperties: false,
    },
  },
  {
    name: 'majin_tool_call',
    description: 'Execute one owner-authorized MAJIN tool through the existing persistent driver. Read its schema first. Supply a stable operationId; reuse it only for identical arguments. Never invent a new ID to retry an uncertain submission.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name' },
        operationId: { type: 'string', minLength: 1, maxLength: 160, description: 'Stable ID for exactly this effect' },
        arguments: { type: 'object', description: 'Exact tool-specific arguments from majin_tool_schema', additionalProperties: true },
      },
      required: ['name', 'operationId', 'arguments'], additionalProperties: false,
    },
  },
]);

export function parseBridgeOptions(argv = process.argv.slice(2), env = process.env) {
  const arg = (flag, fallback) => {
    const inline = argv.find((token) => token.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : argv[index + 1];
  };
  const workspace = path.resolve(arg('--workspace', process.cwd()));
  const dataDir = path.resolve(arg('--data-dir', env.MAJIN_V5_DATA_DIR
    || path.join(env.LOCALAPPDATA || path.join(env.HOME || process.cwd(), '.local', 'share'), 'MAJIN', 'v5')));
  const v6Home = path.resolve(arg('--v6-home', env.MAJIN_V6_HOME
    || path.join(env.LOCALAPPDATA || path.join(env.HOME || process.cwd(), '.local', 'share'), 'MAJIN', 'v6')));
  return { workspace, dataDir, v6Home, doctor: argv.includes('--doctor') };
}

export function assertIsolatedState({ dataDir, v6Home }) {
  const v5 = path.resolve(dataDir);
  const v6 = path.resolve(v6Home);
  if (v5 === v6) throw Object.assign(new Error('V6 home must not be the V5 data directory'), { code: 'V6_HOME_CONFLICT' });
  if (v6.startsWith(`${v5}${path.sep}`)) {
    throw Object.assign(new Error('V6 home must not live inside the V5 data directory'), { code: 'V6_HOME_CONFLICT' });
  }
  return true;
}

const toolError = (error, code = null) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      error: code || error?.code || 'BRIDGE_ERROR',
      message: String(error?.message || error).slice(0, 500),
      ...(error?.details ? { details: error.details } : {}),
    }),
  }],
  isError: true,
});

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });

export function createBridge({
  workspace, dataDir, v6Home, Driver = CodexDriver, getOwner = null, timeoutMs = 120000, log = null,
  driverStateDir = null,
} = {}) {
  if (!workspace || !dataDir || !v6Home) throw new Error('workspace, dataDir and v6Home are required');
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw Object.assign(new Error('Existing MAJIN V5 data directory not found; refusing to create a profile'), { code: 'V5_DATA_MISSING' });
  }
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw Object.assign(new Error('OpenCode workspace directory not found'), { code: 'WORKSPACE_MISSING' });
  }
  assertIsolatedState({ dataDir, v6Home });
  const grantFile = path.join(dataDir, 'owner-mode.json');
  const rights = getOwner || (() => {
    const owner = new OwnerMode({ file: grantFile });
    return { lanes: owner.activeLanes(), folders: owner.folders() };
  });
  const first = rights();
  const firstFolders = [...(first.folders || [])].sort();
  const firstLanes = [...(first.lanes || [])].sort();
  const stateDir = driverStateDir
    ? path.resolve(driverStateDir)
    : path.join(v6Home, 'driver-mcp');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  let driver = null;
  let boot = null;
  let builtFingerprint = fingerprintGrants({ lanes: firstLanes, folders: firstFolders });
  let grantsChangedSinceStart = false;
  let queue = Promise.resolve();

  function driverOptions(rightsNow) {
    const lanes = rightsNow.lanes || [];
    return {
      workspace,
      stateDir,
      allowedFolders: rightsNow.folders || [],
      grantedLanes: lanes,
      browser: lanes.includes('browser'),
      desktop: lanes.includes('desktop') || lanes.includes('computer'),
      processAccess: lanes.includes('shell') || lanes.includes('shelltools'),
      browserWriteOrigins: [],
      browserWriteOriginsFile: grantFile,
      browserVisible: true,
      timeoutMs,
    };
  }

  async function start() {
    if (driver?.catalog) return driver;
    if (!boot) {
      boot = (async () => {
        const instance = new Driver(driverOptions(rights()));
        try {
          await instance.start();
          driver = instance;
          return instance;
        } catch (error) {
          await instance.close().catch(() => {});
          throw error;
        }
      })().catch((error) => { boot = null; throw error; });
    }
    return boot;
  }

  async function rebuildIfGrantsChanged(rightsNow) {
    const currentFingerprint = fingerprintGrants({ lanes: rightsNow.lanes || [], folders: rightsNow.folders || [] });
    if (currentFingerprint === builtFingerprint) return false;
    // The driver is rebuilt from the owner file so both revocation and newly
    // added lanes take effect without restarting OpenCode. An in-flight tool
    // call finishes first because all calls are serialized below.
    grantsChangedSinceStart = true;
    log?.append('permission.blocked', {
      workerId: null, code: 'GRANTS_CHANGED_REBUILT',
      lanes: [...new Set((rightsNow.lanes || []))].sort(),
    });
    if (driver) await driver.close().catch(() => {});
    driver = null;
    boot = null;
    builtFingerprint = currentFingerprint;
    return true;
  }

  async function operate(name, args = {}) {
    try {
      if (!BRIDGE_TOOLS.some((tool) => tool.name === name)) {
        throw Object.assign(new Error(`Unknown bridge tool: ${name}`), { code: 'UNKNOWN_BRIDGE_TOOL' });
      }
      const current = rights();
      await rebuildIfGrantsChanged(current);
      const lanes = [...(current.lanes || [])].sort();
      const instance = await start();
      const catalog = instance.list();
      const available = catalog.filter((entry) => isAuthorized(entry, lanes));

      if (name === 'majin_status') {
        return ok({
          bridge: 'MAJIN V6 OpenCode bridge',
          operational: true,
          provider: 'OpenCode retains its existing model; no MAJIN provider was started',
          workspace,
          v5DataDir: dataDir,
          v6Home,
          driverStateDir: stateDir,
          registered: catalog.length,
          authorized: available.length,
          ownerGrantedLanes: lanes,
          ownerGrantedFolders: (current.folders || []).length,
          grantsChangedSinceStart,
          note: 'Registered or authorized tools are not proof that an external action works. Execute and inspect the receipt.',
        });
      }
      if (name === 'majin_tools_search') {
        if (typeof args.query !== 'string') throw Object.assign(new Error('query must be a string'), { code: 'INVALID_ARGUMENTS' });
        return ok({
          matches: filterCatalog(catalog, lanes, args.query, args.limit || 20),
          counts: { registered: catalog.length, authorized: available.length },
          note: 'Unavailable legacy tools may exist; this list is the real authorized surface only.',
        });
      }
      if (name === 'majin_tool_schema') {
        if (typeof args.name !== 'string' || !args.name) throw Object.assign(new Error('name is required'), { code: 'INVALID_ARGUMENTS' });
        const entry = catalog.find((tool) => tool.name === args.name && isAuthorized(tool, lanes));
        if (!entry) throw Object.assign(new Error('Tool not found or not authorized'), { code: 'TOOL_NOT_AUTHORIZED' });
        const { operationId: _ignored, ...properties } = entry.inputSchema?.properties || {};
        return ok({
          name: entry.name,
          lane: requiredLane(entry),
          inputSchema: {
            ...entry.inputSchema,
            properties,
            required: (entry.inputSchema?.required || []).filter((key) => key !== 'operationId'),
          },
          operationId: 'Pass operationId on majin_tool_call, not inside arguments',
        });
      }
      // majin_tool_call
      if (typeof args.name !== 'string' || !args.name) throw Object.assign(new Error('name is required'), { code: 'INVALID_ARGUMENTS' });
      if (typeof args.operationId !== 'string' || !args.operationId || args.operationId.length > 160) {
        throw Object.assign(new Error('operationId must be 1-160 characters'), { code: 'INVALID_ARGUMENTS' });
      }
      if (!args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) {
        throw Object.assign(new Error('arguments must be an object'), { code: 'INVALID_ARGUMENTS' });
      }
      if (Object.hasOwn(args.arguments, 'operationId')) {
        throw Object.assign(new Error('operationId belongs at the outer call level, not inside arguments'), { code: 'INVALID_ARGUMENTS' });
      }
      const entry = catalog.find((tool) => tool.name === args.name && isAuthorized(tool, lanes));
      if (!entry) throw Object.assign(new Error('Tool missing or owner permission denied'), { code: 'TOOL_NOT_AUTHORIZED' });
      log?.append('mcp.call', {
        workerId: null, tool: entry.name, operationId: args.operationId,
        irreversible: /submit|send|delete|write|upload|apply/i.test(entry.name),
      });
      // The driver is single-operation by design; serialize tool calls so a
      // second MCP request waits instead of failing with a spurious busy error.
      const run = queue.then(() => driver.call(entry.name, { ...args.arguments, operationId: args.operationId }));
      queue = run.catch(() => {});
      return await run;
    } catch (error) {
      return toolError(error);
    }
  }

  /**
   * Authorized tool execution for the V6 worker. Same permission boundary as
   * majin_tool_call; returns the driver response unchanged.
   */
  async function callTool(name, args = {}) {
    if (typeof name !== 'string' || !name) throw Object.assign(new Error('name is required'), { code: 'INVALID_ARGUMENTS' });
    const { operationId, ...toolArgs } = args;
    if (typeof operationId !== 'string' || !operationId || operationId.length > 160) {
      throw Object.assign(new Error('operationId must be 1-160 characters'), { code: 'INVALID_ARGUMENTS' });
    }
    const current = rights();
    await rebuildIfGrantsChanged(current);
    const lanes = [...(current.lanes || [])].sort();
    const instance = await start();
    const entry = instance.list().find((tool) => tool.name === name && isAuthorized(tool, lanes));
    if (!entry) throw Object.assign(new Error('Tool missing or owner permission denied'), { code: 'TOOL_NOT_AUTHORIZED' });
    log?.append('mcp.call', {
      workerId: null, tool: entry.name, operationId,
      irreversible: /submit|send|delete|write|upload|apply/i.test(entry.name),
    });
    const run = queue.then(() => instance.call(entry.name, { ...toolArgs, operationId }));
    queue = run.catch(() => {});
    return run;
  }

  async function cancel(operationId) {
    if (!driver) return null;
    try { return await driver.cancel(operationId, 'CANCELLED'); } catch { return null; }
  }

  async function close() {
    if (driver) await driver.close().catch(() => {});
    driver = null;
    boot = null;
  }

  return { operate, start, close, cancel, callTool, grantFile, driverStateDir: stateDir, options: driverOptions(first) };
}
