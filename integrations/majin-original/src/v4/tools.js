/**
 * MAJIN V4 — the tool surface.
 *
 * Every tool is a V2 `ToolDefinition` and every call goes through the V2
 * runner: input schema -> approval policy -> execute with timeout -> output
 * schema. V4 adds only the workspace boundary and the JSON schemas the model
 * sees. Nothing here can reach outside the workspace sandbox.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { ToolRegistry } from '../v2/tools/registry.js';
import { runTool } from '../v2/tools/runner.js';
import { MemoryStore } from '../v2/memory/store.js';
import { extractText, ExtractError } from './extract.js';
import { modelSchemaOf } from './mcp-tools.js';
import { jsonSchemaFor } from './schema.js';
import { createToolExposure, searchRegistry } from './tool-exposure.js';
import { turnState } from './turn-state.js';
import { checkPath } from './path-access.js';
import {createMemorySyncTool} from './tools/memory-sync.js';

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_READ_BYTES = 200_000;

/**
 * A deterministic, bounded alternative for PDFs with custom-encoded fonts.
 * No pip installs, no shell interpolation, no changes to the source file.
 * Uses the pdfminer.six that is already installed, if present. The model no
 * longer has to burn 10+ turns discovering this same recovery every time.
 */
export function extractPdfWithInstalledPython(filePath, { runner = spawnSync } = {}) {
  const program = [
    'import sys',
    'from pdfminer.high_level import extract_text',
    'text = extract_text(sys.argv[1])',
    'sys.stdout.write(text[:150000])',
  ].join('\n');
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []]]
    : [['python3', []], ['python', []]];
  for (const [bin, prefix] of candidates) {
    try {
      const out = runner(bin, [...prefix, '-c', program, filePath], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 300000,
        windowsHide: true, shell: false,
      });
      if (out.status !== 0 || out.error) continue;
      const text = String(out.stdout || '').trim();
      // Reject short/garbled output rather than pretending recovery succeeded.
      if (text.length < 80 || /[\uFFFD\u0000-\u0008]/.test(text)) continue;
      const letters = (text.match(/[\p{L}]/gu) || []).length;
      if (letters < Math.min(40, text.length * 0.3)) continue;
      return { kind: 'pdf', text, confidence: 'text',
        warning: 'Read with installed pdfminer.six fallback after default extraction could not decode fonts.' };
    } catch { /* Python or pdfminer unavailable; leave normal failure visible. */ }
  }
  return null;
}


const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SEPARATORS = /[\\/]/;

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    // Map onto the V2 failure-class vocabulary so the scheduler and receipts
    // speak one language (src/v2/runtime/errors.js).
    this.cls = code === 'INVALID_PATH' || code === 'PERMISSION_DENIED'
      ? 'PERMISSION_DENIED'
      : code === 'TOO_LARGE' || code === 'INVALID_INPUT'
        ? 'INVALID_TOOL_OUTPUT'
        : code === 'FILE_EXISTS' || code === 'NOT_FOUND' || code === 'NOT_A_FILE'
          ? 'STALE_STATE'
          : 'UNKNOWN';
  }
}

/** A flat, create-only workspace: leaf filenames only, no traversal. */
export function safeFileName(raw) {
  if (typeof raw !== 'string') throw new WorkspaceError('INVALID_INPUT', 'fileName must be a string');
  const name = raw.trim();
  if (!name) throw new WorkspaceError('INVALID_INPUT', 'fileName is empty');
  if (name.length > 120) throw new WorkspaceError('INVALID_INPUT', 'fileName is too long');
  if (SEPARATORS.test(name) || name.includes('\0')) {
    throw new WorkspaceError('INVALID_PATH', 'fileName must be a leaf name without path separators');
  }
  if (name === '.' || name === '..' || name.startsWith('.')) {
    throw new WorkspaceError('INVALID_PATH', 'fileName may not start with a dot');
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
    throw new WorkspaceError('INVALID_PATH', 'fileName contains characters that are invalid on Windows');
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    throw new WorkspaceError('INVALID_PATH', 'fileName may not end with a dot or space');
  }
  if (RESERVED.test(name)) throw new WorkspaceError('INVALID_PATH', 'fileName is a reserved Windows device name');
  return name;
}

export function workspaceRoot(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return fs.realpathSync(dir);
}

function targetFor(root, rawName) {
  const name = safeFileName(rawName);
  const target = path.join(root, name);
  if (path.dirname(target) !== root) {
    throw new WorkspaceError('INVALID_PATH', 'resolved path escapes the workspace');
  }
  return { name, target };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Build the registry. `workspaceDir` is resolved once; `memory` is the V2
 * store so preferences written by MAJIN are readable by the rest of MAJIN.
 */
export function createToolRegistry({ workspaceDir, memoryDir, allowedRoots = () => [] }) {
  const root = workspaceRoot(workspaceDir);
  const memory = new MemoryStore(memoryDir);
  const registry = new ToolRegistry();
  // The owner's granted folders, read at call time so a grant from the phone
  // works immediately. Without this, document_read could only see the sandbox.
  const grantedFolders = () => {
    try {
      const value = typeof allowedRoots === 'function' ? allowedRoots() : allowedRoots;
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  registry.define(createMemorySyncTool({memory,workspaceDir:root,folders:grantedFolders}));

  registry.define({
    name: 'workspace_write',
    description: 'Create a new text file in the user workspace. Fails if the file already exists; never overwrites.',
    tier: 'write',
    inputSchema: z.object({
      fileName: z.string().min(1).max(120),
      content: z.string().max(MAX_FILE_BYTES),
    }),
    outputSchema: z.object({
      status: z.literal('created'),
      fileName: z.string(),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().length(64),
    }),
    execute: async ({ fileName, content }) => {
      const { name, target } = targetFor(root, fileName);
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_FILE_BYTES) throw new WorkspaceError('TOO_LARGE', `content exceeds ${MAX_FILE_BYTES} bytes`);
      let fd;
      try {
        fd = fs.openSync(target, 'wx', 0o600);
      } catch (err) {
        if (err.code === 'EEXIST') throw new WorkspaceError('FILE_EXISTS', `"${name}" already exists in the workspace`);
        if (err.code === 'EACCES' || err.code === 'EPERM') throw new WorkspaceError('PERMISSION_DENIED', `permission denied writing "${name}"`);
        throw err;
      }
      try {
        fs.writeFileSync(fd, content, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { status: 'created', fileName: name, path: target, bytes, sha256: sha256(Buffer.from(content, 'utf8')) };
    },
  });

  registry.define({
    name: 'workspace_read',
    description: 'Read a text file from the user workspace.',
    tier: 'read',
    inputSchema: z.object({ fileName: z.string().min(1).max(120) }),
    outputSchema: z.object({
      fileName: z.string(),
      content: z.string(),
      bytes: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    execute: async ({ fileName }) => {
      const { name, target } = targetFor(root, fileName);
      let stat;
      try {
        stat = fs.lstatSync(target);
      } catch {
        throw new WorkspaceError('NOT_FOUND', `"${name}" does not exist in the workspace`);
      }
      if (!stat.isFile()) throw new WorkspaceError('NOT_A_FILE', `"${name}" is not a regular file`);
      const buf = fs.readFileSync(target);
      const truncated = buf.length > MAX_READ_BYTES;
      return {
        fileName: name,
        content: buf.subarray(0, MAX_READ_BYTES).toString('utf8'),
        bytes: buf.length,
        truncated,
      };
    },
  });

  registry.define({
    name: 'workspace_list',
    description: 'List files in the user workspace with size and modification time.',
    tier: 'read',
    inputSchema: z.object({}),
    outputSchema: z.object({
      files: z.array(z.object({
        name: z.string(),
        bytes: z.number().int().nonnegative(),
        modifiedAt: z.string(),
      })).max(500),
    }),
    execute: async () => {
      const files = [];
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const st = fs.statSync(path.join(root, entry.name));
        files.push({ name: entry.name, bytes: st.size, modifiedAt: st.mtime.toISOString() });
      }
      return { files: files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1)).slice(0, 500) };
    },
  });

  /**
   * Read the text out of a document in the workspace: PDF, DOCX, XLSX or plain
   * text. This is what makes "find my CV and read it" a real task instead of a
   * file upload with nothing inside.
   *
   * The result carries `confidence`: 'text' when the extraction is clean,
   * 'partial' when some glyphs use a font encoding that could not be mapped.
   * A caller must not present 'partial' as a clean read.
   */
  registry.define({
    name: 'document_read',
    description:
      'Read the text inside a document (PDF, DOCX, XLSX, txt, md, csv, json). '
      + 'Use fileName for a file in the workspace, or path for a real file on the machine inside a '
      + 'folder the owner granted. Find it first with fs_find or fs_list.',
    tier: 'read',
    inputSchema: z.object({
      fileName: z.string().min(1).max(120).optional(),
      path: z.string().min(1).max(1000).optional(),
      maxChars: z.number().int().min(100).max(100_000).optional(),
    }),
    outputSchema: z.object({
      fileName: z.string(),
      kind: z.string(),
      confidence: z.enum(['text', 'partial']),
      chars: z.number().int().nonnegative(),
      truncated: z.boolean(),
      text: z.string(),
      warning: z.string().optional(),
    }),
    execute: async ({ fileName, path: realPath, maxChars = 20_000 }) => {
      if (!fileName && !realPath) {
        throw new WorkspaceError('INVALID_INPUT', 'give either fileName (workspace) or path (a real file)');
      }
      let name;
      let target;
      if (realPath) {
        // A path outside the workspace is allowed only inside a granted folder.
        const check = checkPath(realPath, { workspace: root, folders: grantedFolders() });
        if (!check.allowed) {
          throw new WorkspaceError('PERMISSION_DENIED', `${realPath} is ${check.reason}`);
        }
        target = check.abs;
        name = path.basename(target);
      } else {
        ({ name, target } = targetFor(root, fileName));
      }
      let stat;
      try {
        stat = fs.statSync(target);
      } catch {
        throw new WorkspaceError('NOT_FOUND', `"${realPath || name}" does not exist`);
      }
      if (!stat.isFile()) throw new WorkspaceError('NOT_A_FILE', `"${name}" is not a regular file`);
      let result;
      let extractFailure = null;
      try {
        result = extractText(fs.readFileSync(target), { fileName: name });
      } catch (err) {
        extractFailure = err;
      }
      // Other document formats are unaffected; PDFs can transparently use an
      // installed second engine when the built-in one cannot decode glyphs.
      if (/\.pdf$/i.test(name) && (extractFailure || result?.confidence === 'partial')) {
        result = extractPdfWithInstalledPython(target) || result;
      }
      if (!result) {
        if (extractFailure instanceof ExtractError) throw new WorkspaceError('EXTRACT_FAILED', `${extractFailure.code}: ${extractFailure.message}`);
        throw extractFailure || new WorkspaceError('EXTRACT_FAILED', 'No working PDF decoder available');
      }
      const truncated = result.text.length > maxChars;
      return {
        fileName: name,
        kind: result.kind,
        confidence: result.confidence,
        chars: result.text.length,
        truncated,
        text: truncated ? `${result.text.slice(0, maxChars)}
[truncated]` : result.text,
        ...(result.warning ? { warning: result.warning } : {}),
      };
    },
  });

  registry.define({
    name: 'memory_save',
    description: 'Remember a durable user preference or fact (key + short text) for future conversations.',
    tier: 'write',
    inputSchema: z.object({
      key: z.string().min(1).max(80),
      text: z.string().min(1).max(500),
      tags: z.array(z.string().max(24)).max(6).optional(),
    }),
    outputSchema: z.object({ saved: z.literal(true), key: z.string() }),
    execute: async ({ key, text, tags = [] }) => {
      const saved=memory.put('preference', { key, text, tags, importance: 0.8 });
      if(!saved||memory.get('preference',key)?.text!==text)throw new WorkspaceError('INVALID_INPUT','Memory entry was not retained: the namespace is full of higher-priority entries.');
      return { saved: true, key };
    },
  });

  registry.define({
    name: 'memory_search',
    description: 'Search remembered preferences and facts.',
    tier: 'read',
    inputSchema: z.object({ query: z.string().min(1).max(120), limit: z.number().int().min(1).max(20).optional() }),
    outputSchema: z.object({
      matches: z.array(z.object({ key: z.string(), text: z.string() })).max(20),
    }),
    execute: async ({ query, limit = 8 }) => ({
      matches: memory.search('preference', query, { limit }).map((e) => ({ key: e.key, text: e.text })),
    }),
  });

  /**
   * Tool discovery.
   *
   * With a universal registry (V1 lanes + MCP + plugins) the model cannot be
   * sent every schema on every request. It gets the core plus as many as the
   * budget allows, and these two tools make the rest reachable in one extra
   * round: search returns exact registered names, activate puts them in the
   * next round's list. Unknown names are reported, never silently dropped.
   */
  registry.define({
    name: 'tools_search',
    description:
      'Find a capability by describing the task in plain words. Returns registered tool names with '
      + 'their side-effect tier. Use it whenever the tool you need is not in the current list, then '
      + 'call tools_activate with the exact name before calling the tool.',
    tier: 'read',
    inputSchema: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    outputSchema: z.object({
      matches: z.array(z.object({
        name: z.string(),
        description: z.string(),
        tier: z.string().nullable(),
        lane: z.string().nullable(),
        score: z.number(),
      })).max(20),
      hidden: z.number().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ query, limit = 8 }) => {
      const st = turnState();
      // Inside a turn the exposure owns the real registry (and the subagent's
      // filtered view). Outside one, the registry this tool was defined on.
      const active = st?.exposure?.registry || registry;
      const hits = searchRegistry(active, query, {
        limit,
        exclude: ['tools_search', 'tools_activate'],
      });
      return {
        matches: hits,
        hidden: typeof st?.exposure?.hidden === 'function' ? st.exposure.hidden().length : 0,
        ...(hits.length
          ? {}
          : { note: `no registered tool matches "${String(query).slice(0, 60)}" — answer in plain words or rephrase with different nouns` }),
      };
    },
  });

  registry.define({
    name: 'tools_activate',
    description:
      'Make tools from tools_search callable in the next step. Pass exact registered names '
      + '(e.g. ["sys_info"]). Activating does not run anything and grants no permission: the '
      + 'owner approval policy still applies to every call.',
    tier: 'read',
    inputSchema: z.object({
      names: z.array(z.string().min(1).max(80)).min(1).max(12),
    }),
    outputSchema: z.object({
      activated: z.array(z.string()),
      already: z.array(z.string()),
      unknown: z.array(z.string()),
      total: z.number(),
      note: z.string().optional(),
    }),
    execute: async ({ names }) => {
      const st = turnState();
      if (!st?.exposure) {
        return { activated: [], already: [], unknown: [], total: registry.list().length, note: 'no active model turn' };
      }
      const out = st.exposure.activate(names);
      return {
        ...out,
        ...(out.unknown.length ? { note: `unknown tool(s): ${out.unknown.join(', ')} — use tools_search to get exact names` } : {}),
      };
    },
  });

  // The agent asks the tools object for the model-facing schema list, so adding a
  // tool to the registry is enough for the model to see it.
  const schemas = () => createToolExposure({ registry }).schemas();

  return { registry, memory, root, schemas };
}

/**
 * Turn a registered tool's zod input schema into the JSON Schema shape an
 * OpenAI-compatible model expects.
 *
 * A tool whose schema cannot be converted is skipped rather than breaking the
 * whole turn: a missing tool is visible in the capability report, a crash is not.
 */
// The conversion itself lives in schema.js so the exposure layer can use it
// without importing the tool surface. Re-exported here because this is where
// callers have always found it.
export { jsonSchemaFor };

/**
 * The tool list the MODEL sees, built from the live registry.
 *
 * This is the fix for the real V4 defect: `TOOL_SCHEMAS` was a hardcoded array of
 * five workspace tools, so no matter what was registered — host files, PowerShell,
 * Windows control — the model was only ever told about those five and could never
 * call the rest.
 *
 * Everything registered is exposed, because the runner is what enforces
 * permission, not the model's tool list. Hiding a tool from the list does not make
 * it safe; it only makes it unusable.
 */
export function schemasFromRegistry(registry, { limit = 60 } = {}) {
  const out = [];
  for (const summary of registry.list()) {
    if (out.length >= limit) break;
    const def = registry.get(summary.name);
    if (!def) continue;
    // A tool that carries its own JSON Schema (MCP servers do) is used verbatim:
    // converting it through zod would be a second source of truth that drifts
    // from the server's real arguments.
    const carried = modelSchemaOf(def);
    const parameters = carried
      ? (carried.type === 'object' ? carried : { type: 'object', properties: {} })
      : jsonSchemaFor(def.inputSchema);
    if (!parameters) continue; // unconvertible schema: skip, do not guess
    out.push({
      name: def.name,
      description: String(def.description || def.name).slice(0, 400),
      parameters,
    });
  }
  return out;
}

/**
 * Static fallback list.
 *
 * Kept because it documents the workspace surface in one place and is used by
 * tests that assert the built-ins exist. The agent no longer sends this: it sends
 * `schemasFromRegistry()`, which includes these and anything else registered.
 */
export const TOOL_SCHEMAS = [
  {
    name: 'workspace_write',
    description: 'Create a new text file in the user workspace (create-only, never overwrites).',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: 'Leaf filename, e.g. "rapport.txt". No folders.' },
        content: { type: 'string', description: 'Full UTF-8 text content of the file.' },
      },
      required: ['fileName', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_read',
    description: 'Read a text file from the user workspace.',
    parameters: {
      type: 'object',
      properties: { fileName: { type: 'string', description: 'Leaf filename to read.' } },
      required: ['fileName'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_list',
    description: 'List files in the user workspace.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'document_read',
    description: 'Read the text inside a document (PDF, DOCX, XLSX, txt) from the workspace or a folder the owner granted.',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: 'Leaf filename in the workspace, e.g. "cv.pdf".' },
        path: { type: 'string', description: 'Real file path inside a granted folder.' },
        maxChars: { type: 'number', description: 'How much text to return (default 20000).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_save',
    description: 'Remember a durable user preference or fact for later conversations.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short stable key, e.g. "language".' },
        text: { type: 'string', description: 'The fact or preference in one sentence.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      },
      required: ['key', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description: 'Search remembered preferences and facts.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

export { runTool };
