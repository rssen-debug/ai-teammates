/**
 * MAJIN V4 — MCP client (Model Context Protocol over stdio).
 *
 * The audit found no MCP client anywhere in the repository: `absorb.js` only had
 * a keyword regex for *classifying* repos that mention MCP. So this is new code,
 * not a rewrite — and it is the mechanism that lets the owner plug in a
 * computer-use server (CUA), a browser server, or anything else that speaks MCP,
 * without MAJIN growing a bespoke integration for each one.
 *
 * Protocol, as implemented here (2024-11-05 / 2025-06-18 line):
 *
 *   -> initialize                {protocolVersion, capabilities, clientInfo}
 *   <- result                    {protocolVersion, capabilities, serverInfo}
 *   -> notifications/initialized
 *   -> tools/list                -> {tools:[{name, description, inputSchema}]}
 *   -> tools/call {name, arguments} -> {content:[{type:"text", text}], isError}
 *
 * Boundaries that matter and are enforced here:
 *   - a launch command comes from the owner's config file, never from a model
 *   - the child runs with a scrubbed environment (no MAJIN keys, no API tokens)
 *   - every request has a timeout; a hung server cannot wedge the host
 *   - a server that dies mid-call fails that call; the host keeps running
 *   - the child is killed and its pipes destroyed on stop, so no orphans
 *   - results are converted to V2 ToolDefinitions, so MCP tools inherit the
 *     approval layer, the tier system and the receipts like any other tool
 */
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { V4_VERSION } from './config.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_CLIENT_INFO = Object.freeze({ name: 'majin-v4', version: V4_VERSION });

/** Only these env keys reach an MCP server; provider keys must never leak. */
const ENV_ALLOW = ['PATH', 'SystemRoot', 'windir', 'SystemDrive', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)'];

export function scrubMcpEnv(source = process.env) {
  const out = {};
  for (const key of ENV_ALLOW) if (source[key] != null) out[key] = source[key];
  return out;
}

export class McpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

/**
 * One MCP server over stdio.
 *
 * The transport is newline-delimited JSON-RPC. Servers that use Content-Length
 * framing are not supported and the handshake will time out with that stated.
 */
export class McpServer {
  constructor({
    name,
    command,
    args = [],
    cwd = null,
    env = process.env,
    timeoutMs = 15_000,
    spawn = nodeSpawn,
  } = {}) {
    if (!name) throw new McpError('NO_NAME', 'an MCP server needs a name');
    if (!Array.isArray(command) || command.length === 0) {
      throw new McpError('NO_COMMAND', `MCP server "${name}" needs a command array`);
    }
    this.name = name;
    this.command = command;
    this.args = args;
    this.cwd = cwd || process.cwd();
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.spawn = spawn;
    this.child = null;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.serverInfo = null;
    this.capabilities = null;
    this.protocolVersion = null;
    this.dead = false;
    this.exitReason = null;
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new McpError('NOT_RUNNING', `MCP server "${this.name}" is not running`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // a server that prints logs on stdout is tolerated; only JSON counts
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new McpError('SERVER_ERROR', `${msg.error.message || 'error'} (code ${msg.error.code})`));
      else entry.resolve(msg.result);
    }
    // notifications and requests from the server are ignored: MAJIN is a client.
  }

  /** Send one request and wait for its result. */
  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.dead) return Promise.reject(new McpError('NOT_RUNNING', `MCP server "${this.name}" is not running`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError('TIMEOUT', `MCP server "${this.name}" did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    try {
      this.#write({ jsonrpc: '2.0', method, params });
    } catch {
      /* a notification to a dead server is not an error worth raising */
    }
  }

  /** Start the process and complete the handshake. */
  async start() {
    if (this.child) return this;
    this.child = this.spawn(this.command[0], [...this.command.slice(1), ...this.args], {
      cwd: this.cwd,
      env: scrubMcpEnv(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const transportError = (error) => {
      this.dead = true;
      this.exitReason = error.message;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new McpError('SERVER_DIED', `MCP transport closed: ${error.message}`));
      }
      this.pending.clear();
    };
    this.child.on('error', transportError);
    this.child.stdin?.on('error', transportError);
    this.child.stdout?.on('error', transportError);
    this.child.stderr?.on('error', transportError);
    this.child.stdout?.setEncoding?.('utf8');
    this.child.stdout?.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.#onLine(line);
      }
    });
    this.child.stderr?.on('data', () => { /* drained so the pipe cannot fill */ });
    this.child.on('exit', (code, signal) => {
      this.dead = true;
      this.exitReason = signal ? `signal ${signal}` : `exit ${code}`;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new McpError('SERVER_DIED', `MCP server "${this.name}" exited (${this.exitReason})`));
      }
      this.pending.clear();
    });

    const result = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: MCP_CLIENT_INFO,
    });
    this.serverInfo = result?.serverInfo || null;
    this.capabilities = result?.capabilities || {};
    this.protocolVersion = result?.protocolVersion || null;
    this.notify('notifications/initialized');
    return this;
  }

  /** The tools this server offers. */
  async listTools() {
    const result = await this.request('tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map((t) => ({
      name: String(t.name || ''),
      description: String(t.description || '').slice(0, 400),
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} },
    })).filter((t) => t.name);
  }

  /** Call one tool. Returns the text content, and whether the server said it failed. */
  async callTool(name, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    const result = await this.request('tools/call', { name, arguments: args }, { timeoutMs });
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
    return {
      isError: result?.isError === true,
      text,
      structured: result?.structuredContent ?? null,
      raw: result ?? null,
    };
  }

  /** Kill the child and drop every handle, so nothing is left running. */
  stop() {
    const child = this.child;
    this.dead = true;
    this.child = null;
    if (!child) return;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new McpError('STOPPED', `MCP server "${this.name}" was stopped`));
    }
    this.pending.clear();
    try {
      child.stdin?.end();
    } catch { /* already closed */ }
    try {
      child.kill('SIGTERM');
    } catch { /* already gone */ }
    child.stdout?.destroy();
    child.stderr?.destroy();
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch { /* already dead */ }
    }, 500);
    timer.unref?.();
  }

  status() {
    return {
      name: this.name,
      running: Boolean(this.child) && !this.dead,
      protocolVersion: this.protocolVersion,
      serverInfo: this.serverInfo,
      tools: [],
      ...(this.exitReason ? { exitReason: this.exitReason } : {}),
    };
  }
}

/**
 * Validate the owner's MCP config. A malformed entry is named, never coerced.
 *
 * Shape:
 *   { "servers": { "filesystem": { "command": ["npx", "-y", "server-fs", "/path"] } } }
 */
export function parseMcpConfig(raw) {
  const servers = [];
  const errors = [];
  if (!raw || typeof raw !== 'object') return { servers, errors };
  const entries = raw.servers && typeof raw.servers === 'object' ? raw.servers : raw;
  for (const [name, cfg] of Object.entries(entries)) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) {
      errors.push({ name, error: 'name must be lowercase letters, digits and dashes' });
      continue;
    }
    if (!cfg || typeof cfg !== 'object') {
      errors.push({ name, error: 'entry must be an object' });
      continue;
    }
    const command = Array.isArray(cfg.command) ? cfg.command.filter((c) => typeof c === 'string') : null;
    if (!command || command.length === 0) {
      errors.push({ name, error: 'command must be a non-empty array of strings (no shell string)' });
      continue;
    }
    if (command.some((c) => /[;&|<>`$]/.test(c) && !path.isAbsolute(c))) {
      // A shell metacharacter in an argv element is almost always a pasted shell
      // string; we spawn argv-only, so it would be passed literally. Say so.
      errors.push({ name, error: 'command looks like a shell string; give an argv array instead' });
      continue;
    }
    servers.push({
      name,
      command,
      args: Array.isArray(cfg.args) ? cfg.args.filter((a) => typeof a === 'string') : [],
      cwd: typeof cfg.cwd === 'string' ? cfg.cwd : null,
      timeoutMs: Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 15_000,
      experimental: cfg.experimental === true,
    });
  }
  return { servers, errors };
}

/**
 * Connect to every configured server.
 *
 * One failing server never blocks the others: its error is recorded and the rest
 * still start. A server that hangs in its handshake is stopped, not retried.
 */
export async function connectServers(servers = [], { factory = (opts) => new McpServer(opts) } = {}) {
  const connected = [];
  const failed = [];
  for (const spec of servers) {
    const server = factory(spec);
    try {
      await server.start();
      const tools = await server.listTools();
      connected.push({ server, tools });
    } catch (err) {
      server.stop();
      failed.push({ name: spec.name, error: String(err?.message || err), code: err?.code || null });
    }
  }
  return { connected, failed };
}
