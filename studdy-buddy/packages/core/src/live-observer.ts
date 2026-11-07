import { createHash } from 'node:crypto';
import type { UiSnapshot, WindowInfo } from '@studdy/shared';
import type { StuddyServices } from './services.js';
import type { DesktopAccessibilityAdapter } from './desktop-adapter.js';
import { safeWindowLabel, detectCompanionHint, detectContextHint, type CompanionHint } from './companion-observer.js';
import { VerifiedSkillLedger } from './verified-skills.js';

export type ObservationState = 'starting' | 'active' | 'off' | 'private' | 'unavailable' | 'no-window';

export interface LiveStatus {
  state: ObservationState;
  observing: boolean;
  windowTitle: string | null;
  windowId: string | null;
  elementCount: number;
  lastObservedAt: number | null;
  activity: string;
  level: number;
  openWindowCount?: number;
  openWindows?: string[];
  foregroundWindow?: string | null;
  observationScope?: 'foreground' | 'background' | 'none';
}

export interface LiveObserverOptions {
  services: StuddyServices;
  adapter: DesktopAccessibilityAdapter;
  intervalMs?: number;
  onHint?: (hint: CompanionHint) => void;
  onChange?: (status: LiveStatus) => void;
  clock?: () => number;
}

/** Background accessibility observation. No screenshots, no raw UI text in logs. */
export class LiveObserver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private stopped = false;
  private pending: Promise<LiveStatus> | null = null;
  private cachedStatus: LiveStatus = { state: 'starting', observing: false, windowTitle: null, windowId: null, elementCount: 0, lastObservedAt: null, activity: 'Startar', level: 1 };
  private state: ObservationState = 'starting';
  private window: WindowInfo | null = null;
  private snapshot: UiSnapshot | null = null;
  private lastObservedAt: number | null = null;
  private activity = 'Startar';
  private readonly clock: () => number;
  private readonly signatures = new Set<string>();
  private allOpenWindows: string[] = [];
  private foregroundWindow: string | null = null;
  private lastExternalId: string | null = null;
  private observationScope: 'foreground' | 'background' | 'none' = 'none';

  constructor(private readonly options: LiveObserverOptions) {
    this.clock = options.clock ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.state = 'off';
    this.activity = 'Observation stoppad';
    this.allOpenWindows = [];
    this.foregroundWindow = null;
    this.observationScope = 'none';
    this.cachedStatus = { ...this.cachedStatus, state: 'off', observing: false, windowTitle: null, windowId: null, elementCount: 0, activity: this.activity };
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): LiveStatus {
    if (this.stopped) return this.cachedStatus;
    const observing = this.state === 'active' && this.lastObservedAt !== null &&
      this.clock() - this.lastObservedAt < 35_000 &&
      this.options.services.permissions.isGranted('application.observe');
    this.cachedStatus = {
      state: observing ? 'active' : this.state === 'active' ? 'no-window' : this.state,
      observing,
      windowTitle: observing ? this.window?.title ?? null : null,
      windowId: observing ? this.window?.id ?? null : null,
      elementCount: observing ? this.snapshot?.elements.length ?? 0 : 0,
      lastObservedAt: this.lastObservedAt,
      activity: this.activity,
      level: new VerifiedSkillLedger(this.options.services.db.checkpoints).level(),
      openWindowCount: this.allOpenWindows.length,
      openWindows: this.allOpenWindows.slice(0, 8),
      foregroundWindow: this.foregroundWindow,
      observationScope: observing ? this.observationScope : 'none',
    };
    return this.cachedStatus;
  }

  lastSnapshot(): UiSnapshot | null { return this.snapshot; }

  async tick(): Promise<LiveStatus> {
    if (this.stopped) return this.status();
    if (this.pending) return this.pending;
    this.pending = this.observeOnce().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async observeOnce(): Promise<LiveStatus> {
    const { services, adapter } = this.options;
    if (this.busy || this.stopped) return this.status();
    if (!services.permissions.isGranted('application.observe')) {
      this.state = 'off';
      this.activity = 'Observation avstängd';
      return this.status();
    }
    this.busy = true;
    const before = JSON.stringify(this.status());
    try {
      const result = await adapter.listWindows();
      if (this.stopped) return this.status();
      if (result.error) {
        this.state = 'unavailable';
        this.activity = result.error.slice(0, 160);
        return this.status();
      }
      // Inventory all top-level windows. Read one external window per tick,
      // including a background app while the terminal has focus.
      const windows = result.windows.filter(w => w.title.trim());
      const isTerminal = (w: WindowInfo) =>
        /(?:^|[\\/])(?:cmd|powershell|pwsh|windowsterminal|wt|node)(?:\.exe)?$/i.test(w.processName.trim()) ||
        (!w.processName.trim() && /(?:cmd\.exe|powershell|studdy buddy)/i.test(w.title));
      const foreground = windows.find(w => w.focused && !w.minimized);
      this.foregroundWindow = foreground ? safeWindowLabel(foreground.title, foreground.processName) : null;
      this.allOpenWindows = windows.filter(w => !isTerminal(w))
        .map(w => safeWindowLabel(w.title, w.processName) + (w.minimized ? ' (minimerad)' : ''));
      const candidates = windows.filter(w => !isTerminal(w) && !w.minimized);
      const active = (foreground && !isTerminal(foreground) ? foreground : null)
        ?? (this.lastExternalId ? candidates.find(w => w.id === this.lastExternalId) : null)
        ?? candidates[0];
      if (!active) {
        this.state = 'no-window';
        this.window = null;
        this.snapshot = null;
        this.observationScope = 'none';
        this.activity = windows.length
          ? 'Terminal aktiv · inga andra läsbara program identifierade'
          : 'Inga öppna fönster rapporterade';
        return this.status();
      }
      this.lastExternalId = active.id;
      this.observationScope = foreground?.id === active.id ? 'foreground' : 'background';
      const snapshot = await adapter.snapshot(active.id);
      if (this.stopped) return this.status();
      // Never forward arbitrary Chrome tab titles to CLI, logs or status.
      const label = safeWindowLabel(active.title, active.processName);
      this.window = { ...active, title: label };
      this.snapshot = snapshot;
      if (snapshot.accessible) {
        this.state = 'active';
        this.lastObservedAt = this.clock();
        this.activity = `Läser ${snapshot.elements.length} UI-element i ${label} (${this.observationScope === 'background' ? 'bakom terminalen' : 'aktivt fönster'})`;
        const proof = createHash('sha256').update(active.processName || active.appKind).digest('hex').slice(0, 20);
        services.db.observations.record('agent.uia.heartbeat', { kind: active.appKind, proof, elementCount: snapshot.elements.length });
        const count = services.db.checkpoints.get<number>('buddy.live.verified-observations.v1') ?? 0;
        services.db.checkpoints.set('buddy.live.verified-observations.v1', Math.min(999999999, count + 1));
        new VerifiedSkillLedger(services.db.checkpoints).record('observe:' + proof, true);
        // Failures are prioritized over optional context suggestions.
        const hint = detectCompanionHint(snapshot, active.title)
          ?? detectContextHint(snapshot, active.title);
        if (hint && !this.signatures.has(hint.signature)) {
          this.signatures.add(hint.signature);
          if (this.signatures.size > 100) {
            const oldest = this.signatures.values().next().value;
            if (oldest) this.signatures.delete(oldest);
          }
          this.options.onHint?.(hint);
        }
      } else {
        this.state = /misslyckades|error|denied|not supported|kunde inte/i.test(snapshot.note ?? '') ? 'unavailable' : 'no-window';
        this.activity = snapshot.note?.slice(0, 160) ?? 'Fönster identifierat, men UI-avläsning saknas';
      }
      return this.status();
    } catch (error) {
      this.state = 'unavailable';
      this.activity = error instanceof Error ? error.message.slice(0, 160) : String(error);
      return this.status();
    } finally {
      this.busy = false;
      if (!this.stopped && JSON.stringify(this.status()) !== before) this.options.onChange?.(this.status());
    }
  }
}
