import { createHash } from 'node:crypto';
import type { UiSnapshot, WindowInfo } from '@studdy/shared';
import type { StuddyServices } from './services.js';
import type { DesktopAccessibilityAdapter } from './desktop-adapter.js';
import { allowedObservationTitle, detectCompanionHint, detectContextHint, type CompanionHint } from './companion-observer.js';
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

  constructor(private readonly options: LiveObserverOptions) {
    this.clock = options.clock ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? 12_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.state = 'off';
    this.activity = 'Observation stoppad';
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
      // Never silently substitute a different background app for a focused
      // private window. The status must describe what was ACTUALLY observed.
      const focused = result.windows.find(w => !w.minimized && w.focused);
      if (!focused) {
        this.state = 'no-window';
        this.activity = 'Inget aktivt fönster bekräftat';
        return this.status();
      }
      if (!allowedObservationTitle(focused.title)) {
        this.state = 'private';
        this.window = null;
        this.snapshot = null;
        this.activity = 'Privat fönster · observation pausad';
        return this.status();
      }
      if (/studdy|node|terminal|cmd\.exe|powershell|pwsh/i.test(focused.title)) {
        this.state = 'no-window';
        this.activity = 'Eget terminalfönster · inga externa UI-element lästa';
        return this.status();
      }
      const active = focused;
      const snapshot = await adapter.snapshot(active.id);
      if (this.stopped) return this.status();
      this.window = active;
      this.snapshot = snapshot;
      if (snapshot.accessible) {
        this.state = 'active';
        this.lastObservedAt = this.clock();
        this.activity = `Läser ${snapshot.elements.length} UI-element i ${active.title.slice(0, 60)}`;
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
        this.activity = snapshot.note?.slice(0, 160) ?? 'Inget läsbart fönster';
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
