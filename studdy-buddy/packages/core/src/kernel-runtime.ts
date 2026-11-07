/**
 * Kernel runtime bridge.
 *
 * This is where the unified kernel ({@link openKernel}) meets the legacy Buddy
 * surface. The kernel owns durability, budgets, effects and reporting; this
 * module supplies the *real* tools it can execute, using code that already
 * shipped and is already tested:
 *
 *  - `agent-desktop` through {@link DesktopAccessibilityAdapter}
 *  - the permission gate and site allowlist from {@link StuddyServices}
 *  - the verified-skill ledger
 *
 * Two rules are inherited and must not be relaxed here:
 *  1. a tool that requires a permission is refused before it runs, and the
 *     refusal is recorded as a real reason (never a silent no-op);
 *  2. a tool reports what actually happened. `ok: true` from the adapter is not
 *     upgraded to "verified" unless the evidence proves it — that upgrade is
 *     the verification gate's job, not this file's.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DesktopAccessibilityAdapter } from './desktop-adapter.js';
import type { StuddyServices } from './services.js';
import { VerifiedSkillLedger } from './verified-skills.js';

export interface KernelToolContext {
  operationId: string;
  signal: AbortSignal;
}

export interface KernelToolResult {
  record: { operationId: string; finishedAt: string; tool: string; lane: string };
  result: Record<string, unknown>;
}

export class KernelToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly uncertain: boolean;
  constructor(message: string, { code = 'TOOL_FAILED', retryable = true, uncertain = false }: {
    code?: string;
    retryable?: boolean;
    uncertain?: boolean;
  } = {}) {
    super(message);
    this.name = 'KernelToolError';
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

export interface KernelToolDefinition {
  /** Tool name as the queue refers to it. */
  name: string;
  description: string;
  /** Permission key required before the tool may act. Omit for observation. */
  permission?: Parameters<StuddyServices['permissions']['isGranted']>[0];
  /** Lane used by the authorization policy (`policy.ts`). */
  lane: string;
  /** True when the action changes something outside this process. */
  irreversible?: boolean;
  run: (args: Record<string, unknown>, context: KernelToolContext) => Promise<Record<string, unknown>>;
}

function asString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The tools a kernel worker can execute today. Deliberately small: these are
 * the operations that already have a real, tested implementation behind them.
 * Adding a tool here without a real implementation would be the exact kind of
 * fake capability this project forbids.
 */
export function buildKernelTools({ services, adapter }: {
  services: StuddyServices;
  adapter: DesktopAccessibilityAdapter;
}): Map<string, KernelToolDefinition> {
  const ledger = new VerifiedSkillLedger(services.db.checkpoints);
  const tools: KernelToolDefinition[] = [
    {
      name: 'windows.list',
      lane: 'screen',
      permission: 'application.observe',
      description: 'List real top-level windows through the native helper.',
      run: async () => {
        const result = await adapter.listWindows();
        if (result.error) throw new KernelToolError(result.error, { code: 'WINDOWS_ENUM_FAILED' });
        return { windows: result.windows.map((w) => ({ id: w.id, app: w.appKind, focused: w.focused, minimized: w.minimized })), count: result.windows.length };
      },
    },
    {
      name: 'window.snapshot',
      lane: 'screen',
      permission: 'application.observe',
      description: 'Read the accessibility tree of one window with real refs.',
      run: async (args) => {
        const windowId = asString(args, 'windowId');
        if (!windowId) throw new KernelToolError('windowId is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const snapshot = await adapter.snapshot(windowId);
        if (!snapshot.accessible) {
          throw new KernelToolError(snapshot.note ?? 'UI tree is not readable for this window', {
            code: 'WINDOW_NOT_ACCESSIBLE',
            uncertain: false,
          });
        }
        ledger.record(`observe:${windowId}`.slice(0, 70), snapshot.elements.length > 0);
        return {
          accessible: true,
          elementCount: snapshot.elements.length,
          elements: snapshot.elements.slice(0, 60).map((e) => ({ ref: e.ref, role: e.role, name: e.name?.slice(0, 80) })),
        };
      },
    },
    {
      name: 'window.focus',
      lane: 'desktop',
      permission: 'computer.actions',
      description: 'Focus a window through the native helper.',
      run: async (args) => {
        const windowId = asString(args, 'windowId');
        if (!windowId) throw new KernelToolError('windowId is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const result = await adapter.focusWindow(windowId);
        if (!result.ok) throw new KernelToolError(result.detail, { code: 'FOCUS_FAILED' });
        return { ok: true, detail: result.detail };
      },
    },
    {
      name: 'app.launch',
      lane: 'desktop',
      permission: 'computer.actions',
      description: 'Launch an application by name (verified by the adapter).',
      irreversible: true,
      run: async (args) => {
        const app = asString(args, 'app');
        if (!app) throw new KernelToolError('app is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const result = await adapter.launchApp(app);
        if (!result.ok) throw new KernelToolError(result.detail, { code: 'LAUNCH_FAILED' });
        // The ledger only counts a launch when the adapter confirmed it.
        ledger.record(`launch:${app.toLowerCase().replace(/[^a-z0-9:._-]/g, '-').slice(0, 60)}`, true);
        return { ok: true, detail: result.detail };
      },
    },
    {
      name: 'ui.set_value',
      lane: 'desktop',
      permission: 'computer.actions',
      description: 'Set a UI element value semantically (headless-safe), then re-read the tree.',
      run: async (args) => {
        const ref = asString(args, 'ref');
        const text = typeof args.text === 'string' ? args.text : '';
        if (!ref) throw new KernelToolError('ref is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const result = await adapter.setValue(ref, text);
        if (!result.ok) throw new KernelToolError(result.detail, { code: 'SET_VALUE_FAILED' });
        return { ok: true, detail: result.detail };
      },
    },
    {
      name: 'ui.type',
      lane: 'desktop',
      permission: 'computer.actions',
      description: 'Type into a UI element. Physical delivery requires headed=true (Windows policy).',
      irreversible: true,
      run: async (args) => {
        const ref = asString(args, 'ref');
        const text = typeof args.text === 'string' ? args.text : '';
        const headed = args.headed === true;
        if (!ref) throw new KernelToolError('ref is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const result = await adapter.type(ref, text, { headed });
        if (!result.ok) throw new KernelToolError(result.detail, { code: 'TYPE_FAILED' });
        return { ok: true, detail: result.detail, headed };
      },
    },
    {
      name: 'ui.click',
      lane: 'desktop',
      permission: 'computer.actions',
      description: 'Click a previously observed UI ref.',
      irreversible: true,
      run: async (args) => {
        const ref = asString(args, 'ref');
        if (!ref) throw new KernelToolError('ref is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const result = await adapter.click(ref);
        if (!result.ok) throw new KernelToolError(result.detail, { code: 'CLICK_FAILED' });
        return { ok: true, detail: result.detail };
      },
    },
    {
      name: 'ui.press',
      lane: 'desktop',
      permission: 'computer.actions',
      description: 'Press a key combination, optionally scoped to a window.',
      irreversible: true,
      run: async (args) => {
        const combo = asString(args, 'combo');
        const windowId = asString(args, 'windowId') || undefined;
        if (!combo) throw new KernelToolError('combo is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const result = await adapter.press(combo, windowId);
        if (!result.ok) throw new KernelToolError(result.detail, { code: 'PRESS_FAILED' });
        return { ok: true, detail: result.detail };
      },
    },
    {
      name: 'screen.capture',
      lane: 'screen',
      permission: 'screen.capture',
      description: 'Save a screenshot of one window and confirm the file exists.',
      run: async (args) => {
        const windowId = asString(args, 'windowId');
        const path = asString(args, 'path');
        if (!windowId || !path) throw new KernelToolError('windowId and path are required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const result = await adapter.screenshot(windowId, path);
        if (!result.ok) throw new KernelToolError(result.detail, { code: 'SCREENSHOT_FAILED' });
        // The claim of a screenshot is only as good as the bytes on disk.
        if (!existsSync(path)) throw new KernelToolError('Adapter reported success but no file exists', { code: 'SCREENSHOT_MISSING' });
        const size = statSync(path).size;
        if (size <= 0) throw new KernelToolError('Screenshot file is empty', { code: 'SCREENSHOT_EMPTY' });
        return { ok: true, path, bytes: size, detail: result.detail };
      },
    },
    {
      name: 'fs.read',
      lane: 'files',
      description: 'Read a UTF-8 file that the owner explicitly names.',
      run: async (args) => {
        const raw = asString(args, 'path');
        if (!raw) throw new KernelToolError('path is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const target = resolve(raw);
        if (!existsSync(target)) throw new KernelToolError(`File not found: ${raw}`, { code: 'FILE_NOT_FOUND', retryable: false });
        const stat = statSync(target);
        if (!stat.isFile()) throw new KernelToolError(`Not a regular file: ${raw}`, { code: 'NOT_A_FILE', retryable: false });
        if (stat.size > 2 * 1024 * 1024) throw new KernelToolError('File is larger than the 2 MB read limit', { code: 'FILE_TOO_LARGE', retryable: false });
        const text = readFileSync(target, 'utf8');
        return { path: target, bytes: stat.size, chars: text.length, text: text.slice(0, 20_000) };
      },
    },
    {
      name: 'fs.stat',
      lane: 'files',
      description: 'Report real metadata for a path, including whether it exists.',
      run: async (args) => {
        const raw = asString(args, 'path');
        if (!raw) throw new KernelToolError('path is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        const target = resolve(raw);
        const exists = existsSync(target);
        if (!exists) return { path: target, exists: false };
        const stat = statSync(target);
        return { path: target, exists: true, isFile: stat.isFile(), bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      },
    },
    {
      name: 'memory.remember',
      lane: 'memory-service',
      description: 'Write an owner-approved fact to the local profile memory.',
      run: async (args) => {
        const text = asString(args, 'text');
        if (!text) throw new KernelToolError('text is required', { code: 'ARGUMENT_REQUIRED', retryable: false });
        if (!services.memory) throw new KernelToolError('Local memory is not configured for this data directory', { code: 'MEMORY_UNAVAILABLE', retryable: false });
        const stored = services.memory.rememberProfile(text.slice(0, 180));
        if (!stored) throw new KernelToolError('Memory refused the fact (redacted or malformed)', { code: 'MEMORY_REFUSED', retryable: false });
        ledger.record('memory:profile', true);
        return { ok: true, stored: text.slice(0, 180) };
      },
    },
    {
      name: 'time.now',
      lane: 'sys',
      description: 'Read the real clock. Useful as a zero-risk probe.',
      run: async () => ({ iso: new Date().toISOString(), epochMs: Date.now() }),
    },
  ];

  return new Map(tools.map((tool) => [tool.name, tool]));
}

export interface KernelInvokerOptions {
  services: StuddyServices;
  adapter: DesktopAccessibilityAdapter;
  /** Optional allowlist: when present, every tool name must be in it. */
  allow?: readonly string[] | null;
}

export interface KernelInvoker {
  tools: Map<string, KernelToolDefinition>;
  invoke: (name: string, args: Record<string, unknown>, context: KernelToolContext) => Promise<KernelToolResult>;
  /** Human-readable catalog for `studdy tools` and the MCP bridge. */
  catalog: () => { name: string; lane: string; permission: string | null; irreversible: boolean; description: string }[];
}

/**
 * Creates the tool invoker that a {@link Supervisor} calls. Permission checks
 * happen here, once, before any adapter call — so a revoked grant fails on the
 * very next task instead of leaking through a cached decision.
 */
export function createKernelInvoker({ services, adapter, allow = null }: KernelInvokerOptions): KernelInvoker {
  const tools = buildKernelTools({ services, adapter });
  const permitted = (name: string): boolean => (allow == null ? true : allow.includes(name));

  const catalog = () => [...tools.values()].map((tool) => ({
    name: tool.name,
    lane: tool.lane,
    permission: tool.permission ?? null,
    irreversible: tool.irreversible === true,
    description: tool.description,
  }));

  const invoke = async (name: string, args: Record<string, unknown>, context: KernelToolContext): Promise<KernelToolResult> => {
    const tool = tools.get(name);
    if (!tool) {
      throw new KernelToolError(`Unknown tool: ${name}`, { code: 'TOOL_NOT_FOUND', retryable: false });
    }
    if (!permitted(name)) {
      throw new KernelToolError(`Tool ${name} is not in the worker allowlist`, { code: 'TOOL_NOT_ALLOWED', retryable: false });
    }
    if (tool.permission && !services.permissions.isGranted(tool.permission)) {
      throw new KernelToolError(`Permission "${tool.permission}" is not granted for ${name}`, { code: 'PERMISSION_DENIED', retryable: false });
    }
    if (context.signal.aborted) {
      throw new KernelToolError(`Tool ${name} was cancelled before it started`, { code: 'TOOL_CANCELLED', retryable: true });
    }
    const result = await tool.run(args, context);
    return {
      record: { operationId: context.operationId, finishedAt: new Date().toISOString(), tool: name, lane: tool.lane },
      result,
    };
  };

  return { tools, invoke, catalog };
}
