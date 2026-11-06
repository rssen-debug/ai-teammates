import type { Rect } from '@studdy/shared';

/**
 * Where the conversation bubble goes relative to the monkey.
 *
 * Requirements: stay on screen, work across monitors, avoid covering the
 * content the student is reading, and stay stable (a bubble that jumps around
 * while you type is worse than one that covers a little text).
 */

export interface BubblePlacementInput {
  /** Mascot window bounds on the virtual desktop. */
  mascot: Rect;
  /** Bubble size at its current content height. */
  bubble: { width: number; height: number };
  /** Bounds of the display the mascot is on. */
  display: Rect;
  /** Region of the screen the student is currently reading, if known. */
  readingArea?: Rect | null;
  /** Previous placement, to keep the bubble from flipping sides needlessly. */
  previous?: 'right' | 'left' | 'above' | 'below' | null;
}

export interface BubblePlacement {
  side: 'right' | 'left' | 'above' | 'below';
  rect: Rect;
  warnings: string[];
}

const GAP = 12;
const MARGIN = 10;

export function placeBubble(input: BubblePlacementInput): BubblePlacement {
  const warnings: string[] = [];
  const { mascot, bubble, display } = input;
  const width = Math.min(bubble.width, display.width - MARGIN * 2);
  const height = Math.min(bubble.height, display.height - MARGIN * 2);

  // Work out how much room each side actually has. A side "has room" when the
  // bubble fits horizontally; vertically we always clamp, because a bubble that
  // shifts up beside the mascot is normal and not a defect.
  const spaceRight = display.x + display.width - (mascot.x + mascot.width) - GAP - MARGIN;
  const spaceLeft = mascot.x - display.x - GAP - MARGIN;
  const spaceAbove = mascot.y - display.y - GAP - MARGIN;
  const spaceBelow = display.y + display.height - (mascot.y + mascot.height) - GAP - MARGIN;

  const sideSpace: Record<BubblePlacement['side'], number> = {
    right: spaceRight,
    left: spaceLeft,
    above: spaceAbove,
    below: spaceBelow,
  };
  const fitsSide = (side: BubblePlacement['side']) =>
    side === 'left' || side === 'right' ? sideSpace[side] >= width : sideSpace[side] >= height;

  const rectFor = (side: BubblePlacement['side']): Rect => {
    switch (side) {
      case 'right':
        return { x: mascot.x + mascot.width + GAP, y: mascot.y + mascot.height / 2 - height / 2, width, height };
      case 'left':
        return { x: mascot.x - width - GAP, y: mascot.y + mascot.height / 2 - height / 2, width, height };
      case 'above':
        return { x: mascot.x + mascot.width / 2 - width / 2, y: mascot.y - height - GAP, width, height };
      case 'below':
      default:
        return { x: mascot.x + mascot.width / 2 - width / 2, y: mascot.y + mascot.height + GAP, width, height };
    }
  };

  // Preference order: the previous side (stability), then right, left, below, above.
  const order: BubblePlacement['side'][] = ['right', 'left', 'below', 'above'];
  const ordered = input.previous ? [input.previous, ...order.filter((s) => s !== input.previous)] : order;
  const viable = ordered.filter(fitsSide);

  let side: BubblePlacement['side'];
  if (viable.length === 0) {
    // Nothing fits; pick the roomiest side and say we had to adjust.
    side = (Object.entries(sideSpace) as [BubblePlacement['side'], number][]).sort((a, b) => b[1] - a[1])[0]![0];
    warnings.push('Bubblan fick justeras för att rymmas på skärmen.');
  } else {
    const avoiding = input.readingArea
      ? viable.filter((s) => !overlaps(rectFor(s), input.readingArea as Rect))
      : viable;
    if (input.readingArea && avoiding.length === 0) {
      warnings.push('Bubblan täcker en del av texten du läser. Flytta Buddy om det stör.');
    }
    side = (avoiding.length ? avoiding : viable)[0]!;
  }

  // Final safety pass over the reading area. Clamping can push a bubble into
  // text it previously avoided, so re-check and nudge vertically if that
  // happened. We only ever shift, never guess a different side at this point -
  // the side decision above is already the best one available.
  const rect = clampInto(display, rectFor(side));
  const nudged = input.readingArea ? nudgeAwayFrom(rect, input.readingArea as Rect, display) : rect;
  if (input.readingArea && overlaps(nudged, input.readingArea as Rect) && !warnings.some((w) => w.startsWith('Bubblan täcker'))) {
    warnings.push('Bubblan täcker en del av texten du läser. Flytta Buddy om det stör.');
  }
  return { side, rect: nudged, warnings };
}

/**
 * Moves a rect the shortest distance that stops it overlapping `area`, staying
 * inside `display`. Returns the original rect when no such movement exists.
 */
export function nudgeAwayFrom(rect: Rect, area: Rect, display: Rect): Rect {
  if (!overlaps(rect, area)) return rect;
  const candidates: Rect[] = [
    { ...rect, y: area.y - rect.height - GAP },
    { ...rect, y: area.y + area.height + GAP },
    { ...rect, x: area.x - rect.width - GAP },
    { ...rect, x: area.x + area.width + GAP },
  ].filter((candidate) => contains(display, candidate));

  if (candidates.length === 0) return rect;
  // Prefer the smallest movement so the bubble does not teleport.
  const distanceTo = (candidate: Rect) => Math.abs(candidate.x - rect.x) + Math.abs(candidate.y - rect.y);
  return candidates.sort((a, b) => distanceTo(a) - distanceTo(b))[0]!;
}

/** Bubble size for the current content, so it only grows as much as needed. */
export function measureBubble(args: {
  lineCount: number;
  hasCode: boolean;
  hasChips: boolean;
  hasStructured: boolean;
  maxHeight: number;
}): { width: number; height: number } {
  const width = args.hasCode ? 380 : 340;
  const lineHeight = 20;
  const chrome = 96; // header + composer
  const extra = (args.hasChips ? 34 : 0) + (args.hasStructured ? 26 : 0);
  const raw = chrome + args.lineCount * lineHeight + extra;
  return { width, height: Math.max(140, Math.min(raw, args.maxHeight)) };
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function overlaps(a: Rect, b: Rect): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

export function clampInto(display: Rect, rect: Rect): Rect {
  const x = Math.min(Math.max(rect.x, display.x + MARGIN), display.x + display.width - rect.width - MARGIN);
  const y = Math.min(Math.max(rect.y, display.y + MARGIN), display.y + display.height - rect.height - MARGIN);
  return { ...rect, x, y };
}

/**
 * Pixel region that must accept clicks while the rest of the mascot window stays
 * click-through. Electron implements this with setIgnoreMouseEvents + forward.
 */
export function interactiveRegions(mascot: Rect, bubble: Rect | null): Rect[] {
  return bubble ? [mascot, bubble] : [mascot];
}

export function shouldBeClickThrough(regions: Rect[], point: { x: number; y: number }): boolean {
  return !regions.some((r) => point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height);
}
