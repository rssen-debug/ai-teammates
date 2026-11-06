import { describe, it, expect } from 'vitest';
import { placeBubble, measureBubble, shouldBeClickThrough, interactiveRegions, contains, overlaps, clampInto } from '@studdy/chat-ui';
import { splitCodeSegments } from '@studdy/chat-ui';
import { darkTheme, lightTheme, themeFor, themeToCssVars } from '@studdy/chat-ui';

const display = { x: 0, y: 0, width: 1920, height: 1080 };
const mascot = { x: 1700, y: 900, width: 120, height: 120 };

describe('bubble placement', () => {
  it('places the bubble on the side with room and stays on screen', () => {
    const result = placeBubble({ mascot, bubble: { width: 340, height: 420 }, display });
    expect(result.side).toBe('left');
    expect(contains(display, result.rect)).toBe(true);
  });

  it('avoids covering the reading area when possible', () => {
    const readingArea = { x: 1200, y: 100, width: 600, height: 700 };
    const result = placeBubble({ mascot, bubble: { width: 340, height: 420 }, display, readingArea });
    expect(overlaps(result.rect, readingArea)).toBe(false);
    expect(contains(display, result.rect)).toBe(true);
  });

  it('warns when it must cover part of the reading area', () => {
    // Mascot in the middle, reading area all around: every side overlaps.
    const centred = { x: 900, y: 500, width: 120, height: 120 };
    const readingArea = { x: 600, y: 300, width: 900, height: 600 };
    const result = placeBubble({ mascot: centred, bubble: { width: 340, height: 300 }, display, readingArea });
    expect(result.warnings.join(' ')).toMatch(/täcker/);
  });

  it('clamps a bubble that would leave the display', () => {
    const bottomRight = { x: 1860, y: 1020, width: 60, height: 60 };
    const result = placeBubble({ mascot: bottomRight, bubble: { width: 340, height: 300 }, display });
    expect(contains(display, result.rect)).toBe(true);
  });

  it('keeps the previous side when it is still valid (no flicker)', () => {
    const first = placeBubble({ mascot, bubble: { width: 340, height: 300 }, display, previous: 'left' });
    const second = placeBubble({ mascot, bubble: { width: 340, height: 340 }, display, previous: 'left' });
    expect(first.side).toBe(second.side);
  });

  it('works on a display with a negative origin', () => {
    const leftDisplay = { x: -1600, y: 0, width: 1600, height: 900 };
    const mascotLeft = { x: -400, y: 700, width: 120, height: 120 };
    const result = placeBubble({ mascot: mascotLeft, bubble: { width: 320, height: 300 }, display: leftDisplay });
    expect(contains(leftDisplay, result.rect)).toBe(true);
  });
});

describe('bubble measurement', () => {
  it('grows with the content but never beyond the maximum', () => {
    const small = measureBubble({ lineCount: 1, hasCode: false, hasChips: false, hasStructured: false, maxHeight: 560 });
    const big = measureBubble({ lineCount: 40, hasCode: false, hasChips: false, hasStructured: false, maxHeight: 560 });
    expect(small.height).toBeLessThan(big.height);
    expect(big.height).toBe(560);
    expect(small.height).toBeGreaterThanOrEqual(140);
  });

  it('widens when code is present', () => {
    const plain = measureBubble({ lineCount: 4, hasCode: false, hasChips: false, hasStructured: false, maxHeight: 560 });
    const code = measureBubble({ lineCount: 4, hasCode: true, hasChips: false, hasStructured: false, maxHeight: 560 });
    expect(code.width).toBeGreaterThan(plain.width);
  });
});

describe('click-through regions', () => {
  it('makes everything except mascot and bubble click-through', () => {
    const regions = interactiveRegions(mascot, { x: 1200, y: 700, width: 340, height: 400 });
    expect(shouldBeClickThrough(regions, { x: 1800, y: 950 })).toBe(false); // on mascot
    expect(shouldBeClickThrough(regions, { x: 1300, y: 800 })).toBe(false); // on bubble
    expect(shouldBeClickThrough(regions, { x: 200, y: 200 })).toBe(true); // elsewhere
  });

  it('only the mascot is interactive when no bubble is open', () => {
    const regions = interactiveRegions(mascot, null);
    expect(shouldBeClickThrough(regions, { x: 1300, y: 800 })).toBe(true);
  });
});

describe('clamping', () => {
  it('clamps inside the display with a margin', () => {
    const clamped = clampInto(display, { x: 1900, y: 1070, width: 200, height: 100 });
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(display.width);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(display.height);
  });
});

describe('message rendering helpers', () => {
  it('splits prose and fenced code', () => {
    const segments = splitCodeSegments('Skriv:\n```cli\nshow ip interface brief\n```\nDet visar status.');
    expect(segments[0]?.type).toBe('text');
    expect(segments[1]?.type).toBe('code');
    expect(segments[1]?.text).toContain('show ip interface brief');
    expect(segments[1]?.language).toBe('cli');
    expect(segments[2]?.type).toBe('text');
  });

  it('returns a single text segment when there is no code', () => {
    const segments = splitCodeSegments('Bara text.');
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('Bara text.');
  });

  it('does not lose an empty message', () => {
    expect(splitCodeSegments('')).toHaveLength(1);
  });
});

describe('themes', () => {
  it('resolves the system preference both ways', () => {
    expect(themeFor('system', true).name).toBe('dark');
    expect(themeFor('system', false).name).toBe('light');
    expect(themeFor('dark', false).name).toBe('dark');
  });

  it('emits css variables for every token the UI uses', () => {
    const vars = themeToCssVars(darkTheme);
    for (const key of ['--buddy-surface', '--buddy-text', '--buddy-accent', '--buddy-radius-lg', '--buddy-font-ui']) {
      expect(vars[key]).toBeTruthy();
    }
    expect(Object.keys(themeToCssVars(lightTheme))).toEqual(Object.keys(vars));
  });

  it('keeps light and dark text distinct', () => {
    expect(darkTheme.text).not.toBe(lightTheme.text);
  });
});
