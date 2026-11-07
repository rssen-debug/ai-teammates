/**
 * MAJIN V6 — MCP server for OpenCode (stdio JSON-RPC 2.0).
 *
 * Discovery is explicit: four stable bridge meta-tools plus a small set of
 * durable-work tools. The large MAJIN catalog is searched, never dumped into
 * the model context.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRIDGE_TOOLS } from './bridge.js';
import { workerSnapshots } from './report.js';
import { VERSION } from '../core/version.js';
import { clampInt } from './util.js';

export const V6_TOOLS = Object.freeze([
  {
    name: 'v6_status',
    description: 'Read the real persisted V6 work state: queue counts, worker health, recent task events and checks. No action is performed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'v6_queue_add',
    description: 'Queue a bounded background task. Use kind "tool" with payload {tool, arguments} for a MAJIN tool, or "job.discover"/"job.evaluate"/"gmail.verify". Deduplicate with a stable dedupeKey.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Task kind, e.g. tool, job.discover, job.evaluate, gmail.verify' },
        title: { type: 'string' },
        payload: { type: 'object', additionalProperties: true },
        priority: { type: 'integer', minimum: -100, maximum: 100, default: 0 },
        dedupeKey: { type: 'string', maxLength: 200 },
        deps: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        irreversible: { type: 'boolean', description: 'True only for external side effects that must never be replayed' },
      },
      required: ['kind'], additionalProperties: false,
    },
  },
  {
    name: 'v6_queue_list',
    description: 'List durable tasks, optionally filtered by state or kind.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string' }, kind: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'v6_task_get',
    description: 'Read one task including attempts, progress, lease and last error. Use this instead of guessing why work stopped.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'v6_task_cancel',
    description: 'Cancel queued or retryable work. A running task is cancelled at the next safe point; an uncertain external effect is never replayed by cancelling.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'v6_work_start',
    description: 'Start a detached, bounded V6 worker process that continues queued work without another chat turn. Requires explicit task and runtime budgets.',
    inputSchema: {
      type: 'object',
      properties: {
        maxTasks: { type: 'integer', minimum: 1, maximum: 500, default: 10 },
        maxRuntimeMs: { type: 'integer', minimum: 1000, maximum: 7200000, default: 900000 },
        workerId: { type: 'string', maxLength: 64 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'v6_work_stop',
    description: 'Ask running V6 workers to stop after their current task by writing the STOP marker. Does not fabricate a completion.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

export const ALL_MCP_TOOLS = Object.freeze([...BRIDGE_TOOLS, ...V6_TOOLS]);

const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

class ArgumentError extends Error {
  constructor(message) { super(message); this.name = 'ArgumentError'; this.code = 'INVALID_ARGUMENTS'; }
}

function assertObject(args) {
  if (args == null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ArgumentError('arguments must be an object');
  return args;
}

function onlyKeys(args, allowed) {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new ArgumentError(`Unknown argument: ${key}`);
}

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}

export function validateV6Arguments(name, raw) {
  const args = assertObject(raw);
  switch (name) {
    case 'v6_status':
    case 'v6_work_stop':
      onlyKeys(args, []);
      return args;
    case 'v6_work_start':
      onlyKeys(args, ['maxTasks', 'maxRuntimeMs', 'workerId']);
      if (args.maxTasks != null && (!Number.isInteger(args.maxTasks) || args.maxTasks < 1 || args.maxTasks > 500)) throw new ArgumentError('maxTasks must be 1-500');
      if (args.maxRuntimeMs != null && (!Number.isInteger(args.maxRuntimeMs) || args.maxRuntimeMs < 1000 || args.maxRuntimeMs > 7_200_000)) throw new ArgumentError('maxRuntimeMs must be 1000-7200000');
      if (args.workerId != null && (typeof args.workerId !== 'string' || args.workerId.length > 64)) throw new ArgumentError('workerId must be a short string');
      return args;
    case 'v6_queue_add':
      onlyKeys(args, ['kind', 'title', 'payload', 'priority', 'dedupeKey', 'deps', 'irreversible']);
      if (typeof args.kind !== 'string' || !/^[a-z][a-z0-9_.-]{1,60}$/.test(args.kind)) throw new ArgumentError('kind is invalid');
      if (args.payload != null && (typeof args.payload !== 'object' || Array.isArray(args.payload))) throw new ArgumentError('payload must be an object');
      if (args.priority != null && (!Number.isInteger(args.priority) || Math.abs(args.priority) > 100)) throw new ArgumentError('priority must be -100..100');
      if (args.dedupeKey != null && (typeof args.dedupeKey !== 'string' || args.dedupeKey.length > 200)) throw new ArgumentError('dedupeKey is invalid');
      if (args.deps != null && (!Array.isArray(args.deps) || args.deps.length > 20 || args.deps.some((id) => typeof id !== 'string'))) throw new ArgumentError('deps must be an array of task ids');
      if (args.irreversible != null && typeof args.irreversible !== 'boolean') throw new ArgumentError('irreversible must be boolean');
      return args;
    case 'v6_queue_list':
      onlyKeys(args, ['state', 'kind', 'limit']);
      if (args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new ArgumentError('limit must be 1-100');
      return args;
    case 'v6_task_get':
    case 'v6_task_cancel':
      onlyKeys(args, ['id']);
      if (typeof args.id !== 'string' || !args.id) throw new ArgumentError('id is required');
      return args;
    default:
      throw new ArgumentError(`Unknown V6 tool ${name}`);
  }
}

export function createV6Server({
  bridge, queue, log, home, workersDir, stopFile, workspace = null, dataDir = null,
  clock = Date.now, spawnWorker = null,
} = {}) {
  if (!bridge) throw new Error('createV6Server requires a bridge');
  const inflight = new Map();
  let callChain = Promise.resolve();

  async function status() {
    const queueStats = await queue.stats();
    const workers = workerSnapshots(workersDir, { now: clock() });
    const events = log ? log.read({ limit: 10 }).map((event) => ({ at: event.at, type: event.type, taskId: event.taskId || null })) : [];
    return {
      home,
      queue: queueStats,
      workers,
      engine: workers.some((worker) => worker.state === 'ACTIVE') ? 'RUNNING' : (workers.length ? 'IDLE_OR_STALLED' : 'NOT_RUNNING'),
      recent: events,
      stopMarker: stopFile ? fs.existsSync(stopFile) : null,
      note: 'Counts come from the durable queue file; worker health comes from heartbeat files.',
    };
  }

  async function startWorker(args) {
    const maxTasks = clampInt(args.maxTasks, { min: 1, max: 500, fallback: 10 });
    const maxRuntimeMs = clampInt(args.maxRuntimeMs, { min: 1000, max: 7_200_000, fallback: 900_000 });
    const workerId = typeof args.workerId === 'string' && args.workerId.trim()
      ? args.workerId.trim().replace(/[^a-z0-9_-]/gi, '-').slice(0, 64)
      : `mcp-${Date.now().toString(36)}`;
    const existing = workerSnapshots(workersDir, { now: clock() }).filter((worker) => worker.state === 'ACTIVE' || worker.state === 'IDLE');
    if (existing.length >= 4) return textResult({ error: 'WORKER_LIMIT', message: 'Four workers are already live; stop one before starting another.', workers: existing }, true);
    const spawnImpl = spawnWorker || ((command, argv, opts) => spawn(command, argv, opts));
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/majin-v6.mjs');
    const workerArgs = [
      bin, 'worker', '--v6-home', home, '--max-tasks', String(maxTasks),
      '--max-runtime-ms', String(maxRuntimeMs), '--worker-id', workerId,
    ];
    // The spawned worker must read the same V5 grants and workspace the bridge
    // was started with; defaults would silently point at another profile.
    if (workspace) workerArgs.push('--workspace', workspace);
    if (dataDir) workerArgs.push('--data-dir', dataDir);
    const child = spawnImpl(process.execPath, workerArgs, {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, MAJIN_V6_HOME: home },
    });
    child.unref?.();
    log?.append('engine.started', {
      workerId, maxTasks, maxRuntimeMs, source: 'mcp', pid: child.pid || null,
      note: 'Detached worker process requested through MCP',
    });
    return textResult({
      started: true, workerId, pid: child.pid ?? null, maxTasks, maxRuntimeMs,
      note: 'The worker continues queued tasks. Use v6_status for real progress; this response is not evidence that any task succeeded.',
    });
  }

  async function dispatch(name, rawArgs) {
    const args = assertObject(rawArgs);
    if (BRIDGE_TOOLS.some((tool) => tool.name === name)) return bridge.operate(name, args);
    validateV6Arguments(name, args);
    switch (name) {
      case 'v6_status':
        return textResult(await status());
      case 'v6_queue_add': {
        const added = await queue.add({
          kind: args.kind, title: args.title, payload: args.payload,
          priority: args.priority, dedupeKey: args.dedupeKey, deps: args.deps,
          irreversible: args.irreversible === true, by: 'opencode',
        });
        return textResult(added);
      }
      case 'v6_queue_list':
        return textResult({ tasks: await queue.list({ state: args.state || null, kind: args.kind || null, limit: args.limit || 20 }) });
      case 'v6_task_get': {
        const task = await queue.get(args.id);
        if (!task) return textResult({ error: 'TASK_NOT_FOUND', id: args.id }, true);
        return textResult(task);
      }
      case 'v6_task_cancel': {
        try {
          return textResult(await queue.cancel(args.id, { by: 'opencode' }));
        } catch (error) {
          return textResult({ error: error.code || 'TASK_CANCEL_FAILED', message: error.message }, true);
        }
      }
      case 'v6_work_start':
        return startWorker(args);
      case 'v6_work_stop': {
        fs.mkdirSync(path.dirname(stopFile), { recursive: true });
        fs.writeFileSync(stopFile, JSON.stringify({ requestedAt: new Date(clock()).toISOString(), by: 'opencode' }), { mode: 0o600 });
        return textResult({ stopRequested: true, marker: stopFile, note: 'Workers stop after the current task. In-flight external effects remain governed by their leases.' });
      }
      default:
        throw new ArgumentError(`Unknown tool ${name}`);
    }
  }

  function serialize(fn) {
    const run = callChain.then(fn, fn);
    callChain = run.catch(() => {});
    return run;
  }

  async function handle(msg, { notify = () => {} } = {}) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (msg.method === 'notifications/cancelled') {
      const entry = inflight.get(msg.params?.requestId);
      if (entry) {
        entry.cancelled = true;
        if (entry.operationId) await bridge.cancel(entry.operationId).catch(() => {});
        log?.append('tool.cancelled', { workerId: null, operationId: entry.operationId || null, requestId: String(msg.params?.requestId ?? '') });
      }
      return null;
    }
    if (msg.id == null) return null; // notifications/initialized etc.
    const id = msg.id;
    try {
      if (msg.method === 'initialize') {
        const requested = msg.params?.protocolVersion;
        log?.append('mcp.started', { workerId: null, protocolVersion: requested || null });
        return {
          jsonrpc: '2.0', id, result: {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2025-06-18',
            serverInfo: { name: 'majin-v6', version: VERSION },
            capabilities: { tools: { listChanged: false } },
            instructions: 'MAJIN V6 exposes real, owner-authorized host tools. Discover with majin_tools_search, read exact schemas, then execute with a stable operationId. Durable work continues via the V6 queue and worker; never claim an external action succeeded without a receipt.',
          },
        };
      }
      if (msg.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (msg.method === 'tools/list') {
        const cursor = Number.parseInt(msg.params?.cursor || '0', 10);
        const offset = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
        const pageSize = 50;
        const page = ALL_MCP_TOOLS.slice(offset, offset + pageSize);
        const next = offset + pageSize < ALL_MCP_TOOLS.length ? String(offset + pageSize) : undefined;
        return { jsonrpc: '2.0', id, result: { tools: page, ...(next ? { nextCursor: next } : {}) } };
      }
      if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        if (typeof name !== 'string' || !ALL_MCP_TOOLS.some((tool) => tool.name === name)) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } };
        }
        const progressToken = msg.params?._meta?.progressToken;
        const operationId = name === 'majin_tool_call' ? msg.params?.arguments?.operationId : null;
        const entry = { cancelled: false, operationId };
        inflight.set(id, entry);
        if (progressToken != null) notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: 0, message: `${name} started` } });
        try {
          const result = await serialize(() => dispatch(name, msg.params?.arguments));
          if (progressToken != null) notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: 1, message: `${name} finished` } });
          return { jsonrpc: '2.0', id, result };
        } catch (error) {
          const code = error instanceof ArgumentError ? -32602 : -32603;
          return { jsonrpc: '2.0', id, error: { code, message: String(error.message || error).slice(0, 500), data: { code: error.code || 'MCP_ERROR' } } };
        } finally {
          inflight.delete(id);
        }
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: String(error.message || error).slice(0, 500) } };
    }
  }

  return { handle, status, dispatch, tools: ALL_MCP_TOOLS, inflight };
}
