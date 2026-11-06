import { describe, it, expect, vi } from 'vitest';
import {
  DesktopAccessibilityAdapter,
  parseWindows,
  parseSnapshot,
  parseSnapshot as parseSnapshotTree,
  classifyApp,
  flattenTree,
  readEnvelope,
  type CommandRunner,
} from '../../apps/desktop/electron/desktop-adapter.js';
import { classifyApp as _unused } from '../../apps/desktop/electron/desktop-adapter.js';

function runnerReturning(map: Record<string, { code: number; stdout: string; stderr: string }>): CommandRunner {
  return {
    run: vi.fn(async (cmd: string, args: string[]) => {
      const key = args.join(' ');
      for (const [pattern, value] of Object.entries(map)) {
        if (key.includes(pattern)) return value;
      }
      return { code: 1, stdout: '', stderr: 'not found' };
    }),
  };
}

describe('DesktopAccessibilityAdapter', () => {
  it('reports unavailable on non-Windows platforms instead of pretending', async () => {
    const adapter = new DesktopAccessibilityAdapter({ platform: 'linux', runner: runnerReturning({}) });
    const status = await adapter.status();
    expect(status.available).toBe(false);
    expect(status.mode).toBe('unavailable');
    expect(status.detail).toMatch(/Windows/);
  });

  it('reports unavailable when the CLI is missing', async () => {
    const adapter = new DesktopAccessibilityAdapter({
      platform: 'win32',
      runner: runnerReturning({ version: { code: 1, stdout: '', stderr: 'command not found' } }),
    });
    const status = await adapter.status();
    expect(status.available).toBe(false);
    expect(status.detail).toMatch(/kunde inte köras/);
    expect(status.detail).toMatch(/command not found/);
  });

  it('reports the CLI version when present', async () => {
    const adapter = new DesktopAccessibilityAdapter({
      platform: 'win32',
      runner: runnerReturning({
        // Real shape, observed from `agent-desktop version`:
        version: { code: 0, stdout: JSON.stringify({ version: '2.6', ok: true, command: 'version', data: { os: 'win32', version: '1.2.3' } }), stderr: '' },
        status: { code: 0, stdout: JSON.stringify({ version: '2.6', ok: true, command: 'status', data: { permissions: { accessibility: { state: 'granted' } } } }), stderr: '' },
      }),
    });
    const status = await adapter.status();
    expect(status.available).toBe(true);
    expect(status.version).toBe('1.2.3');
    expect(status.mode).toBe('cli-json');
  });

  it('returns an empty list plus an error when window enumeration fails', async () => {
    const adapter = new DesktopAccessibilityAdapter({
      platform: 'win32',
      runner: runnerReturning({
        'list-windows': {
          code: 1,
          stdout: JSON.stringify({ version: '2.6', ok: false, command: 'list-windows', error: { code: 'PLATFORM_NOT_SUPPORTED', message: 'access denied' } }),
          stderr: '',
        },
      }),
    });
    const result = await adapter.listWindows();
    expect(result.windows).toEqual([]);
    expect(result.error).toMatch(/access denied/);
  });

  it('parses window JSON and classifies supported apps', async () => {
    const stdout = JSON.stringify([
      { id: 1, title: 'CCNA ITN - NetAcad', process: 'chrome.exe', bounds: { x: 0, y: 0, width: 1280, height: 800 } },
      { id: 2, title: 'topology.pkt', process: 'PacketTracer.exe', bounds: { x: 10, y: 10, width: 800, height: 600 } },
      { id: 3, title: 'Steam', process: 'steam.exe', bounds: { x: 0, y: 0, width: 100, height: 100 } },
    ]);
    const windows = parseWindows(stdout);
    expect(windows).toHaveLength(3);
    expect(windows[0]?.appKind).toBe('NETACAD');
    expect(windows[1]?.appKind).toBe('PACKET_TRACER');
    expect(windows[2]?.appKind).toBe('OTHER');
  });

  it('marks a snapshot accessible only when it actually contains elements', () => {
    const empty = parseSnapshot('{"elements":[]}', 'w1');
    expect(empty.accessible).toBe(false);
    expect(empty.note).toMatch(/inga element/);

    const withElements = parseSnapshot(
      JSON.stringify({ elements: [{ ref: 'e1', role: 'button', name: 'IP Configuration', bounds: { x: 1, y: 2, width: 3, height: 4 } }] }),
      'w1',
    );
    expect(withElements.accessible).toBe(true);
    expect(withElements.elements[0]?.name).toBe('IP Configuration');
  });

  it('returns an honest note when the snapshot cannot be parsed', () => {
    const snapshot = parseSnapshot('not json', 'w1');
    expect(snapshot.accessible).toBe(false);
    expect(snapshot.elements).toEqual([]);
  });

  it('revalidates a stale element reference', async () => {
    const adapter = new DesktopAccessibilityAdapter({
      platform: 'win32',
      runner: runnerReturning({
        'snapshot --window-id': {
          code: 0,
          stdout: JSON.stringify({
            version: '2.6',
            ok: true,
            command: 'snapshot',
            // Real snapshots nest the tree; `ref_id` is the documented key.
            data: { snapshot_id: 's1', complete: true, tree: { role: 'window', name: 'PC0', children: [{ role: 'tab', name: 'Desktop', ref_id: '@s1:e9' }] } },
          }),
          stderr: '',
        },
      }),
    });
    const found = await adapter.revalidate('w1', '@s1:e9');
    expect(found?.name).toBe('Desktop');
    expect(found?.stale).toBe(false);

    const missing = await adapter.revalidate('w1', '@s1:gone');
    expect(missing).toBeNull();
  });
});

describe('the real CLI envelope (observed, not assumed)', () => {
  it('reads ok/data from the documented envelope', () => {
    const envelope = readEnvelope(JSON.stringify({ version: '2.6', ok: true, command: 'version', data: { version: '1.2.3' } }));
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.version).toBe('1.2.3');
  });

  it('reads error, suggestion and retry disposition from a failure envelope', () => {
    const envelope = readEnvelope(
      JSON.stringify({
        version: '2.6',
        ok: false,
        command: 'list-windows',
        error: {
          code: 'PLATFORM_NOT_SUPPORTED',
          message: 'The AT-SPI accessibility bus is not available in this session',
          suggestion: 'Run inside a desktop session',
          disposition: { delivery: 'not_delivered', retry: 'safe' },
        },
      }),
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('PLATFORM_NOT_SUPPORTED');
    expect(envelope.error?.suggestion).toMatch(/desktop session/);
    expect(envelope.error?.disposition?.delivery).toBe('not_delivered');
  });

  it('treats non-JSON output as failure instead of as data', () => {
    expect(readEnvelope('not json').ok).toBe(false);
    expect(readEnvelope('').ok).toBe(false);
  });

  it('flattens the documented snapshot tree into elements with refs', () => {
    const elements = flattenTree({
      role: 'window',
      name: 'Packet Tracer',
      children: [
        { role: 'group', name: 'Workspace', children: [{ role: 'button', name: 'PC0', ref_id: '@s1:e2', bounds: { x: 10, y: 20, width: 30, height: 40 } }] },
        { role: 'tab', name: 'Desktop', ref_id: '@s1:e9' },
      ],
    });
    expect(elements.map((e) => e.name)).toEqual(['PC0', 'Desktop']);
    expect(elements[0]?.ref).toBe('@s1:e2');
    expect(elements[0]?.bounds).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it('reports an incomplete snapshot as a partial observation', async () => {
    const adapter = new DesktopAccessibilityAdapter({
      platform: 'win32',
      runner: runnerReturning({
        'snapshot --window-id': {
          code: 0,
          stdout: JSON.stringify({
            version: '2.6',
            ok: true,
            command: 'snapshot',
            data: { complete: false, tree: { role: 'window', name: 'x', ref_id: '@s1:e1' } },
          }),
          stderr: '',
        },
      }),
    });
    const snapshot = await adapter.snapshot('w1');
    expect(snapshot.accessible).toBe(true);
    expect(snapshot.note).toMatch(/ofullständig/);
  });

  it('never passes flags the CLI does not accept', async () => {
    const seen: string[][] = [];
    const adapter = new DesktopAccessibilityAdapter({
      platform: 'win32',
      runner: {
        run: async (_cmd: string, args: string[]) => {
          seen.push(args);
          return { code: 0, stdout: JSON.stringify({ version: '2.6', ok: true, command: args[0], data: {} }), stderr: '' };
        },
      },
    });
    await adapter.listWindows();
    await adapter.snapshot('w1');
    await adapter.status();

    const flat = seen.flat();
    // `--json` does not exist; `windows` is not a command; the flag is `--window-id`.
    expect(flat).not.toContain('--json');
    expect(flat).not.toContain('windows');
    expect(flat).not.toContain('--window');
    expect(flat).toContain('list-windows');
    expect(flat).toContain('--window-id');
  });
});

describe('app classification', () => {
  it('recognises Packet Tracer and browsers', () => {
    expect(classifyApp('PacketTracer.exe', '')).toBe('PACKET_TRACER');
    expect(classifyApp('chrome.exe', '')).toBe('NETACAD');
    expect(classifyApp('msedge.exe', '')).toBe('NETACAD');
    expect(classifyApp('notepad.exe', 'untitled')).toBe('OTHER');
  });

  void _unused;
  void parseSnapshotTree;
});
