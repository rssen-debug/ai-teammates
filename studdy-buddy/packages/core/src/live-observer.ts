import { createHash } from 'node:crypto';
import type { UiSnapshot, WindowInfo } from '@studdy/shared';
import type { StuddyServices } from './services.js';
import type { DesktopAccessibilityAdapter } from './desktop-adapter.js';
import { allowedObservationTitle, detectCompanionHint, type CompanionHint } from './companion-observer.js';
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
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? 12_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): LiveStatus {
    const observing = this.state === 'active' && this.lastObservedAt !== null &&
      this.clock() - this.lastObservedAt < 35_000 &&
      this.options.services.permissions.isGranted('application.observe');
    return {
      state: observing ? 'active' : this.state === 'active' ? 'no-window' : this.state,
      observing,
      windowTitle: observing ? this.window?.title ?? null : null,
      windowId: observing ? this.window?.id ?? null : null,
      elementCount: observing ? this.snapshot?.elements.length ?? 0 : 0,
      lastObservedAt: this.lastObservedAt,
      activity: this.activity,
      level: new VerifiedSkillLedger(this.options.services.db.checkpoints).level(),
    };
  }

  lastSnapshot(): UiSnapshot | null { return this.snapshot; }

  async tick(): Promise<LiveStatus> {
    const { services, adapter } = this.options;
    if (this.busy) return this.status();
    if (!services.permissions.isGranted('application.observe')) {
      this.state = 'off';
      this.activity = 'Observation avstängd';
      return this.status();
    }
    this.busy = true;
    const before = JSON.stringify(this.status());
    try {
      const result = await adapter.listWindows();
      if (result.error) {
        this.state = 'unavailable';
        this.activity = result.error.slice(0, 160);
        return this.status();
      }
      const active = result.windows.find(w => !w.minimized && w.focused && allowedObservationTitle(w.title) && !/studdy|node|terminal/i.test(w.title))
        ?? result.windows.find(w => !w.minimized && allowedObservationTitle(w.title) && w.appKind !== 'OTHER');
      if (!active) {
        this.state = 'no-window';
        this.activity = 'Väntar på ett läsbart, tillåtet fönster';
        return this.status();
      }
      if (!allowedObservationTitle(active.title)) {
        this.state = 'private';
        this.activity = 'Privat fönster · pausad';
        return this.status();
      }
      const snapshot = await adapter.snapshot(active.id);
      this.window = active;
      this.snapshot = snapshot;
      if (snapshot.accessible) {
        this.state = 'active';
        this.lastObservedAt = this.clock();
        this.activity = `Läser ${snapshot.elements.length} UI-element i ${active.title.slice(0, 60)}`;
        const proof = createHash('sha256').update(active.processName || active.appKind).digest('hex').slice(0, 20);
        services.db.observations.record('agent.uia.heartbeat', { kind: active.appKind, proof, elementCount: snapshot.elements.length });
        new VerifiedSkillLedger(services.db.checkpoints).record('observe:' + proof, true);
        const hint = detectCompanionHint(snapshot, active.title);
        if (hint && !this.signatures.has(hint.signature)) {
          this.signatures.add(hint.signature);
          if (this.signatures.size > 100) this.signatures.clear();
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
      if (JSON.stringify(this.status()) !== before) this.options.onChange?.(this.status());
    }
  }
}
