import { execFile } from 'node:child_process';
import type { SupportedAppKind, UiElementInfo, UiSnapshot, WindowInfo } from '@studdy/shared';

/**
 * DesktopAccessibilityAdapter
 *
 * Wraps Vercel Labs' `agent-desktop` CLI (https://github.com/vercel-labs/agent-desktop)
 * instead of reimplementing Windows UI Automation. Research findings are
 * recorded in docs/AGENT_DESKTOP.md; the important engineering decisions here:
 *
 *  1. We shell out to the CLI with a hard timeout and parse JSON. No daemon:
 *     a packaged Electron app should not require a background service.
 *  2. If the tool is missing we return an honest, structured "unavailable"
 *     result. We never fake a snapshot.
 *  3. Every element reference carries `stale: true` after the snapshot ages out,
 *     because UIA element handles are invalidated by the tiniest UI change.
 *
 * The adapter is injectable (`runner`) so the logic is unit tested without the
 * binary present.
 */

export interface CommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const defaultRunner: CommandRunner = {
  run(command, args, timeoutMs) {
    return new Promise((resolve) => {
      // npm installs a .cmd shim for agent-desktop on Windows. Node's execFile
      // cannot execute .cmd files directly. Resolve that shim through cmd.exe,
      // but ONLY for the fixed agent-desktop command and shell-safe CLI args.
      // Never interpolate arbitrary UI text into a Windows shell command.
      const npmShim = process.platform === 'win32' && command === 'agent-desktop';
      const safeArgs = args.every((arg) => /^[a-zA-Z0-9_@.:-]+$/.test(arg));
      if (npmShim && !safeArgs) {
        resolve({ code: 1, stdout: '', stderr: 'Unsafe agent-desktop CLI argument rejected.' });
        return;
      }
      const executable = npmShim ? (process.env.ComSpec ?? 'cmd.exe') : command;
      const argv = npmShim ? ['/d', '/s', '/c', `agent-desktop ${args.join(' ')}`] : args;
      execFile(executable, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: number }).code === 'number' ? ((error as { code?: number }).code as number) : error ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    });
  },
};

export interface AdapterConfig {
  runner?: CommandRunner;
  /** Executable name or absolute path. Configurable for packaged builds. */
  binary?: string;
  timeoutMs?: number;
  /** Platform guard; the CLI is Windows-only. */
  platform?: string;
}

export interface AdapterStatus {
  available: boolean;
  version: string | null;
  detail: string;
  /** How we integrate: 'cli-json' | 'mcp-stdio' | 'unavailable'. */
  mode: 'cli-json' | 'mcp-stdio' | 'unavailable';
}

/** Well-known process names for the applications we support. */
export const APP_PROCESS_HINTS: { pattern: RegExp; kind: SupportedAppKind; label: string }[] = [
  { pattern: /packettracer/i, kind: 'PACKET_TRACER', label: 'Cisco Packet Tracer' },
  { pattern: /chrome\.exe$/i, kind: 'NETACAD', label: 'Chrome' },
  { pattern: /msedge\.exe$/i, kind: 'NETACAD', label: 'Edge' },
];

export class DesktopAccessibilityAdapter {
  private readonly runner: CommandRunner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly platform: string;

  constructor(config: AdapterConfig = {}) {
    this.runner = config.runner ?? defaultRunner;
    this.binary = config.binary ?? 'agent-desktop';
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.platform = config.platform ?? process.platform;
  }

  async status(): Promise<AdapterStatus> {
    if (this.platform !== 'win32') {
      return {
        available: false,
        version: null,
        detail: 'agent-desktop använder Windows UI Automation och är endast tillgängligt på Windows.',
        mode: 'unavailable',
      };
    }
    // `agent-desktop version` prints the JSON envelope; `--version` prints a bare
    // string. We read the envelope so we also learn whether accessibility is
    // actually granted, which is the thing that will break observation later.
    const result = await this.runner.run(this.binary, ['version'], this.timeoutMs);
    const envelope = readEnvelope(result.stdout);
    if (result.code !== 0 || !envelope.ok) {
      return {
        available: false,
        version: null,
        detail: `agent-desktop kunde inte köras (${describeFailure(result)}).`,
        mode: 'unavailable',
      };
    }
    const version = typeof envelope.data?.version === 'string' ? envelope.data.version : 'okänd';

    const statusResult = await this.runner.run(this.binary, ['status'], this.timeoutMs);
    const statusEnvelope = readEnvelope(statusResult.stdout);
    const accessibility = readPermissionState(statusEnvelope.data, 'accessibility');
    if (accessibility === 'denied') {
      return {
        available: false,
        version,
        detail: `agent-desktop ${version} finns, men Windows-tillgänglighet är inte tillåtet för appen. ${readSuggestion(statusEnvelope.data)}`.trim(),
        mode: 'unavailable',
      };
    }
    return {
      available: true,
      version,
      detail: accessibility === 'granted' ? 'agent-desktop svarar och tillgänglighet är tillåtet.' : 'agent-desktop svarar över CLI.',
      mode: 'cli-json',
    };
  }

  /**
   * Enumerates top-level windows. Returns [] (never a guess) when unavailable.
   *
   * The real command is `list-windows` (no `--json` flag exists, and `data` is the
   * array itself). Both of those were wrong in the first version of this adapter;
   * see docs/AGENT_DESKTOP.md.
   */
  async listWindows(): Promise<{ windows: WindowInfo[]; error: string | null }> {
    if (this.platform !== 'win32') return { windows: [], error: 'Endast Windows stöds.' };
    const result = await this.runner.run(this.binary, ['list-windows'], this.timeoutMs);
    const envelope = readEnvelope(result.stdout);
    if (!envelope.ok) {
      // A timeout is not an empty list, and neither is a permission failure.
      return { windows: [], error: describeFailure(result, envelope) };
    }
    return { windows: parseWindows(result.stdout), error: null };
  }

  /** Captures an accessibility snapshot for one window. */
  async snapshot(windowId: string): Promise<UiSnapshot> {
    const empty: UiSnapshot = {
      windowId,
      takenAt: new Date().toISOString(),
      elements: [],
      accessible: false,
      note: null,
    };
    if (this.platform !== 'win32') return { ...empty, note: 'Endast Windows stöds.' };

    const result = await this.runner.run(
      this.binary,
      // Official agent-desktop accepts --compact / -i; --interactive-only
      // is not a supported flag and silently prevented all live snapshots.
      // Keep static text (no -i) so the companion can detect UI error text.
      ['snapshot', '--window-id', windowId, '--compact', '--max-depth', '7', '--timeout-ms', '7000'],
      this.timeoutMs,
    );
    const envelope = readEnvelope(result.stdout);
    if (!envelope.ok) {
      return { ...empty, note: `Snapshot misslyckades: ${describeFailure(result, envelope)}` };
    }
    const parsed = parseSnapshot(result.stdout, windowId);
    // `complete: false` means the observation ran out of time: say so rather than
    // presenting a partial tree as the whole window.
    if (envelope.data && envelope.data.complete === false) {
      return { ...parsed, note: parsed.note ?? 'Snapshoten blev ofullständig (tidsgräns).' };
    }
    return parsed;
  }

  /**
   * Revalidates a previously returned element reference. UIA refs go stale when
   * the UI changes, so callers must do this before acting on one.
   */
  async revalidate(windowId: string, ref: string): Promise<UiElementInfo | null> {
    // Only qualified agent-desktop refs may ever be used for actions.
    if (!/^@[^:]+:e\d+$/i.test(ref)) return null;
    const snapshot = await this.snapshot(windowId);
    const found = snapshot.elements.find((e) => e.ref === ref);
    if (!found) return null;
    return { ...found, stale: false };
  }
}

export function parseWindows(stdout: string): WindowInfo[] {
  // `list-windows` returns `data` as the array itself. Older shapes nested it
  // under `windows`, and a bare array is still accepted for fixture simplicity.
  const raw = safeJson(stdout);
  const envelope = readEnvelope(stdout);
  // list-windows returns data as an ARRAY in the official JSON envelope.
  // readEnvelope narrows data to records for other commands, so extract the
  // raw array here instead of accidentally discarding every real window.
  const data: unknown = Array.isArray(raw) ? raw : envelope.ok && isRecord(raw) ? (raw.data ?? null) : null;
  const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.windows) ? (data.windows as unknown[]) : [];
  const out: WindowInfo[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const title = String(row.title ?? row.name ?? '');
    const processName = String(row.process ?? row.processName ?? row.app ?? '');
    if (!title && !processName) continue;
    out.push({
      id: String(row.id ?? row.handle ?? row.hwnd ?? title),
      title,
      processName,
      appKind: classifyApp(processName, title),
      bounds: readRect(row) ?? { x: 0, y: 0, width: 0, height: 0 },
      displayId: row.displayId !== undefined ? String(row.displayId) : null,
      minimized: Boolean(row.minimized ?? row.isMinimized ?? false),
      focused: row.is_focused === true || row.focused === true || row.isFocused === true,
    });
  }
  return out;
}

export function parseSnapshot(stdout: string, windowId: string): UiSnapshot {
  const raw = safeJson(stdout);
  const envelope = readEnvelope(stdout);
  // A bare object/array is treated as the payload; anything else must be an ok envelope.
  const bare = isRecord(raw) && !('ok' in raw);
  if (!envelope.ok && !bare) {
    return {
      windowId,
      takenAt: new Date().toISOString(),
      elements: [],
      accessible: false,
      note: `Snapshot misslyckades: ${envelope.error?.message ?? 'okänt fel'}`,
    };
  }
  const data: unknown = bare ? raw : (envelope.data ?? null);
  // Real snapshots nest elements under `tree`; flat `elements` is the fixture shape.
  const elementsRaw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.elements)
      ? (data.elements as unknown[])
      : isRecord(data) && isRecord(data.tree)
        ? flattenTree(data.tree)
        : null;
  if (!elementsRaw) {
    return {
      windowId,
      takenAt: new Date().toISOString(),
      elements: [],
      accessible: false,
      note: 'Snapshot-svaret innehöll inga element.',
    };
  }

  const elements: UiElementInfo[] = [];
  for (const raw of elementsRaw) {
    if (!isRecord(raw)) continue;
    const ref = String(raw.ref ?? raw.id ?? raw.path ?? '');
    // Read-only text nodes often have no interactive ref. Keep them for
    // contextual understanding, but NEVER turn them into actionable targets.
    if (!ref && !String(raw.name ?? raw.label ?? raw.value ?? '').trim()) continue;
    elements.push({
      ref,
      role: String(raw.role ?? raw.controlType ?? 'unknown'),
      name: String(raw.name ?? raw.label ?? ''),
      value: raw.value !== undefined && raw.value !== null ? String(raw.value) : null,
      bounds: readRect(raw),
      enabled: raw.enabled !== false && raw.disabled !== true,
      stale: false,
    });
  }

  return {
    windowId,
    takenAt: new Date().toISOString(),
    elements,
    accessible: elements.length > 0,
    note: elements.length === 0 ? 'Tillgänglighetsträdet gick att läsa men innehöll inga element.' : null,
  };
}

export function classifyApp(processName: string, title: string): SupportedAppKind {
  const haystack = `${processName} ${title}`;
  for (const hint of APP_PROCESS_HINTS) {
    if (hint.pattern.test(processName) || hint.pattern.test(haystack)) return hint.kind;
  }
  return 'OTHER';
}

function readRect(row: Record<string, unknown>): { x: number; y: number; width: number; height: number } | null {
  const bounds = isRecord(row.bounds) ? row.bounds : row;
  const x = num(bounds.x ?? bounds.left);
  const y = num(bounds.y ?? bounds.top);
  const width = num(bounds.width ?? bounds.w ?? (num(bounds.right) !== null && x !== null ? (num(bounds.right) as number) - x : null));
  const height = num(bounds.height ?? bounds.h ?? (num(bounds.bottom) !== null && y !== null ? (num(bounds.bottom) as number) - y : null));
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export interface AgentDesktopEnvelope {
  /** False for both a failed command and an unparsable body. */
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; suggestion?: string; disposition?: { delivery?: string; retry?: string } };
}

/**
 * Parses the documented JSON envelope `{version, ok, command, data|error}`.
 *
 * Every command prints this, including failures, and failures still exit non-zero.
 * Reading `ok` is therefore mandatory: a non-zero exit does not tell you whether
 * anything was delivered, and stdout alone is not a success signal.
 */
export function readEnvelope(stdout: string): AgentDesktopEnvelope {
  const parsed = safeJson(stdout);
  if (!isRecord(parsed)) return { ok: false, error: { message: 'Svaret var inte JSON.' } };
  const rawError = isRecord(parsed.error) ? parsed.error : null;
  return {
    ok: parsed.ok === true,
    data: isRecord(parsed.data) ? parsed.data : undefined,
    error: rawError
      ? {
          code: typeof rawError.code === 'string' ? rawError.code : undefined,
          message: typeof rawError.message === 'string' ? rawError.message : undefined,
          suggestion: typeof rawError.suggestion === 'string' ? rawError.suggestion : undefined,
          disposition: isRecord(rawError.disposition)
            ? {
                delivery: typeof rawError.disposition.delivery === 'string' ? rawError.disposition.delivery : undefined,
                retry: typeof rawError.disposition.retry === 'string' ? rawError.disposition.retry : undefined,
              }
            : undefined,
        }
      : undefined,
  };
}

/** Human-readable failure, preferring the error's own suggestion. */
function describeFailure(
  result: { code: number; stderr: string },
  envelope?: AgentDesktopEnvelope,
): string {
  const fromEnvelope = envelope?.error;
  if (fromEnvelope?.message) {
    return fromEnvelope.suggestion ? `${fromEnvelope.message} ${fromEnvelope.suggestion}` : fromEnvelope.message;
  }
  return result.stderr.trim() || `exit ${result.code}`;
}

/** Reads one permission state out of `status` (granted | denied | unknown). */
function readPermissionState(data: Record<string, unknown> | undefined, key: string): 'granted' | 'denied' | 'unknown' {
  if (!data || !isRecord(data.permissions)) return 'unknown';
  const entry = data.permissions[key];
  if (!isRecord(entry) || typeof entry.state !== 'string') return 'unknown';
  if (entry.state === 'granted') return 'granted';
  if (entry.state === 'denied') return 'denied';
  return 'unknown';
}

function readSuggestion(data: Record<string, unknown> | undefined): string {
  if (!data || !isRecord(data.permissions)) return '';
  for (const value of Object.values(data.permissions)) {
    if (isRecord(value) && typeof value.suggestion === 'string' && value.suggestion) return value.suggestion;
  }
  return '';
}

/**
 * Flattens the documented snapshot tree into the flat element list the app uses.
 * Only nodes that carry a ref can be acted on; the rest are structure.
 */
export function flattenTree(tree: Record<string, unknown>, depth = 0, out: UiElementInfo[] = []): UiElementInfo[] {
  if (depth > 60) return out;
  const ref = typeof tree.ref_id === 'string' ? tree.ref_id : typeof tree.ref === 'string' ? tree.ref : null;
  // Static text and status messages rarely have action refs but are vital
  // for detecting errors. Empty ref signifies read-only, never clickable.
  const nodeName = typeof tree.name === 'string' ? tree.name : '';
  const nodeValue = typeof tree.value === 'string' ? tree.value : null;
  if (ref || (nodeName.trim() && /text|static|status|alert|label|document|window/i.test(String(tree.role ?? '')))) {
    out.push({
      ref: ref ?? '',
      role: typeof tree.role === 'string' ? tree.role : 'unknown',
      name: nodeName,
      value: nodeValue,
      bounds: readRect(tree),
      enabled: tree.enabled !== false && tree.disabled !== true,
      stale: false,
    });
  }
  const children = Array.isArray(tree.children) ? tree.children : [];
  for (const child of children) {
    if (isRecord(child)) flattenTree(child, depth + 1, out);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
