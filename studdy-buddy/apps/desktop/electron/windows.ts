/**
 * Window construction, kept free of app logic so it can be unit tested with a
 * fake BrowserWindow factory.
 *
 * Three windows make up the product:
 *   mascot   - transparent, frameless, always-on-top, click-through outside content
 *   bubble   - the conversation, attached beside the mascot (same window in the
 *              default layout to avoid focus stealing; see main.ts)
 *   overlay  - full-display transparent annotation layer, always click-through
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MASCOT_SIZE = { width: 360, height: 560 };

/**
 * The mascot window is intentionally larger than the monkey: it must have room
 * for the conversation bubble without the window resizing while the student is
 * reading (a resizing always-on-top window is the classic Electron flicker bug).
 * Areas outside the monkey and bubble are click-through, so the extra space is
 * visually and functionally empty.
 */
export function mascotWindowOptions(preloadPath: string, url: string | null, opts: { devTools?: boolean } = {}): Record<string, unknown> {
  return {
    width: MASCOT_SIZE.width,
    height: MASCOT_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // 'screen-saver' keeps Buddy above full-width app windows without stealing
    // focus from Packet Tracer.
    level: 'screen-saver',
    focusable: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: opts.devTools ?? false,
    },
    ...(url ? { url } : {}),
  };
}

export function overlayWindowOptions(displayBounds: Rect, preloadPath: string, url: string | null): Record<string, unknown> {
  return {
    x: displayBounds.x,
    y: displayBounds.y,
    width: displayBounds.width,
    height: displayBounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    level: 'screen-saver',
    focusable: false,
    show: false,
    // The overlay must never intercept input: it is a drawing surface only.
    // Click-through is enforced at the OS level via setIgnoreMouseEvents.
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
    },
    ...(url ? { url } : {}),
  };
}

export function settingsWindowOptions(preloadPath: string, url: string | null): Record<string, unknown> {
  return {
    width: 460,
    height: 640,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
    },
    ...(url ? { url } : {}),
  };
}

/** Clamps the mascot into the work area of the display it is on. */
export function clampToDisplay(rect: Rect, display: Rect): Rect {
  const width = Math.min(rect.width, display.width);
  const height = Math.min(rect.height, display.height);
  return {
    x: Math.min(Math.max(rect.x, display.x), display.x + display.width - width),
    y: Math.min(Math.max(rect.y, display.y), display.y + display.height - height),
    width,
    height,
  };
}

/** Restores the saved position, or docks bottom-right of the primary display. */
export function initialMascotBounds(saved: { x: number; y: number } | null, displays: { bounds: Rect; isPrimary?: boolean }[]): Rect {
  const primary = displays.find((d) => d.isPrimary) ?? displays[0];
  if (!primary) return { x: 0, y: 0, ...MASCOT_SIZE };
  if (saved) {
    const target = displays.find(
      (d) =>
        saved.x >= d.bounds.x && saved.x < d.bounds.x + d.bounds.width && saved.y >= d.bounds.y && saved.y < d.bounds.y + d.bounds.height,
    );
    return clampToDisplay({ x: saved.x, y: saved.y, ...MASCOT_SIZE }, (target ?? primary).bounds);
  }
  return clampToDisplay(
    {
      x: primary.bounds.x + primary.bounds.width - MASCOT_SIZE.width - 24,
      y: primary.bounds.y + primary.bounds.height - MASCOT_SIZE.height - 24,
      ...MASCOT_SIZE,
    },
    primary.bounds,
  );
}

/**
 * Click-through policy. Electron only supports ignore-mouse per window, so we
 * toggle it from the renderer as the cursor enters/leaves interactive regions.
 * Exported separately because this is the part that is easy to get wrong and
 * needs a test.
 */
export function shouldIgnoreMouse(opts: { point: { x: number; y: number }; regions: Rect[]; windowBounds: Rect }): boolean {
  const local = { x: opts.point.x - opts.windowBounds.x, y: opts.point.y - opts.windowBounds.y };
  return !opts.regions.some(
    (r) => local.x >= r.x && local.x < r.x + r.width && local.y >= r.y && local.y < r.y + r.height,
  );
}
