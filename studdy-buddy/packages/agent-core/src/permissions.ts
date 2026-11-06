import type { PermissionKey, PermissionMode } from '@studdy/shared';
import type { Database } from '@studdy/database';

/**
 * Permission gate. Every observation or action the agent performs passes
 * through here first. Defaults are closed: nothing is granted until the student
 * explicitly grants it.
 */

export interface PermissionRequest {
  key: PermissionKey;
  reason: string;
}

export const PERMISSION_DEFAULTS: Record<PermissionKey, boolean> = {
  'screen.capture': false,
  'application.observe': false,
  'browser.read': false,
  microphone: false,
  'computer.actions': false,
  'provider.dataShare': false,
};

const MODE_ORDER: Record<PermissionMode, number> = {
  OBSERVE_ONLY: 0,
  VISUAL_GUIDE: 1,
  APPROVED_ACTION: 2,
};

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
}

export class PermissionGate {
  constructor(private readonly db: Database) {}

  getAll(): { key: PermissionKey; granted: boolean; grantedAt: string | null; mode: PermissionMode }[] {
    const stored = new Map(this.db.permissions.list().map((r) => [r.key, r]));
    const mode = this.currentMode();
    return (Object.keys(PERMISSION_DEFAULTS) as PermissionKey[]).map((key) => {
      const row = stored.get(key);
      return {
        key,
        granted: row?.granted ?? PERMISSION_DEFAULTS[key],
        grantedAt: row?.grantedAt ?? null,
        mode,
      };
    });
  }

  isGranted(key: PermissionKey): boolean {
    const row = this.db.permissions.get(key);
    if (!row) return PERMISSION_DEFAULTS[key];
    return row.granted;
  }

  grant(key: PermissionKey): void {
    this.db.permissions.set(key, true, this.currentMode());
  }

  revoke(key: PermissionKey): void {
    this.db.permissions.set(key, false, this.currentMode());
  }

  currentMode(): PermissionMode {
    const rows = this.db.permissions.list();
    const mode = rows[0]?.mode as PermissionMode | undefined;
    return mode && mode in MODE_ORDER ? mode : 'OBSERVE_ONLY';
  }

  setMode(mode: PermissionMode): void {
    this.db.permissions.setMode(mode);
  }

  /**
   * Checks whether an action is permitted *at the current mode*.
   * Visual guidance requires VISUAL_GUIDE; executing clicks requires
   * APPROVED_ACTION plus the computer.actions grant.
   */
  check(action: 'observe' | 'guide' | 'act', keys: PermissionKey[]): PermissionDecision {
    for (const key of keys) {
      if (!this.isGranted(key)) {
        return { allowed: false, reason: `Behörigheten "${key}" är inte beviljad.` };
      }
    }
    const mode = this.currentMode();
    if (action === 'guide' && MODE_ORDER[mode] < MODE_ORDER.VISUAL_GUIDE) {
      return { allowed: false, reason: 'Läget är OBSERVE_ONLY. Byt till VISUAL_GUIDE för att visa markeringar.' };
    }
    if (action === 'act') {
      if (MODE_ORDER[mode] < MODE_ORDER.APPROVED_ACTION) {
        return { allowed: false, reason: 'Läget tillåter inte att Buddy utför handlingar.' };
      }
      if (!this.isGranted('computer.actions')) {
        return { allowed: false, reason: 'Behörigheten "computer.actions" är inte beviljad.' };
      }
    }
    return { allowed: true, reason: 'ok' };
  }

  modeRank(mode: PermissionMode = this.currentMode()): number {
    return MODE_ORDER[mode];
  }
}

/**
 * Proactive-assistance governor.
 *
 * Requirement: suggestions must be grounded, rate-limited and never interrupt
 * formal assessments. This class owns the cooldown policy so the agent cannot
 * "just" decide to be chatty.
 */
export interface ProactiveSettings {
  mode: 'OFF' | 'QUIET' | 'NORMAL';
  cooldownMs: number;
  minRelevance: number;
}

export const PROACTIVE_DEFAULTS: Record<'OFF' | 'QUIET' | 'NORMAL', ProactiveSettings> = {
  OFF: { mode: 'OFF', cooldownMs: Number.POSITIVE_INFINITY, minRelevance: 1 },
  QUIET: { mode: 'QUIET', cooldownMs: 10 * 60_000, minRelevance: 0.75 },
  NORMAL: { mode: 'NORMAL', cooldownMs: 3 * 60_000, minRelevance: 0.55 },
};

export class ProactiveGovernor {
  private lastSuggestionAt = 0;

  constructor(
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * @param relevance 0..1 estimate of how useful a suggestion would be now.
   * @param assessmentMode when inside GRADED_QUIZ/FORMAL_EXAM nothing is allowed.
   */
  maySuggest(settings: ProactiveSettings, relevance: number, assessmentMode: string): PermissionDecision {
    if (settings.mode === 'OFF') return { allowed: false, reason: 'Proaktiva tips är avstängda.' };
    if (assessmentMode === 'GRADED_QUIZ' || assessmentMode === 'FORMAL_EXAM') {
      return { allowed: false, reason: 'Inga avbrott under betygsatta prov.' };
    }
    if (relevance < settings.minRelevance) {
      return { allowed: false, reason: 'Underlaget är för svagt för ett tips just nu.' };
    }
    const elapsed = this.clock() - this.lastSuggestionAt;
    if (elapsed < settings.cooldownMs) {
      return { allowed: false, reason: `Väntar ${Math.ceil((settings.cooldownMs - elapsed) / 1000)} s innan nästa tips.` };
    }
    return { allowed: true, reason: 'ok' };
  }

  markSuggested(): void {
    this.lastSuggestionAt = this.clock();
  }

  reset(): void {
    this.lastSuggestionAt = 0;
  }
}
