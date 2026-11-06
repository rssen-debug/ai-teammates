import type { DisplayInfo, Point, Rect } from '@studdy/shared';

/**
 * Coordinate mapping for screen annotations.
 *
 * The hard parts this handles:
 *  - multi-monitor layouts where displays have *negative* origins or gaps
 *  - DPI scaling differences between displays
 *  - targets that moved between observation and highlighting (stale refs)
 *  - clipping a highlight that straddles two monitors
 *
 * All coordinates in this module are in "virtual desktop DIP" space unless a
 * function says otherwise. Electron reports window bounds in DIP, while native
 * accessibility APIs often report physical pixels - that conversion happens at
 * the adapter boundary, and these helpers assume DIP in/out.
 */

export function displayContaining(displays: DisplayInfo[], point: Point): DisplayInfo | null {
  return displays.find((d) => pointInRect(point, d.bounds)) ?? null;
}

export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
  );
}

export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function clampRectToDisplay(rect: Rect, display: DisplayInfo): Rect {
  const clipped = intersectRects(rect, display.bounds);
  return clipped ?? { x: display.bounds.x, y: display.bounds.y, width: 0, height: 0 };
}

/**
 * Converts physical pixels from a native API into virtual-desktop DIP.
 *
 * Input is in *physical desktop* coordinates (as Windows UI Automation and
 * GDI report them), so the offset from the display origin is divided by the
 * scale factor and added back to the display's DIP origin.
 */
export function physicalToDip(point: Point, display: DisplayInfo): Point {
  const scale = display.scaleFactor || 1;
  const origin = displayPhysicalOrigin(display);
  return {
    x: display.bounds.x + (point.x - origin.x) / scale,
    y: display.bounds.y + (point.y - origin.y) / scale,
  };
}

export function dipToPhysical(point: Point, display: DisplayInfo): Point {
  const scale = display.scaleFactor || 1;
  const origin = displayPhysicalOrigin(display);
  return {
    x: origin.x + (point.x - display.bounds.x) * scale,
    y: origin.y + (point.y - display.bounds.y) * scale,
  };
}

/** What a native API reports for a *display origin* is already physical. */
export function displayPhysicalOrigin(display: DisplayInfo): Point {
  const scale = display.scaleFactor || 1;
  return { x: display.bounds.x * scale, y: display.bounds.y * scale };
}

/**
 * Converts a rect captured in a window's own client coordinates into virtual
 * desktop coordinates. Window bounds are DIP; client rects from Chromium are CSS
 * pixels. When the window is on a scaled display those differ, so we map via the
 * window's display scale.
 */
export function windowClientToDesktop(
  clientRect: Rect,
  windowBounds: Rect,
  display: DisplayInfo | null,
  options: { browserZoom?: number } = {},
): Rect {
  const zoom = options.browserZoom && options.browserZoom > 0 ? options.browserZoom : 1;
  const scale = display?.scaleFactor ?? 1;
  // CSS pixels -> DIP: CSS px are already DIP-equivalent in Electron when zoom is 1,
  // so we only correct for page zoom here.
  const x = windowBounds.x + clientRect.x / zoom;
  const y = windowBounds.y + clientRect.y / zoom;
  const width = clientRect.width / zoom;
  const height = clientRect.height / zoom;
  void scale;
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export interface TargetSnapshot {
  rect: Rect;
  /** Hash of the element's identity at capture time. */
  fingerprint: string;
  capturedAt: number;
}

export interface RevalidationInput {
  snapshot: TargetSnapshot;
  /** Freshly observed rect, or null when the target no longer exists. */
  freshRect: Rect | null;
  freshFingerprint: string | null;
  now: number;
  maxAgeMs?: number;
  /** Maximum tolerated movement in DIP before we refuse to highlight. */
  tolerance?: number;
}

export type Revalidation =
  | { ok: true; rect: Rect; note: string }
  | { ok: false; reason: string };

/**
 * The rule the spec is strict about: never draw an arrow to an uncertain
 * target as though it were verified. If the target moved beyond tolerance, or
 * disappeared, or is too old, we refuse and ask for a fresh observation.
 */
export function revalidateTarget(input: RevalidationInput): Revalidation {
  const maxAge = input.maxAgeMs ?? 4000;
  const tolerance = input.tolerance ?? 24;

  if (!input.freshRect) {
    return { ok: false, reason: 'Målet finns inte längre i det aktuella gränssnittet.' };
  }
  if (input.freshFingerprint && input.freshFingerprint !== input.snapshot.fingerprint) {
    return { ok: false, reason: 'Gränssnittet har ändrats sedan målet identifierades.' };
  }
  if (input.now - input.snapshot.capturedAt > maxAge) {
    return { ok: false, reason: 'Koordinaterna är för gamla för att markeras säkert.' };
  }
  const moved = distance(input.snapshot.rect, input.freshRect);
  if (moved > tolerance) {
    return { ok: false, reason: `Målet har flyttats ${Math.round(moved)} px sedan det identifierades.` };
  }
  // Trust the fresh rect - it is the one that is actually correct right now.
  return { ok: true, rect: input.freshRect, note: moved > 0 ? `Justerat ${Math.round(moved)} px` : 'Oförändrat' };
}

export function distance(a: Rect, b: Rect): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dw = a.width - b.width;
  const dh = a.height - b.height;
  return Math.sqrt(dx * dx + dy * dy + dw * dw + dh * dh);
}

// ---------------------------------------------------------------------------
// Annotation layout
// ---------------------------------------------------------------------------

export type AnnotationKind = 'ring' | 'box' | 'arrow' | 'step' | 'tooltip' | 'spotlight';

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  rect: Rect;
  label?: string;
  /** 1-based step number for guided sequences. */
  step?: number;
  /** Where a tooltip should be placed; auto-computed when omitted. */
  placement?: 'above' | 'below' | 'left' | 'right';
  /** Whether the overlay should let clicks through at this rect. */
  interactive?: boolean;
}

export interface AnnotationPlan {
  annotations: Annotation[];
  warnings: string[];
}

/**
 * Places a tooltip near its target while staying inside the visible desktop and
 * avoiding covering the target itself.
 */
export function placeTooltip(
  target: Rect,
  tooltipSize: { width: number; height: number },
  display: DisplayInfo,
  gap = 10,
): { rect: Rect; placement: 'above' | 'below' | 'left' | 'right' } {
  const candidates: { placement: 'above' | 'below' | 'left' | 'right'; rect: Rect }[] = [
    { placement: 'below', rect: { x: target.x, y: target.y + target.height + gap, ...tooltipSize } },
    { placement: 'above', rect: { x: target.x, y: target.y - tooltipSize.height - gap, ...tooltipSize } },
    { placement: 'right', rect: { x: target.x + target.width + gap, y: target.y, ...tooltipSize } },
    { placement: 'left', rect: { x: target.x - tooltipSize.width - gap, y: target.y, ...tooltipSize } },
  ];

  for (const candidate of candidates) {
    if (containsRect(display.bounds, candidate.rect)) return { rect: candidate.rect, placement: candidate.placement };
  }

  // Nothing fits cleanly: clamp the best candidate (below) into the display.
  const fallback = candidates[0]!.rect;
  const x = Math.min(Math.max(fallback.x, display.bounds.x + 4), display.bounds.x + display.bounds.width - tooltipSize.width - 4);
  const y = Math.min(Math.max(fallback.y, display.bounds.y + 4), display.bounds.y + display.bounds.height - tooltipSize.height - 4);
  return { rect: { x, y, ...tooltipSize }, placement: 'below' };
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Builds a one-step-at-a-time guide. The spec is explicit: never dump a list of
 * instructions. So this returns exactly one active annotation plus the
 * remaining steps as data for the caller to reveal later.
 */
export function buildGuidedStep(args: {
  stepIndex: number;
  totalSteps: number;
  target: Rect;
  display: DisplayInfo;
  instruction: string;
}): { active: Annotation; remaining: number; footer: string } {
  const active: Annotation = {
    id: `step-${args.stepIndex}`,
    kind: 'ring',
    rect: args.target,
    label: args.instruction,
    step: args.stepIndex,
  };
  return {
    active,
    remaining: Math.max(0, args.totalSteps - args.stepIndex),
    footer: `Steg ${args.stepIndex} av ${args.totalSteps}`,
  };
}

/** Hit test used by the click-through overlay to decide where to accept input. */
export function shouldAcceptInput(plan: AnnotationPlan, point: Point): boolean {
  return plan.annotations.some((a) => a.interactive && pointInRect(point, expandRect(a.rect, 6)));
}

export function expandRect(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 };
}

/** True when the plan would sit on top of text the student is reading. */
export function overlapsReadingArea(plan: AnnotationPlan, readingArea: Rect): boolean {
  return plan.annotations.some((a) => intersectRects(a.rect, readingArea) !== null);
}
