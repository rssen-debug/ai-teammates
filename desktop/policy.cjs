const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostOrigin(raw = 'http://127.0.0.1:7373') {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Host URL must be an origin without credentials, path or query.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('Host requires HTTPS, except on loopback.');
  }
  return url.origin;
}

function v5HostOrigin(raw = 'http://127.0.0.1:4555') {
  return hostOrigin(raw);
}

function sameOrigin(raw, origin) {
  try { return new URL(raw).origin === origin; } catch { return false; }
}

function restoreBounds(saved, displays) {
  // Start with the shared mobile layout in a desktop app window. Resizing and
  // previously saved bounds still work; there is no separate desktop UI.
  const fallback = { width: 520, height: 860 };
  if (!saved || !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(saved[k]))) return fallback;
  const width = Math.max(400, Math.min(3840, saved.width));
  const height = Math.max(400, Math.min(2160, saved.height));
  const visible = displays.some(({ workArea: a }) => saved.x < a.x + a.width - 80
    && saved.x + width > a.x + 80 && saved.y >= a.y && saved.y < a.y + a.height - 80);
  return visible ? { x: saved.x, y: saved.y, width, height } : fallback;
}

function restoreV5Bounds(saved, displays) {
  const fallback = { width: 1080, height: 820 };
  if (!saved || !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(saved[k]))) return fallback;
  const width = Math.max(420, Math.min(3840, saved.width));
  const height = Math.max(460, Math.min(2160, saved.height));
  const visible = displays.some(({ workArea: a }) => saved.x < a.x + a.width - 80
    && saved.x + width > a.x + 80 && saved.y >= a.y && saved.y < a.y + a.height - 80);
  return visible ? { x: saved.x, y: saved.y, width, height } : fallback;
}

module.exports = { hostOrigin, v5HostOrigin, sameOrigin, restoreBounds, restoreV5Bounds };
