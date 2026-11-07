import { mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { StuddyRuntime } from './runtime.js';
import type { UiSnapshot } from '@studdy/shared';

/**
 * End-to-end live proof on the user's own machine.
 *
 * Every step reports what was actually observed. A missing desktop session or
 * denied OS permission is BLOCKED, never a pass. The write step types only into
 * the scratch editor this proof launched itself, never into the user's documents.
 */
export type ProofStatus = 'pass' | 'fail' | 'blocked' | 'skipped';
export interface ProofStep { name: string; status: ProofStatus; detail: string }
export interface LiveProof {
  ok: boolean;
  platform: string;
  app: string;
  windowId: string | null;
  marker: string | null;
  steps: ProofStep[];
}

const SCRATCH_APPS: Record<string, string[]> = {
  win32: ['Notepad'],
  darwin: ['TextEdit'],
  linux: ['gedit', 'Text Editor', 'mousepad', 'kate'],
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Prefer an element that advertises a value/text action; fall back to role. */
function pickWriteTarget(elements: UiSnapshot['elements']): UiSnapshot['elements'][number] | undefined {
  const usable = elements.filter(e => e.ref && e.enabled);
  const advertised = usable.find(e => (e.availableActions ?? []).some(a => /value|text|type|insert|edit/i.test(a)));
  return advertised ?? usable.find(e => /^(edit|document|textarea|text|input)/i.test(e.role));
}

export interface ProveOptions {
  /** Override the scratch app. It must be a plain app name, not a command. */
  app?: string;
  /** Skip the typing step (read-only proof). */
  noWrite?: boolean;
  timeoutMs?: number;
}

export async function proveLive(runtime: StuddyRuntime, options: ProveOptions = {}): Promise<LiveProof> {
  const platform = process.platform;
  const steps: ProofStep[] = [];
  const add = (name: string, status: ProofStatus, detail: string) => { steps.push({ name, status, detail }); };
  const result: LiveProof = { ok: false, platform, app: options.app ?? '', windowId: null, marker: null, steps };

  const native = await runtime.nativeStatus();
  if (!native.available) {
    add('Native helper', 'blocked', native.detail);
    add('Datorstyrning', 'skipped', 'Kräver en tillgänglig native helper och desktop-session.');
    return result;
  }
  add('Native helper', 'pass', `agent-desktop ${native.version} · ${native.detail}`);

  const gate = runtime.services.permissions.check('act', ['computer.actions']);
  if (!gate.allowed) {
    add('Behörighet', 'blocked', gate.reason + ' Kör `studdy setup`.');
    return result;
  }
  add('Behörighet', 'pass', 'computer.actions beviljad lokalt.');

  const candidates = options.app ? [options.app] : (SCRATCH_APPS[platform] ?? []);
  if (!candidates.length) {
    add('Appstart', 'blocked', `Ingen känd scratch-app för ${platform}. Ange --app "Appnamn".`);
    return result;
  }

  let launched: string | null = null;
  let lastLaunchError = '';
  for (const candidate of candidates) {
    const launchedResult = await runtime.launchApp(candidate);
    if (launchedResult.ok) { launched = candidate; break; }
    lastLaunchError = launchedResult.detail;
  }
  if (!launched) {
    add('Appstart', 'fail', lastLaunchError || 'Ingen scratch-app kunde startas.');
    return result;
  }
  result.app = launched;
  add('Appstart', 'pass', `${launched} startad och verifierad av native helper.`);

  // Poll: a launch envelope is not proof that a window exists.
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const needle = launched.toLowerCase().replace(/\s+/g, '');
  let windowId: string | null = null;
  let windowTitle = '';
  let lastWindowError = '';
  while (Date.now() < deadline && !windowId) {
    const listed = await runtime.adapter.listWindows();
    if (listed.error) { lastWindowError = listed.error; break; }
    const found = listed.windows.find(w => {
      const process = (w.processName ?? '').toLowerCase().replace(/\.exe$/, '').replace(/\s+/g, '');
      const title = (w.title ?? '').toLowerCase().replace(/\s+/g, '');
      return process.includes(needle) || title.includes(needle);
    });
    if (found) { windowId = found.id; windowTitle = found.title; break; }
    await sleep(500);
  }
  if (!windowId) {
    add('Fönsterobservation', lastWindowError ? 'blocked' : 'fail',
      lastWindowError || `Inget fönster för ${launched} observerades inom tidsgränsen.`);
    return result;
  }
  result.windowId = windowId;
  add('Fönsterobservation', 'pass', `"${windowTitle}" · id ${windowId}`);

  const snapshot = await runtime.adapter.snapshot(windowId);
  if (!snapshot.accessible) {
    add('UI-träd', 'blocked', snapshot.note ?? 'Tillgänglighetsträdet kunde inte läsas.');
    return result;
  }
  add('UI-träd', 'pass', `${snapshot.elements.length} element lästa från det riktiga fönstret.`);

  if (options.noWrite) {
    add('Skrivtest', 'skipped', 'Hoppat över (--no-write).');
  } else {
    const target = pickWriteTarget(snapshot.elements);
    if (!target) {
      add('Skrivtest', 'blocked', 'Inget skrivbart UI-element med ref hittades i scratch-appen.');
    } else {
      const marker = 'Studdy proof ' + randomBytes(4).toString('hex');
      // Delivery is negotiated with the helper, not assumed. On Windows `type`
      // refuses headless (POLICY_DENIED) while `set-value` is semantic; the
      // physical fallback is explicit because it may move focus/cursor.
      const strategies = [
        { label: 'set-value (semantisk)', run: () => runtime.computerAction('set-value', [target.ref, marker]) },
        { label: 'type --headed (fysisk)', run: () => runtime.computerAction('type', [target.ref, marker], { headed: true }) },
      ];
      let verified = false;
      let lastDetail = '';
      for (const strategy of strategies) {
        const attempt = await strategy.run();
        if (!attempt.ok) { lastDetail = `${strategy.label}: ${attempt.detail}`; continue; }
        await sleep(400);
        const after = await runtime.adapter.snapshot(windowId);
        if (after.elements.some(e => `${e.name} ${e.value ?? ''}`.includes(marker))) {
          result.marker = marker;
          add('Skrivtest', 'pass', `Texten "${marker}" skrevs via ${strategy.label} och lästes tillbaka ur UI-trädet.`);
          verified = true;
          break;
        }
        lastDetail = `${strategy.label}: text skickades men kunde inte läsas tillbaka.`;
      }
      if (!verified) add('Skrivtest', 'fail', lastDetail || 'Ingen leveransmetod kunde verifieras.');
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'studdy-proof-'));
  const shotPath = join(dir, 'proof.png');
  try {
    const shot = await runtime.screenshot(windowId, shotPath);
    if (shot.ok && existsSync(shotPath) && statSync(shotPath).size > 0) {
      add('Skärmbild', 'pass', `${statSync(shotPath).size} byte verifierad på disk (raderas efter testet).`);
    } else {
      add('Skärmbild', 'blocked', shot.detail || 'Ingen skärmbilddata verifierades.');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  result.ok = steps.every(s => s.status === 'pass' || s.status === 'skipped');
  return result;
}
