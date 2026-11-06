import { describe, it, expect } from 'vitest';
import type { DisplayInfo } from '@studdy/shared';
import {
  displayContaining,
  clampRectToDisplay,
  physicalToDip,
  dipToPhysical,
  windowClientToDesktop,
  revalidateTarget,
  distance,
  placeTooltip,
  buildGuidedStep,
  shouldAcceptInput,
  overlapsReadingArea,
  containsRect,
  expandRect,
} from '@studdy/screen-overlay';
import {
  ANIMATION_STATES,
  STATE_PRIORITY,
  EXPRESSIONS,
  initialMascotState,
  transition,
  tick,
  stateForSignal,
  STATE_LABEL,
} from '@studdy/mascot';

const primary: DisplayInfo = { id: '1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, isPrimary: true };
const secondary: DisplayInfo = { id: '2', bounds: { x: 1920, y: -200, width: 2560, height: 1440 }, scaleFactor: 1.5, isPrimary: false };
const leftOfPrimary: DisplayInfo = { id: '3', bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, scaleFactor: 1, isPrimary: false };

describe('multi-monitor geometry', () => {
  it('finds the display containing a point, including negative origins', () => {
    expect(displayContaining([primary, secondary, leftOfPrimary], { x: -200, y: 100 })?.id).toBe('3');
    expect(displayContaining([primary, secondary, leftOfPrimary], { x: 2000, y: 100 })?.id).toBe('2');
    expect(displayContaining([primary, secondary, leftOfPrimary], { x: 5000, y: 5000 })).toBeNull();
  });

  it('clips a rect that straddles two displays', () => {
    const clipped = clampRectToDisplay({ x: 1800, y: 100, width: 400, height: 200 }, primary);
    expect(clipped.width).toBe(120);
    expect(clipped.x).toBe(1800);
  });

  it('converts physical pixels to DIP on a scaled display', () => {
    // Secondary display sits at DIP origin (1920, -200) with 1.5x scaling, so its
    // physical origin is (2880, -300). A point 150 px further in, in physical
    // desktop coordinates, is 100 DIP further in.
    const physical = { x: 2880 + 150, y: -300 + 150 };
    const dip = physicalToDip(physical, secondary);
    expect(dip.x).toBeCloseTo(2020, 5);
    expect(dip.y).toBeCloseTo(-100, 5);
  });

  it('round-trips physical <-> DIP', () => {
    const start = { x: 2100, y: -50 };
    const physical = dipToPhysical(start, secondary);
    const back = physicalToDip(physical, secondary);
    expect(back.x).toBeCloseTo(start.x, 5);
    expect(back.y).toBeCloseTo(start.y, 5);
  });

  it('accounts for browser zoom when mapping client rects to the desktop', () => {
    const at100 = windowClientToDesktop({ x: 100, y: 50, width: 200, height: 40 }, { x: 0, y: 0, width: 0, height: 0 }, primary, { browserZoom: 1 });
    const at200 = windowClientToDesktop({ x: 100, y: 50, width: 200, height: 40 }, { x: 0, y: 0, width: 0, height: 0 }, primary, { browserZoom: 2 });
    expect(at100.x).toBe(100);
    expect(at200.x).toBe(50);
    expect(at200.width).toBe(100);
  });
});

describe('target revalidation', () => {
  const base = {
    snapshot: { rect: { x: 100, y: 100, width: 50, height: 20 }, fingerprint: 'abc', capturedAt: 1000 },
  };

  it('accepts a target that is still there', () => {
    const result = revalidateTarget({ ...base, freshRect: { x: 102, y: 100, width: 50, height: 20 }, freshFingerprint: 'abc', now: 1500 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rect.x).toBe(102);
  });

  it('rejects stale coordinates', () => {
    const result = revalidateTarget({ ...base, freshRect: base.snapshot.rect, freshFingerprint: 'abc', now: 99_000, maxAgeMs: 4000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/för gamla/);
  });

  it('rejects a target that moved beyond tolerance', () => {
    const result = revalidateTarget({ ...base, freshRect: { x: 400, y: 300, width: 50, height: 20 }, freshFingerprint: 'abc', now: 1200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/flyttats/);
  });

  it('rejects a vanished target', () => {
    const result = revalidateTarget({ ...base, freshRect: null, freshFingerprint: null, now: 1200 });
    expect(result.ok).toBe(false);
  });

  it('rejects a changed element with the same position', () => {
    const result = revalidateTarget({ ...base, freshRect: base.snapshot.rect, freshFingerprint: 'different', now: 1200 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ändrats/);
  });

  it('measures distance including size changes', () => {
    expect(distance({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(0);
    expect(distance({ x: 0, y: 0, width: 10, height: 10 }, { x: 3, y: 4, width: 10, height: 10 })).toBeCloseTo(5, 5);
  });
});

describe('tooltip placement', () => {
  it('places below when there is room', () => {
    const result = placeTooltip({ x: 500, y: 300, width: 100, height: 30 }, { width: 240, height: 80 }, primary);
    expect(result.placement).toBe('below');
    expect(containsRect(primary.bounds, result.rect)).toBe(true);
  });

  it('flips above when the target is at the bottom of the screen', () => {
    const result = placeTooltip({ x: 500, y: 1030, width: 100, height: 30 }, { width: 240, height: 80 }, primary);
    expect(result.placement).toBe('above');
  });

  it('clamps inside the display rather than going off-screen', () => {
    const result = placeTooltip({ x: 1900, y: 1060, width: 15, height: 15 }, { width: 300, height: 120 }, primary);
    expect(containsRect(primary.bounds, result.rect)).toBe(true);
  });
});

describe('guided steps', () => {
  it('produces exactly one active annotation', () => {
    const { active, remaining, footer } = buildGuidedStep({
      stepIndex: 2,
      totalSteps: 4,
      target: { x: 10, y: 10, width: 40, height: 20 },
      display: primary,
      instruction: 'Klicka på PC0.',
    });
    expect(active.kind).toBe('ring');
    expect(active.step).toBe(2);
    expect(remaining).toBe(2);
    expect(footer).toBe('Steg 2 av 4');
  });

  it('only accepts input on interactive annotations', () => {
    const plan = {
      warnings: [],
      annotations: [{ id: 'a', kind: 'ring' as const, rect: { x: 0, y: 0, width: 50, height: 50 }, interactive: false }],
    };
    expect(shouldAcceptInput(plan, { x: 10, y: 10 })).toBe(false);
  });

  it('detects overlap with the reading area', () => {
    const plan = { warnings: [], annotations: [{ id: 'a', kind: 'box' as const, rect: { x: 100, y: 100, width: 100, height: 100 } }] };
    expect(overlapsReadingArea(plan, { x: 150, y: 150, width: 400, height: 200 })).toBe(true);
    expect(overlapsReadingArea(plan, { x: 1000, y: 1000, width: 100, height: 100 })).toBe(false);
  });

  it('expands rects for hit-testing', () => {
    expect(expandRect({ x: 10, y: 10, width: 10, height: 10 }, 5)).toEqual({ x: 5, y: 5, width: 20, height: 20 });
  });
});

describe('mascot state machine', () => {
  it('defines an expression for every animation state', () => {
    for (const state of ANIMATION_STATES) {
      expect(EXPRESSIONS[state]).toBeDefined();
      expect(STATE_LABEL[state].length).toBeGreaterThan(0);
    }
  });

  it('starts idle', () => {
    expect(initialMascotState().current).toBe('IDLE');
  });

  it('lets speaking interrupt thinking but not the other way around', () => {
    let state = transition(initialMascotState(), 'SPEAKING', { force: true }).state;
    const denied = transition(state, 'THINKING');
    expect(denied.accepted).toBe(false);
    expect(denied.state.current).toBe('SPEAKING');

    state = transition(initialMascotState(), 'THINKING').state;
    const accepted = transition(state, 'SPEAKING');
    expect(accepted.accepted).toBe(true);
    expect(accepted.state.current).toBe('SPEAKING');
  });

  it('expires transient states back to the base state', () => {
    const state = transition(initialMascotState(), 'THINKING').state;
    const blinked = transition(state, 'BLINKING', { now: 1000, durationMs: 150 });
    expect(blinked.state.current).toBe('BLINKING');
    expect(tick(blinked.state, 1100).current).toBe('BLINKING');
    expect(tick(blinked.state, 1200).current).toBe('THINKING');
  });

  it('can force a state change for explicit user actions', () => {
    const state = transition(initialMascotState(), 'SLEEPING', { force: true }).state;
    const forced = transition(state, 'CURIOUS', { force: true });
    expect(forced.accepted).toBe(true);
    expect(forced.state.current).toBe('CURIOUS');
  });

  it('maps every application signal to a state', () => {
    expect(stateForSignal('message-sent')).toBe('THINKING');
    expect(stateForSignal('voice-speaking')).toBe('SPEAKING');
    expect(stateForSignal('answer-correct')).toBe('CELEBRATING');
    expect(stateForSignal('answer-wrong')).toBe('ENCOURAGING');
    expect(stateForSignal('long-inactivity')).toBe('SLEEPING');
  });

  it('keeps celebrating above speaking in priority', () => {
    expect(STATE_PRIORITY.CELEBRATING).toBeGreaterThan(STATE_PRIORITY.SPEAKING);
  });
});
