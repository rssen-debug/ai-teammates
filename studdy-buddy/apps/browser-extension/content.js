/**
 * Content script: reads the study page the student has open.
 *
 * Works on ANY site. It does not know what Canvas, NetAcad or Moodle are; it
 * reads the same generic signals every course site exposes (headings, a
 * navigation tree, a title) and reports them with an explicit confidence marker.
 * The desktop app turns that into a curriculum graph.
 *
 * Rules this script follows:
 *  - read-only: it never clicks, types, submits or navigates
 *  - it does nothing at all until the app has accepted this site
 *    (`enabled` + `allowedSites` come from the service worker)
 *  - everything unreadable is reported as unknown, never guessed
 *  - selections are reported when the student selects text, not continuously
 */

(() => {
  if (window.top !== window) return; // never run inside sub-frames

  const MAX_LINKS = 400;
  const MAX_HEADINGS = 40;
  const MIN_HINT = 3;

  let active = false;

  function textOf(el) {
    return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function siteName() {
    const host = hostOf(location.href).replace(/^www\./, '');
    const label = document
      .querySelector('meta[property="og:site_name"]')
      ?.getAttribute('content');
    return (label ?? host).slice(0, 80);
  }

  /** Navigation items, with a depth hint derived from real DOM nesting. */
  function readNavLinks() {
    const selectors = [
      'nav a',
      '[role="navigation"] a',
      'aside a',
      '[aria-label*="ourse" i] a',
      '[aria-label*="odule" i] a',
      '[class*="sidebar"] a',
      '[class*="nav"] a',
      '[class*="menu"] a',
      '[class*="module"] a',
      '[class*="outline"] a',
      '[class*="toc"] a',
      '[class*="chapter"] a',
    ].join(', ');

    const links = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll(selectors)) {
      const text = textOf(anchor);
      if (!text || text.length > 160) continue;
      const href = anchor.getAttribute('href');
      if (href && /^(mailto:|javascript:|tel:)/i.test(href)) continue;
      const key = `${text}|${href ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let depth = 1;
      let node = anchor.parentElement;
      for (let i = 0; i < 6 && node; i += 1) {
        if (node.tagName === 'UL' || node.tagName === 'OL') depth += 1;
        node = node.parentElement;
      }
      const aria = anchor.getAttribute('aria-level');
      if (aria && Number.isFinite(Number(aria))) depth = Number(aria);

      links.push({
        text,
        href: href ? new URL(href, location.href).toString() : null,
        depth: Math.min(depth, 6),
        completed: readCompletion(anchor),
      });
      if (links.length >= MAX_LINKS) break;
    }
    return links;
  }

  /**
   * Completion ONLY when the page states it: an explicit label, an ARIA state or
   * a data attribute. Never inferred from colour, opacity or icon shape.
   */
  function readCompletion(anchor) {
    const label = `${anchor.getAttribute('aria-label') ?? ''} ${anchor.getAttribute('title') ?? ''}`.toLowerCase();
    if (/\b(completed|complete|avklarad|avklarat|klart|done|finished)\b/.test(label)) return true;
    if (anchor.getAttribute('data-completed') === 'true') return true;
    if (anchor.getAttribute('aria-checked') === 'true') return true;
    if (anchor.querySelector('[data-completed="true"], [aria-checked="true"]')) return true;
    if (anchor.getAttribute('data-completed') === 'false') return false;
    if (anchor.querySelector('[data-completed="false"], [aria-checked="false"]')) return false;
    const visuallyHidden = anchor.querySelector('.sr-only, .visually-hidden, [class*="screen-reader"]');
    if (visuallyHidden && /completed|avklarad/i.test(textOf(visuallyHidden))) return true;
    return null;
  }

  function readHeadings() {
    const out = [];
    for (const h of document.querySelectorAll('h1, h2, h3, h4')) {
      const text = textOf(h);
      if (!text || text.length > 200) continue;
      out.push({ level: Number(h.tagName.slice(1)), text });
      if (out.length >= MAX_HEADINGS) break;
    }
    return out;
  }

  function readCourseName() {
    const meta = document
      .querySelector('meta[property="og:title"], meta[name="course"]')
      ?.getAttribute('content');
    const candidates = [
      document.querySelector('[class*="course-title"]'),
      document.querySelector('[class*="coursename"]'),
      document.querySelector('[data-testid*="course"] h1'),
      document.querySelector('h1'),
    ];
    for (const el of candidates) {
      const text = textOf(el);
      if (text) return text.slice(0, 200);
    }
    return meta ? meta.slice(0, 200) : null;
  }

  /**
   * Some course sites render the lesson body in a cross-origin frame. If so we
   * say so, and the app marks the content unreadable instead of reporting an
   * empty page (which would look like an empty curriculum).
   */
  function pageHasUnreadableIframe() {
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        const doc = frame.contentDocument;
        if (!doc) return true;
        if (!doc.body) continue;
        if (textOf(doc.body).length < 40) continue;
      } catch {
        return true;
      }
    }
    return false;
  }

  /** True when the page looks like it has a real course structure to read. */
  function hasStudyHints() {
    const headings = document.querySelectorAll('h1, h2, h3').length;
    const links = document.querySelectorAll('nav a, aside a, [role="navigation"] a').length;
    return headings + links >= MIN_HINT;
  }

  function snapshot() {
    return {
      url: location.href,
      title: document.title.slice(0, 200),
      courseName: readCourseName(),
      siteName: siteName(),
      headings: readHeadings(),
      navLinks: readNavLinks(),
      contentInIframe: pageHasUnreadableIframe(),
      looksLikeStudyPage: hasStudyHints(),
      capturedAt: new Date().toISOString(),
    };
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      /* the service worker may be asleep; the next navigation retries */
    }
  }

  function publish() {
    if (!active) return;
    send({ type: 'page-context', payload: { schemaVersion: 1, page: snapshot(), snapshot: snapshot() } });
  }

  // ---- selection tracking: only deliberate selection, debounced ------------
  let selectionTimer = null;
  function onSelectionChange() {
    if (!active) return;
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (text.length < 4) return;
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const rect = range ? range.getBoundingClientRect() : null;
      send({
        type: 'selection',
        payload: {
          text: text.slice(0, 12000),
          url: location.href,
          rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        },
      });
    }, 450);
  }

  // ---- wiring --------------------------------------------------------------
  // The service worker decides whether this site is allowed. Until it says yes,
  // the script reads nothing and sends nothing.
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'set-active') {
      active = message.active === true;
      if (active) publish();
      respond({ ok: true, active });
      return true;
    }
    if (message?.type === 'request-snapshot') {
      respond({ ok: true, payload: active ? snapshot() : null });
      return true;
    }
    return false;
  });

  chrome.storage.local.get(['enabled', 'allowedSites'], (data) => {
    const sites = Array.isArray(data.allowedSites) ? data.allowedSites : [];
    const host = hostOf(location.href);
    const allowed = sites.some((s) => host === s || host.endsWith(`.${s}`));
    active = Boolean(data.enabled) && allowed;
    if (active) {
      publish();
      // SPA navigation: re-publish when the URL changes, debounced otherwise.
      let lastUrl = location.href;
      let snapshotTimer = null;
      const observer = new MutationObserver(() => {
        if (!active) return;
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          setTimeout(publish, 800);
          return;
        }
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(publish, 3000);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('selectionchange', onSelectionChange);
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if ('enabled' in changes || 'allowedSites' in changes) {
      chrome.storage.local.get(['enabled', 'allowedSites'], (data) => {
        const sites = Array.isArray(data.allowedSites) ? data.allowedSites : [];
        const host = hostOf(location.href);
        active = Boolean(data.enabled) && sites.some((s) => host === s || host.endsWith(`.${s}`));
        if (active) publish();
      });
    }
  });
})();
