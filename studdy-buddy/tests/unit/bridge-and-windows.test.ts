import { describe, it, expect } from 'vitest';
import {
  generateBridgeToken,
  verifyToken,
  parseBridgeMessage,
  isAllowedPageUrl,
  normalizeSiteRule,
  validatePageContext,
  validateSelection,
} from '../../packages/core/src/browser-bridge.js';
import {
  mascotWindowOptions,
  overlayWindowOptions,
  clampToDisplay,
  initialMascotBounds,
  shouldIgnoreMouse,
  MASCOT_SIZE,
} from '../../packages/core/src/windows.js';

describe('browser bridge authentication', () => {
  const token = 'a'.repeat(48);

  it('accepts the exact token only', () => {
    expect(verifyToken(token, token).ok).toBe(true);
    expect(verifyToken('b'.repeat(48), token).ok).toBe(false);
    expect(verifyToken(undefined, token).ok).toBe(false);
    expect(verifyToken('', token).ok).toBe(false);
  });

  it('fails closed when no token is configured in the app', () => {
    expect(verifyToken('anything', '').ok).toBe(false);
  });

  it('generates a token of fixed length', () => {
    expect(generateBridgeToken()).toHaveLength(48);
    expect(generateBridgeToken()).not.toBe(generateBridgeToken());
  });
});

describe('bridge message parsing', () => {
  it('rejects unknown message types (allow-list, not block-list)', () => {
    const result = parseBridgeMessage(JSON.stringify({ type: 'exfiltrate-everything' }));
    expect(result.message).toBeNull();
    expect(result.error).toMatch(/Otillåten/);
  });

  it('rejects malformed JSON and oversized payloads', () => {
    expect(parseBridgeMessage('{oops').error).toMatch(/JSON/);
    expect(parseBridgeMessage('x'.repeat(2_000_001)).error).toMatch(/för stort/);
  });

  it('accepts allowed types and preserves the token', () => {
    const result = parseBridgeMessage(JSON.stringify({ type: 'page-context', token: 'abc', payload: { url: 'x' } }));
    expect(result.message?.type).toBe('page-context');
    expect(result.message?.token).toBe('abc');
  });
});

describe('page URL allow-list', () => {
  // The allow-list belongs to the student, not to a hardcoded vendor list.
  const sites = ['netacad.com', 'cisco.com', 'skillsforall.com', 'canvas.instructure.com', 'kth.se'];

  it('accepts any allowed study site, not just NetAcad', () => {
    expect(isAllowedPageUrl('https://www.netacad.com/courses/x', sites)).toBe(true);
    expect(isAllowedPageUrl('https://lms.netacad.com/lesson', sites)).toBe(true);
    expect(isAllowedPageUrl('https://canvas.instructure.com/courses/1/pages/x', sites)).toBe(true);
    expect(isAllowedPageUrl('https://www.kth.se/student/kurser', sites)).toBe(true);
  });

  it('accepts a site the student added themselves', () => {
    expect(isAllowedPageUrl('https://canvas.instructure.com/courses/1', ['university.example.edu'])).toBe(false);
    expect(isAllowedPageUrl('https://lms.university.example.edu/course/1', ['university.example.edu'])).toBe(true);
    expect(isAllowedPageUrl('https://canvas.instructure.com/courses/1', ['canvas.instructure.com'])).toBe(true);
  });

  it('normalises rules typed as URLs, with wildcards or www', () => {
    expect(normalizeSiteRule('https://canvas.instructure.com/courses/1')).toBe('canvas.instructure.com');
    expect(normalizeSiteRule('*.netacad.com')).toBe('netacad.com');
    expect(normalizeSiteRule('www.moodle.org')).toBe('moodle.org');
    expect(normalizeSiteRule('not a host')).toBeNull();
  });

  it('rejects lookalike and unrelated domains', () => {
    expect(isAllowedPageUrl('https://netacad.com.evil.io/x', sites)).toBe(false);
    expect(isAllowedPageUrl('https://evil.netacad.com.attacker.net/', sites)).toBe(false);
    expect(isAllowedPageUrl('http://www.netacad.com/x', sites)).toBe(false); // https only
    expect(isAllowedPageUrl('https://example.com', sites)).toBe(false);
    // A subdomain suffix match must respect the dot boundary.
    expect(isAllowedPageUrl('https://notkth.se/x', sites)).toBe(false);
  });

  it('fails closed when the student has not allowed any site', () => {
    expect(isAllowedPageUrl('https://www.netacad.com/x', [])).toBe(false);
    expect(isAllowedPageUrl('not a url', sites)).toBe(false);
  });
});

describe('payload validation', () => {
  const sites = ['netacad.com', 'canvas.instructure.com'];

  it('accepts a valid page context and caps the heading path', () => {
    const result = validatePageContext(
      {
        url: 'https://www.netacad.com/course',
        courseName: 'CCNA',
        headingPath: Array.from({ length: 30 }, (_, i) => `h${i}`),
        platformCompletedVisible: true,
      },
      sites,
    );
    expect(result.value?.headingPath).toHaveLength(12);
    expect(result.value?.platformCompletedVisible).toBe(true);
  });

  it('accepts a Canvas page, because the product is not NetAcad-only', () => {
    const result = validatePageContext(
      { url: 'https://canvas.instructure.com/courses/9/pages/meiosis', title: 'Meiosis', headingPath: ['Biologi 1', 'Meiosis'] },
      sites,
    );
    expect(result.value?.url).toContain('canvas.instructure.com');
    expect(result.value?.title).toBe('Meiosis');
  });

  it('rejects a page context from a non-approved origin', () => {
    const result = validatePageContext({ url: 'https://bank.example.com' }, sites);
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/tillåtna studiesajter/);
  });

  it('rejects everything when no site is allowed', () => {
    const result = validatePageContext({ url: 'https://www.netacad.com/course' }, []);
    expect(result.value).toBeNull();
    expect(result.error).toMatch(/Ingen sajt/);
  });

  it('rejects empty selections and truncates huge ones', () => {
    expect(validateSelection({ text: '   ', url: 'https://www.netacad.com/a' }, sites).value).toBeNull();
    const big = validateSelection({ text: 'x'.repeat(50_000), url: 'https://www.netacad.com/a' }, sites);
    expect(big.value?.text.length).toBe(12_000);
  });
});

describe('window security defaults', () => {
  it('enables context isolation and sandbox with no node integration', () => {
    const opts = mascotWindowOptions('/preload.cjs', null) as { webPreferences: Record<string, unknown> };
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.sandbox).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.webSecurity).toBe(true);
    expect(opts.webPreferences.devTools).toBe(false);
  });

  it('makes the mascot transparent, frameless and always on top', () => {
    const opts = mascotWindowOptions('/p.cjs', null) as Record<string, unknown>;
    expect(opts.transparent).toBe(true);
    expect(opts.frame).toBe(false);
    expect(opts.alwaysOnTop).toBe(true);
    expect(opts.backgroundColor).toBe('#00000000');
  });

  it('makes the overlay non-focusable so it never steals input', () => {
    const opts = overlayWindowOptions({ x: 0, y: 0, width: 1920, height: 1080 }, '/p.cjs', null) as Record<string, unknown>;
    expect(opts.focusable).toBe(false);
    expect(opts.transparent).toBe(true);
    expect(opts.alwaysOnTop).toBe(true);
  });
});

describe('mascot position memory', () => {
  const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true };
  const secondary = { bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, isPrimary: false };

  it('docks bottom-right on a fresh install', () => {
    const bounds = initialMascotBounds(null, [primary, secondary]);
    expect(bounds.x).toBe(1920 - MASCOT_SIZE.width - 24);
    expect(bounds.y).toBe(1080 - MASCOT_SIZE.height - 24);
  });

  it('restores a saved position on the correct display', () => {
    const bounds = initialMascotBounds({ x: 2000, y: 200 }, [primary, secondary]);
    expect(bounds.x).toBe(2000);
    expect(bounds.y).toBe(200);
  });

  it('clamps a saved position that is now off-screen', () => {
    const bounds = initialMascotBounds({ x: 5000, y: 5000 }, [primary]);
    expect(bounds.x).toBeLessThanOrEqual(1920 - MASCOT_SIZE.width);
    expect(bounds.y).toBeLessThanOrEqual(1080 - MASCOT_SIZE.height);
  });

  it('clamps into a display with a negative origin', () => {
    const left = { bounds: { x: -1280, y: 0, width: 1280, height: 1024 }, isPrimary: true };
    const bounds = clampToDisplay({ x: -2000, y: -50, ...MASCOT_SIZE }, left.bounds);
    expect(bounds.x).toBe(-1280);
    expect(bounds.y).toBe(0);
  });
});

describe('click-through policy', () => {
  it('ignores mouse outside interactive regions', () => {
    const windowBounds = { x: 100, y: 100, width: 360, height: 560 };
    const regions = [{ x: 0, y: 0, width: 132, height: 132 }];
    expect(shouldIgnoreMouse({ point: { x: 120, y: 120 }, regions, windowBounds })).toBe(false);
    expect(shouldIgnoreMouse({ point: { x: 400, y: 400 }, regions, windowBounds })).toBe(true);
  });

  it('keeps the bubble area interactive when it is listed', () => {
    const windowBounds = { x: 0, y: 0, width: 360, height: 560 };
    const regions = [
      { x: 0, y: 0, width: 132, height: 132 },
      { x: 8, y: 146, width: 344, height: 300 },
    ];
    expect(shouldIgnoreMouse({ point: { x: 100, y: 200 }, regions, windowBounds })).toBe(false);
  });
});
