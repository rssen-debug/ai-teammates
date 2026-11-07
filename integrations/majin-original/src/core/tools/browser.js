/**
 * Browser automation powered by Playwright Core (no model/provider dependency).
 * The browser is intentionally isolated in MAJIN's own persistent profile.
 * Remote writes require an exact origin grant supplied by the owning runtime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { def } from './registry.js';
import { dirs } from '../paths.js';
import { GROUND_JS, CLEAR_JS, rememberRefs, recallRef, clearRefs, renderElementsText } from '../browser-ground.js';
import { VERIFY_JS, verificationCriteria, verifyObserved, browserRecoveryAdvice } from '../browser-evidence.js';

const sessions = new Map();
const recentShots = new Map();

export function browserWriteOrigins(ctx) {
  try {
    const raw = typeof ctx?.browserWriteOrigins === 'function' ? ctx.browserWriteOrigins() : ctx?.browserWriteOrigins;
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((value) => {
      try {
        if (value === '*') return '*';
        const parsed = new URL(String(value));
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.origin : null;
      } catch { return null; }
    }).filter(Boolean))].sort();
  } catch { return []; }
}

export function browserWriteAllowed(ctx, url) {
  try { const parsed = new URL(url); const origins = browserWriteOrigins(ctx); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && (origins.includes('*') || origins.includes(parsed.origin)); } catch { return false; }
}

function stateFor(ctx) {
  const key = String(ctx.session || 'desktop');
  if (!sessions.has(key)) sessions.set(key, { context: null, page: null, browserType: null, headless: true, lock: Promise.resolve(), blockedRequests: [] });
  return sessions.get(key);
}

function requirePage(ctx) {
  const p = stateFor(ctx).page;
  if (!p || p.isClosed()) throw new Error('browser is not open; call browser.open first');
  return p;
}

function audit(ctx, action, detail = {}, p = stateFor(ctx).page) {
  const record = { type: 'browser:action', action, url: p?.url?.() || null, ...detail };
  ctx.emit?.(record);
  return record;
}

async function withSession(ctx, fn) {
  const state = stateFor(ctx);
  const previous = state.lock;
  let release;
  state.lock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn(state);
  } finally {
    release();
  }
}

function withPage(ctx, fn) {
  return withSession(ctx, () => fn(requirePage(ctx)));
}

async function syncBrowserWriteOrigins(p, ctx) {
  const origins = browserWriteOrigins(ctx);
  await p.evaluate((allowed) => { window.__majinBrowserWriteOrigins = [...allowed]; }, origins).catch(() => {});
  return origins;
}

function browserHandoffError(code, message, handoff) {
  const error = new Error(message);
  error.code = code;
  error.meta = { ownerHandoff: { code, ...handoff } };
  return error;
}

function groundSession(ctx) {
  return String(ctx.session || 'desktop');
}

function groundError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Resolve an optional iframe selector (resolved on the top page) to the
 * locator/evaluate root for frame-scoped tools. Cross-origin iframes are
 * reachable through Playwright/CDP; a missing, ambiguous or non-iframe match
 * is an honest error rather than a silent fall-back to the main document.
 */
async function locatorRoot(p, frameSelector) {
  if (!frameSelector) return p;
  const locator = p.locator(frameSelector);
  const count = await locator.count();
  if (count !== 1) throw new Error(count ? `${count} elements matched frame selector; use a unique iframe selector: ${frameSelector}` : `no iframe matched frame selector: ${frameSelector} (browser.inspect lists page iframes)`);
  const handle = await locator.elementHandle();
  try {
    const tag = await handle.evaluate((el) => el.tagName.toLowerCase());
    if (!['iframe', 'frame'].includes(tag)) throw new Error(`frame selector matched <${tag}>, not an iframe: ${frameSelector}`);
    const frame = await handle.contentFrame();
    if (!frame) throw new Error(`iframe has no accessible content frame yet (still loading?): ${frameSelector}`);
    return frame;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function groundPage(p, ctx, { remember = true, frameSelector = '' } = {}) {
  const root = await locatorRoot(p, frameSelector);
  const payload = await root.evaluate(GROUND_JS);
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];
  if (remember) rememberRefs(groundSession(ctx), elements);
  return { ...(payload || {}), elements, count: elements.length, url: payload?.url || root.url(), title: payload?.title || '' };
}

function sameGroundDescriptor(a, b) {
  if (!a || !b) return false;
  const fields = ['tag', 'role', 'text', 'id', 'name', 'href', 'type'];
  return fields.every((field) => String(a[field] ?? '') === String(b[field] ?? ''))
    && Boolean(a.disabled) === Boolean(b.disabled);
}

/**
 * Resolve a Set-of-Marks ref to its live selector, refusing unknown or stale
 * refs. The descriptor cache is refreshed only after identity is proven, so a
 * stale ref can never become valid by retrying it.
 */
async function resolveGroundedSelector(p, ctx, refName, frameSelector = '') {
  if (!/^e[1-9][0-9]*$/.test(refName)) throw groundError('ref_unknown', `ref_unknown: ${refName} is not a Set-of-Marks ref; call browser.inspect with marks=true`);
  const cached = recallRef(groundSession(ctx), refName);
  if (!cached) throw groundError('ref_unknown', `ref_unknown: ${refName} is not in the current grounded snapshot; call browser.inspect with marks=true`);
  const grounded = await groundPage(p, ctx, { remember: false, frameSelector });
  const current = grounded.elements.find((element) => element.ref === refName);
  if (!current || !sameGroundDescriptor(cached, current)) {
    throw groundError('ref_stale', `ref_stale: ${refName} no longer identifies the same visible element; call browser.inspect with marks=true and use a fresh ref`);
  }
  rememberRefs(groundSession(ctx), grounded.elements);
  return `[data-majin-ref="${refName}"]`;
}

async function detectOwnerHandoff(p, ctx) {
  const found = await p.evaluate(() => {
    const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const labelFor = (el) => [
      ...(el.labels ? [...el.labels].map((label) => label.innerText || '') : []),
      el.closest?.('label')?.innerText || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('placeholder') || '',
    ].join(' ');
    const attrsFor = (el) => [
      el.getAttribute?.('type') || '', el.getAttribute?.('name') || '', el.getAttribute?.('id') || '',
      el.getAttribute?.('autocomplete') || '', el.getAttribute?.('inputmode') || '', labelFor(el),
    ].join(' ');
    const title = document.title || '';
    const text = (document.body?.innerText || '').slice(0, 16000);
    const pageText = `${title}\n${location.href}\n${text}`;
    const inputs = [...document.querySelectorAll('input,textarea')].filter(visible);
    const captchaWidget = [
      'iframe[src*="recaptcha" i]', 'iframe[src*="hcaptcha" i]', 'iframe[src*="turnstile" i]',
      '.g-recaptcha', '.h-captcha', '.cf-turnstile', '[data-sitekey]',
    ].some((selector) => [...document.querySelectorAll(selector)].some(visible));
    const signals = [];
    let kind = null;
    if (captchaWidget || /\b(complete (?:the )?captcha|captcha (?:verification|challenge|check)|verify you are human|i am not a robot|security check)\b/i.test(pageText)) {
      kind = 'CAPTCHA';
      signals.push(captchaWidget ? 'captcha widget' : 'captcha challenge text');
    }
    const otpInput = inputs.find((el) => {
      const attrs = attrsFor(el);
      return /one-time-code/i.test(el.getAttribute?.('autocomplete') || '')
        || /\b(otp|one[-\s]?time(?:\s+code)?|verification\s+code|authenticator(?:\s+code)?|two[-\s]?factor|multi[-\s]?factor)\b/i.test(attrs);
    });
    if (otpInput || /\b(two[-\s]?factor authentication|multi[-\s]?factor authentication|enter (?:the )?(?:verification|authenticator|one[-\s]?time) code|check your authenticator)\b/i.test(pageText)) {
      kind ||= 'MFA';
      signals.push(otpInput ? 'one-time-code field' : 'multi-factor challenge text');
    }
    const password = inputs.find((el) => String(el.getAttribute?.('type') || '').toLowerCase() === 'password');
    if (password) {
      const form = password.closest?.('form');
      const formText = form?.innerText || '';
      const hasSubmit = Boolean(form?.querySelector('button[type="submit"],input[type="submit"],button:not([type])'));
      const loginContext = hasSubmit || /\b(log\s*in|sign\s*in|username|password)\b/i.test(`${pageText}\n${formText}`);
      if (loginContext) {
        kind ||= 'LOGIN';
        signals.push('password field on a sign-in form');
      }
    }
    return kind ? { kind, signal: signals[0], signals } : null;
  }).catch(() => null);
  if (!found) return null;
  let origin = null;
  try { origin = new URL(p.url()).origin; } catch { /* keep URL evidence only */ }
  return {
    ...found,
    code: 'BROWSER_OWNER_HANDOFF_REQUIRED',
    url: p.url(),
    origin,
    headless: stateFor(ctx).headless,
    visibleBrowser: !stateFor(ctx).headless,
    action: found.kind === 'LOGIN'
      ? 'Complete sign-in in MAJIN\'s browser session, then resume the saved goal.'
      : `Complete the ${found.kind} check in MAJIN's browser session, then resume the saved goal.`,
  };
}

async function withOwnerHandoff(p, ctx, output) {
  const handoff = await detectOwnerHandoff(p, ctx);
  if (!handoff) return output;
  output.meta = { ...(output.meta || {}), ownerHandoff: handoff };
  output.result = `${output.result}\nOWNER HANDOFF REQUIRED (${handoff.kind}: ${handoff.signal}). ${handoff.action} The live browser session is preserved while the MAJIN host remains running.`;
  return output;
}

function chromePath() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => fs.existsSync(p)) || undefined;
}

async function loadChromium() {
  try {
    const pw = await import('playwright-core');
    return pw.chromium;
  } catch (err) {
    const e = new Error('Playwright Core is not installed. Install dependencies with `npm install` and try again.');
    e.cause = err;
    throw e;
  }
}

async function safeClick(p, selector, index, ctx, frameSelector = '') {
  await syncBrowserWriteOrigins(p, ctx);
  const root = await locatorRoot(p, frameSelector);
  const locator = root.locator(selector);
  const count = await locator.count();
  if (!count) throw new Error(`no element matched selector: ${selector}`);
  if (index == null && count !== 1) throw new Error(`${count} elements matched; specify index (0-based) to choose one`);
  const target = locator.nth(index ?? 0);
  const meta = await target.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    type: String(el.type || '').toLowerCase(),
    role: (el.getAttribute('role') || '').toLowerCase(),
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 160),
  }));
  const submitLabel = /\b(apply|submit|send application|skicka ansökan|skicka ansokan|skicka ansökan|ansök nu|ansok nu)\b/i.test(meta.text);
  // A submit inside an iframe posts from the frame document, so an exact
  // owner grant for either the page origin or the frame origin authorizes it;
  // the context route guard still blocks any non-GET to ungranted origins.
  const writeGranted = browserWriteAllowed(ctx, p.url()) || (root !== p && browserWriteAllowed(ctx, root.url()));
  if (!writeGranted && ((meta.tag === 'button' && meta.type === 'submit') || (meta.tag === 'input' && ['submit', 'image'].includes(meta.type)) || meta.role === 'submit' || (['button', 'input'].includes(meta.tag) && submitLabel))) {
    let origin = null;
    try { origin = new URL(p.url()).origin; } catch { /* URL remains in the handoff record */ }
    throw browserHandoffError(
      'BROWSER_ORIGIN_GRANT_REQUIRED',
      `Blocked final form-submit control (${meta.text || selector}) because this exact origin has no owner browser-write grant: ${origin || p.url()}. Nothing was submitted. Grant that exact origin, then resume the saved goal.`,
      {
        kind: 'BROWSER_ORIGIN',
        signal: 'final submit control on an ungranted origin',
        url: p.url(),
        origin,
        selector,
        control: meta,
        headless: stateFor(ctx).headless,
        visibleBrowser: !stateFor(ctx).headless,
        action: 'Grant this exact browser origin, then resume the saved goal. The prepared page is preserved while the MAJIN host remains running.',
      },
    );
  }
  await target.click();
  await p.waitForTimeout(200);
  return meta;
}

function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('url must be a valid http(s) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('only http(s) URLs are allowed');
  return parsed.toString();
}

export const browserTools = [
  def({
    name: 'browser.open',
    group: 'browser',
    risk: 'read',
    desc: 'Open or navigate a real browser page using Playwright Core. Uses an isolated persistent MAJIN profile. By default tools never submit forms. The owner host can authorize writes to exact origins; a model cannot grant this permission.',
    params: {
      url: 'string: http(s) page to open',
      headless: 'boolean: run without a visible browser window (default true)',
      executablePath: 'string: optional Chrome/Edge/Chromium executable path',
    },
    examples: ['browser.open({url:"https://example.com",headless:false})'],
    required: ['url'],
    async run({ url, headless = true, executablePath = '' }, ctx) {
      const targetUrl = validateUrl(url);
      return withSession(ctx, async (state) => {
        if (state.context && state.page && !state.page.isClosed() && state.headless !== Boolean(headless)) {
          // A visibility change cannot be applied to a launched Chromium
          // context. Relaunch against the same persistent MAJIN profile so
          // cookies/site storage survive; only transient page state is lost,
          // and we are about to navigate to the requested URL anyway.
          await state.context.close().catch(() => {});
          state.context = null;
          state.page = null;
          state.browserType = null;
        }
        if (!state.context || !state.page || state.page.isClosed()) {
          state.browserType = await loadChromium();
          fs.mkdirSync(dirs.cache, { recursive: true });
          const executable = executablePath || chromePath();
          const profile = createHash('sha256').update(String(ctx.session || 'desktop')).digest('hex').slice(0, 16);
          const profileDir = path.join(dirs.cache, `browser-profile-${profile}`);
          // Playwright's default launch timeout is 180s, which is longer than
          // the V5 driver's per-operation budget: a stuck Edge/Chromium start
          // would surface only as a generic driver TIMEOUT with the worker
          // killed. Bound the launch itself so the real Playwright error
          // (profile lock, binary failure, CDP handshake) is the observation
          // the agent and owner can act on.
          const launchTimeoutMs = Number(process.env.MAJIN_BROWSER_LAUNCH_TIMEOUT_MS) > 0
            ? Number(process.env.MAJIN_BROWSER_LAUNCH_TIMEOUT_MS)
            : 45000;
          if (process.platform === 'win32') {
            // Edge/Chromium resolves DIR_LOCAL_APP_DATA under %USERPROFILE%.
            // In a sandboxed/portable home (and in spawned-process tests that
            // point USERPROFILE at an empty temp profile) a missing
            // AppData\Local makes that lookup fail; Chromium then cannot tell
            // that our explicit --user-data-dir is non-default and refuses
            // remote debugging, so Playwright never connects. Creating the
            // standard, empty AppData folders is sufficient and harmless.
            const userProfile = process.env.USERPROFILE || os.homedir();
            if (userProfile) {
              for (const appDataDir of [
                path.join(userProfile, 'AppData', 'Local'),
                path.join(userProfile, 'AppData', 'Roaming'),
              ]) {
                try { fs.mkdirSync(appDataDir, { recursive: true }); } catch { /* launch will surface the real error */ }
              }
            }
          }
          try {
            state.context = await state.browserType.launchPersistentContext(profileDir, {
              headless: Boolean(headless),
              ...(executable ? { executablePath: executable } : {}),
              viewport: { width: 1440, height: 1000 },
              acceptDownloads: true,
              serviceWorkers: 'block',
              timeout: launchTimeoutMs,
            });
          } catch (error) {
            state.context = null;
            state.page = null;
            const raw = String(error?.message || error);
            // Playwright's call log starts with the very long browser command
            // line; the actionable evidence (browser stderr, CDP handshake
            // failure) is at the end. Keep those lines instead of truncating
            // the head of the message.
            const evidenceLines = raw.split(/\r?\n/).filter((line) => /\[err\]|\[out\]|<launched>|timeout|error|failed|closed|exit/i.test(line));
            const detail = (evidenceLines.length ? evidenceLines.join('\n') : raw).slice(-4000);
            const launchError = new Error(
              `Browser launch failed (executable: ${executable || 'playwright-managed'}, profile: ${profileDir}, headless: ${Boolean(headless)}, timeoutMs: ${launchTimeoutMs}): ${detail}`,
            );
            launchError.code = 'BROWSER_LAUNCH_FAILED';
            launchError.cause = error;
            throw launchError;
          }
          state.headless = Boolean(headless);
          state.context.setDefaultTimeout(12000);
          state.page = state.context.pages()[0] || await state.context.newPage();
          state.context.on('page', (newPage) => newPage.on('dialog', (dialog) => dialog.dismiss().catch(() => {})));
          // Defense in depth: stop native form submits in every tab before site handlers run.
          await state.context.addInitScript((origins) => {
            window.__majinBrowserWriteOrigins = [...origins];
            document.addEventListener('submit', (event) => {
              const allowed = window.__majinBrowserWriteOrigins || [];
              const action = event.submitter?.formAction || event.target.action || location.href;
              const target = new URL(action, location.href);
              if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password
                && (allowed.includes('*') || (allowed.includes(location.origin) && allowed.includes(target.origin)))) return;
              event.preventDefault();
              event.stopImmediatePropagation();
            }, true);
          }, browserWriteOrigins(ctx));
          // Stop JS-driven writes too; this workflow prepares forms but never sends them.
          await state.context.route('**/*', async (route) => {
            const method = route.request().method().toUpperCase();
            if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
              const request = route.request();
              let frameUrl = '';
              try { frameUrl = request.frame().url(); } catch { /* no trusted frame */ }
              if (browserWriteAllowed(ctx, request.url()) && browserWriteAllowed(ctx, frameUrl)) {
                await route.continue(); return;
              }
              ctx.emit?.({ type: 'browser:blocked-request', method, url: route.request().url() });
              const blockedUrl = new URL(route.request().url());
              state.blockedRequests.push({ method, origin: blockedUrl.origin, path: blockedUrl.pathname });
              state.blockedRequests = state.blockedRequests.slice(-30);
              await route.abort('blockedbyclient').catch(() => {});
              return;
            }
            await route.continue();
          });
        }
        await state.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        clearRefs(groundSession(ctx));
        await state.page.waitForTimeout(350);
        await syncBrowserWriteOrigins(state.page, ctx);
        const result = { url: state.page.url(), title: await state.page.title(), headless: state.headless, submissionsBlocked: !browserWriteAllowed(ctx, state.page.url()) };
        audit(ctx, 'open', { url: result.url, title: result.title, headless: result.headless }, state.page);
        return withOwnerHandoff(state.page, ctx, { result: `Opened ${result.url}\nTitle: ${result.title}\n${result.submissionsBlocked ? 'Form submissions and non-read HTTP requests are blocked.' : 'Owner-authorized writes are enabled for this exact origin.'}`, meta: result, summary: `opened ${new URL(result.url).host}` });
      });
    },
  }),

  def({
    name: 'browser.inspect',
    group: 'browser',
    risk: 'read',
    desc: 'Inspect the current page: title, URL, visible text, form controls (labels, selectors, selected/checked state) and the page iframes (selector + src) so frame-scoped tools can target them. Password and file values are never returned. Set marks=true to draw numbered Set-of-Marks refs on visible interactive elements and return refs such as e3 for browser.click. Pass frame (an iframe selector listed here) to inspect inside that iframe instead of the main document.',
    params: {
      maxChars: 'number: maximum page text characters (default 10000)',
      marks: 'boolean: draw numbered Set-of-Marks refs for deterministic browser.click ref calls (optional, default false)',
      frame: 'string: optional iframe selector (from this tool\'s iframes list) to inspect inside that iframe document',
    },
    async run({ maxChars = 10000, marks = false, frame = '' }, ctx) {
      return withPage(ctx, async (p) => {
        const inspectRoot = await locatorRoot(p, frame);
        const details = await inspectRoot.evaluate((limit) => {
          const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          const selectorFor = el => {
            if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
            if (el.name) {
              const candidate = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]` + (el.matches('input[type="radio"]') ? `[value="${CSS.escape(el.value)}"]` : '');
              if (document.querySelectorAll(candidate).length === 1) return candidate;
            }
            const pieces = [];
            for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
              const tag = node.tagName.toLowerCase();
              const siblings = node.parentElement ? [...node.parentElement.children].filter(sibling => sibling.tagName === node.tagName) : [node];
              pieces.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
              const candidate = pieces.join(' > ');
              if (document.querySelectorAll(candidate).length === 1) return candidate;
            }
            return pieces.join(' > ');
          };
          const controls = [...document.querySelectorAll('input,textarea,select,button,[role="radio"],[role="checkbox"]')]
            .filter(visible).slice(0, 100).map((el, i) => {
              const labels = [...(el.labels || [])].map((l) => l.innerText.trim()).filter(Boolean);
              const parentLabel = el.closest('label')?.innerText?.trim();
              const type = String(el.type || el.getAttribute('role') || el.tagName).toLowerCase();
              const item = {
                index: i,
                tag: el.tagName.toLowerCase(),
                type,
                name: el.name || '',
                id: el.id || '',
                selector: selectorFor(el),
                label: labels[0] || parentLabel || el.getAttribute('aria-label') || el.placeholder || '',
                required: Boolean(el.required || el.getAttribute('aria-required') === 'true' || /\*|\bRequired\b/i.test(labels[0] || parentLabel || '')),
                checked: 'checked' in el ? Boolean(el.checked) : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : undefined,
                disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
                inViewport: (() => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; })(),
                value: ['password', 'file'].includes(type) ? undefined : (el.value || '').slice(0, 250),
              };
              if (el.tagName === 'SELECT') item.options = [...el.options].slice(0, 50).map((o) => ({ value: o.value, label: o.label, selected: o.selected }));
              if (el.tagName === 'BUTTON') item.text = (el.innerText || '').trim().slice(0, 160);
              return item;
            });
          const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0,100).map(el => ({text:el.innerText.trim().slice(0,160),url:el.href,selector:selectorFor(el)}));
          const frames = [...document.querySelectorAll('iframe,frame')].slice(0, 20).map(el => ({ selector: selectorFor(el), src: (el.getAttribute('src') || '').slice(0, 300), name: el.name || '', id: el.id || '', title: el.title || '' }));
          return { title: document.title, text: (document.body?.innerText || '').slice(0, limit), controls, links, frames };
        }, Math.max(500, Math.min(Number(maxChars) || 10000, 24000)));
        if (stateFor(ctx).blockedRequests.length) details.text += '\nBlocked network writes (owner grant required):\n' + JSON.stringify(stateFor(ctx).blockedRequests);
        let marksText = '';
        let marksMeta = {};
        if (marks === true || String(marks) === 'true') {
          try {
            const grounded = await groundPage(p, ctx, { frameSelector: frame });
            marksText = `\n\nSet-of-Marks refs (use browser.click with ref, for example ${grounded.elements[0]?.ref || 'e1'}):\n${renderElementsText(grounded, { cap: 60 })}`;
            marksMeta = { marks: grounded.count, refs: grounded.elements.slice(0, 60).map((element) => element.ref) };
          } catch (error) {
            marksText = `\n\nSet-of-Marks unavailable: ${String(error?.message || error).slice(0, 500)}`;
            marksMeta = { marks: 0, marksError: String(error?.message || error).slice(0, 500) };
          }
        }
        audit(ctx, 'inspect', { controls: details.controls.length, frames: details.frames?.length || 0, ...(frame ? { frame } : {}), ...(marksMeta.marks != null ? { marks: marksMeta.marks } : {}) });
        const framesText = frame ? '' : `\n\nIframes (${details.frames?.length || 0}; pass frame=<selector> to browser tools to work inside one):\n${JSON.stringify(details.frames || [])}`;
        return withOwnerHandoff(p, ctx, { result: `URL: ${inspectRoot.url()}${frame ? ` (inside iframe ${frame}; page: ${p.url()})` : ''}\nTitle: ${details.title}\n\nVisible text:\n${details.text}\n\nControls (${details.controls.length}, max 100):\n${JSON.stringify(details.controls, null, 2)}\n\nLinks:\n${JSON.stringify(details.links)}${framesText}${marksText}`, meta: { url: p.url(), ...(frame ? { frame, frameUrl: inspectRoot.url() } : {}), title: details.title, controls: details.controls.length, frames: details.frames?.length || 0, ...marksMeta }, summary: `inspected ${frame ? 'iframe' : 'page'} (${details.controls.length} controls${marksMeta.marks ? `, ${marksMeta.marks} marks` : ''})` });
      });
    },
  }),

  def({
    name: 'browser.verify',
    group: 'browser',
    risk: 'read',
    desc: 'Verify a REAL post-action browser outcome on the current page: live URL (fragment, exact path, exact origin), title, unique visible element, element text, checkbox state, enabled state, or exact match count. Polls briefly for async rendering and can require the outcome to stay stable. On failure returns assertion_failed with observed evidence and a recovery hint — never calls a click successful merely because it executed. Use after click/fill when the goal requires an effect.',
    params: {
      selector: 'string: optional CSS selector to assert exists uniquely and is visible',
      present: 'boolean: optional expected presence when selector is set (default true)',
      text: 'string: optional expected text fragment within selector',
      url: 'string: optional URL fragment (loose; use urlPath+urlOrigin for security-sensitive outcomes)',
      urlPath: 'string: optional EXACT pathname such as /dashboard, unaffected by redirect query parameters',
      urlOrigin: 'string: optional EXACT origin such as https://app.example.com',
      title: 'string: optional expected title fragment',
      checked: 'boolean: optional expected checkbox/radio checked state',
      enabled: 'boolean: optional expected element enabled state (includes aria-disabled and inert)',
      count: 'number: optional exact number 0-1000 of matching elements; use for lists/cards, not with element text or checkbox expectations',
      waitMs: 'number: optional wait up to 0-5000ms for the expected DOM outcome (default 1800, immediate return on success)',
      stableMs: 'number: optional 0-1500ms the expected DOM state must stay true (default 0)',
      frame: 'string: optional iframe selector (from browser.inspect) — assertions, including URL/title, are then evaluated against that iframe document',
    },
    examples: ['browser.verify({selector:"#success",text:"Saved"})', 'browser.verify({urlPath:"/dashboard"})', 'browser.verify({selector:"input[name=consent]",checked:true})', 'browser.verify({selector:".results > li",count:10})'],
    async run(input = {}, ctx) {
      return withPage(ctx, async (p) => {
        const criteria = verificationCriteria(input);
        if (!criteria.ok) return { ok: false, error: { code: 'bad_expectation', message: criteria.reason }, summary: 'browser verify rejected the expectation' };
        const verifyRoot = await locatorRoot(p, input.frame);
        const script = VERIFY_JS.replace('__MAJIN_ARGS__', JSON.stringify(criteria));
        const waitMs = Math.min(5000, Math.max(0, Math.trunc(Number(input.waitMs ?? 1800) || 0)));
        const stableMs = Math.min(1500, Math.max(0, Math.trunc(Number(input.stableMs) || 0)));
        const deadline = Date.now() + Math.max(waitMs, stableMs);
        let verdict;
        let firstPassingAt = null;
        for (;;) {
          let observed;
          try { observed = await verifyRoot.evaluate(script); }
          catch (error) { return { ok: false, error: { code: 'browser_verify_error', message: String(error?.message || error) }, summary: 'browser verify could not observe the page' }; }
          const now = Date.now();
          verdict = verifyObserved(criteria, observed);
          if (verdict.ok) {
            if (firstPassingAt === null) firstPassingAt = now;
            if (now - firstPassingAt >= stableMs) break;
          } else firstPassingAt = null;
          if (now >= deadline) {
            if (verdict.ok && stableMs > 0) {
              verdict = { ...verdict, ok: false, failures: [{ name: 'stable_duration', expected: stableMs, actual: firstPassingAt === null ? 0 : now - firstPassingAt }] };
            }
            break;
          }
          await p.waitForTimeout(Math.min(120, Math.max(1, deadline - now)));
        }
        audit(ctx, 'verify', { ok: verdict.ok, assertions: verdict.assertions?.length || 0 });
        if (!verdict.ok) {
          const recovery = browserRecoveryAdvice(verdict, criteria, []);
          const hint = recovery.hint
            .replaceAll('browser.read or browser.elements', 'browser_inspect (marks=true)')
            .replaceAll('browser.elements', 'browser_inspect with marks=true')
            .replaceAll('browser.read', 'browser_inspect');
          const mapped = { ...recovery, hint };
          return {
            ok: false,
            error: { code: 'assertion_failed', message: `Browser outcome NOT verified. ${hint}`, failures: verdict.failures, recovery: mapped },
            meta: { assertions: verdict.assertions, observed: verdict.observed, recovery: mapped },
            summary: `verification FAILED · ${mapped.action}`,
          };
        }
        return withOwnerHandoff(p, ctx, {
          result: `Verified live browser outcome: ${verdict.assertions.map((a) => `${a.name}=${a.actual}`).join(', ')}`,
          meta: { assertions: verdict.assertions, observed: verdict.observed },
          summary: 'browser outcome VERIFIED',
        });
      });
    },
  }),

  def({
    name: 'browser.shot',
    group: 'browser',
    risk: 'read',
    desc: 'Capture a PNG screenshot of the current page into the workspace (default shots/shot-<time>.png). ifChanged=true reuses the previous file when the pixels are identical. The saved PNG is real visual evidence and can be checked with a pixel acceptance criterion.',
    params: {
      path: 'string: optional PNG path (workspace-relative or absolute inside the workspace)',
      ifChanged: 'string optional true|false (default false) to skip saving duplicate PNGs',
      fullPage: 'boolean: capture the full page instead of the viewport (default false)',
    },
    async run({ path: requestedPath = '', ifChanged = 'false', fullPage = false } = {}, ctx) {
      return withPage(ctx, async (p) => {
        const bytes = await p.screenshot({ type: 'png', fullPage: Boolean(fullPage) });
        if (!bytes?.length) throw new Error('Browser returned no screenshot image');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const sessionKey = String(ctx.session || 'default');
        const previous = recentShots.get(sessionKey);
        if (String(ifChanged) === 'true' && previous?.sha256 === sha256) {
          return { result: `Screenshot unchanged — previous file is still valid: ${previous.path}`,
            meta: { path: previous.path, sha256, bytes: bytes.length, unchanged: true },
            summary: 'screen unchanged; no duplicate file' };
        }
        const workspace = ctx.cfg?.get?.('workspace') || dirs.cache;
        const target = requestedPath
          ? (path.isAbsolute(requestedPath) ? requestedPath : path.join(workspace, requestedPath))
          : path.join(workspace, 'shots', `shot-${sessionKey.replace(/[^\w.-]/g, '_')}-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        recentShots.set(sessionKey, { path: target, sha256 });
        if (recentShots.size > 64) recentShots.delete(recentShots.keys().next().value);
        audit(ctx, 'shot', { path: target, bytes: bytes.length });
        return { result: `Saved screenshot to ${target} (${bytes.length} bytes). URL: ${p.url()}`,
          meta: { path: target, sha256, bytes: bytes.length, unchanged: false }, summary: `screenshot saved ${path.basename(target)}` };
      });
    },
  }),

  def({
    name: 'browser.click',
    group: 'browser',
    risk: 'write',
    desc: 'Click one page element selected by a Playwright CSS/text selector or by a Set-of-Marks ref from browser.inspect marks=true. Pass frame (iframe selector from browser.inspect) when the element lives inside an iframe; ground refs inside that frame first with browser.inspect frame + marks=true. By default submit buttons are refused. Owner-authorized origins permit submission; inspect the real confirmation and never repeat an uncertain submission.',
    params: {
      selector: 'string: optional Playwright locator selector, e.g. #next or text=Continue; provide exactly one of selector or ref',
      ref: 'string: optional Set-of-Marks ref such as e3 from browser.inspect; provide exactly one of selector or ref',
      index: 'number: optional 0-based match index when selector matches more than once',
      frame: 'string: optional iframe selector containing the element',
    },
    required: [],
    async run({ selector = '', ref = '', index, frame = '' } = {}, ctx) {
      return withPage(ctx, async (p) => {
        let targetSelector = String(selector || '');
        const refName = String(ref || '');
        if ((targetSelector ? 1 : 0) + (refName ? 1 : 0) !== 1) throw new Error('browser.click requires exactly one of selector or ref');
        if (refName) {
          if (index != null) throw new Error('browser.click index is only valid with selector, not ref');
          targetSelector = await resolveGroundedSelector(p, ctx, refName, frame);
        }
        const element = await safeClick(p, targetSelector, index, ctx, frame);
        audit(ctx, 'click', { selector: targetSelector, ...(refName ? { ref: refName } : {}), ...(frame ? { frame } : {}), index: index ?? 0, element });
        return withOwnerHandoff(p, ctx, { result: `Clicked ${refName || targetSelector}${element.text ? ` (${element.text})` : ''}${frame ? ` inside iframe ${frame}` : ''}. URL: ${p.url()}`, meta: { url: p.url(), selector: targetSelector, ...(refName ? { ref: refName } : {}), ...(frame ? { frame } : {}), element }, summary: `clicked ${refName || targetSelector}` });
      });
    },
  }),

  def({
    name: 'browser.fill',
    group: 'browser',
    risk: 'write',
    desc: 'Fill a text, email, number, date or textarea control by selector. Pass frame (iframe selector from browser.inspect) when the control lives inside an iframe. Values are not written to the action log. Does not submit the form.',
    params: { selector: 'string: Playwright locator selector, e.g. input[name="email"]', value: 'string: value to enter', frame: 'string: optional iframe selector containing the control' },
    required: ['selector', 'value'],
    async run({ selector, value, frame = '' }, ctx) {
      return withPage(ctx, async (p) => {
        const locator = (await locatorRoot(p, frame)).locator(selector);
        const count = await locator.count();
        if (count !== 1) throw new Error(count ? `${count} elements matched; use a unique selector` : `no element matched selector: ${selector}`);
        const field = await locator.evaluate((el) => ({
          type: String(el.getAttribute?.('type') || '').toLowerCase(),
          autocomplete: String(el.getAttribute?.('autocomplete') || '').toLowerCase(),
          name: String(el.getAttribute?.('name') || ''),
          id: String(el.getAttribute?.('id') || ''),
          label: [
            ...(el.labels ? [...el.labels].map((label) => label.innerText || '') : []),
            el.closest?.('label')?.innerText || '', el.getAttribute?.('aria-label') || '', el.getAttribute?.('placeholder') || '',
          ].join(' '),
        }));
        const sensitiveText = `${field.name} ${field.id} ${field.label}`;
        const isPassword = field.type === 'password' || ['current-password', 'new-password'].includes(field.autocomplete);
        const isOneTimeCode = field.autocomplete === 'one-time-code' || /\b(otp|one[-\s]?time(?:\s+code)?|verification\s+code|authenticator(?:\s+code)?)\b/i.test(sensitiveText);
        if (isPassword || isOneTimeCode) {
          let origin = null;
          try { origin = new URL(p.url()).origin; } catch { /* URL remains in the handoff record */ }
          throw browserHandoffError(
            'BROWSER_OWNER_HANDOFF_REQUIRED',
            `Refused to enter a ${isPassword ? 'password' : 'one-time code'} through the model/tool path. Complete it in MAJIN's browser session, then resume the saved goal. Nothing was entered or submitted.`,
            {
              kind: isPassword ? 'LOGIN' : 'MFA',
              signal: isPassword ? 'password field' : 'one-time-code field',
              url: p.url(),
              origin,
              selector,
              headless: stateFor(ctx).headless,
              visibleBrowser: !stateFor(ctx).headless,
              action: `Enter the ${isPassword ? 'password' : 'one-time code'} in MAJIN's browser session, then resume the saved goal.`,
            },
          );
        }
        await locator.fill(String(value));
        audit(ctx, 'fill', { selector, ...(frame ? { frame } : {}), valueLength: String(value).length });
        return withOwnerHandoff(p, ctx, { result: `Filled ${selector} (${String(value).length} characters)${frame ? ` inside iframe ${frame}` : ''}. Nothing was submitted.`, meta: { selector, ...(frame ? { frame } : {}), valueLength: String(value).length }, summary: `filled ${selector}` });
      });
    },
  }),

  def({
    name: 'browser.check',
    group: 'browser',
    risk: 'write',
    desc: 'Check or uncheck one checkbox/radio input by selector. For radio groups use the exact option selector; no form submission occurs. Pass frame when the input lives inside an iframe.',
    params: { selector: 'string: selector for the checkbox or radio input', checked: 'boolean: true to check, false to uncheck (default true)', frame: 'string: optional iframe selector containing the input' },
    required: ['selector'],
    async run({ selector, checked = true, frame = '' }, ctx) {
      return withPage(ctx, async (p) => {
        const locator = (await locatorRoot(p, frame)).locator(selector);
        if (await locator.count() !== 1) throw new Error(`selector must match exactly one input: ${selector}`);
        const nativeInput = await locator.evaluate((el) => el.matches('input[type="checkbox"], input[type="radio"]'));
        if (nativeInput) {
          await locator.setChecked(Boolean(checked));
        } else {
          const role = await locator.getAttribute('role');
          if (!['checkbox', 'radio'].includes(role)) throw new Error('target must be a checkbox or radio input');
          const current = (await locator.getAttribute('aria-checked')) === 'true';
          if (current !== Boolean(checked)) await locator.click();
        }
        audit(ctx, checked ? 'check' : 'uncheck', { selector });
        return withOwnerHandoff(p, ctx, { result: `${checked ? 'Checked' : 'Unchecked'} ${selector}. Nothing was submitted.`, meta: { selector, checked: Boolean(checked) }, summary: `${checked ? 'checked' : 'unchecked'} ${selector}` });
      });
    },
  }),

  def({
    name: 'browser.select',
    group: 'browser',
    risk: 'write',
    desc: 'Choose an option in a <select> element by its value. Does not submit the form. Pass frame when the select lives inside an iframe.',
    params: { selector: 'string: selector for the select element', value: 'string: option value to choose', frame: 'string: optional iframe selector containing the select' },
    required: ['selector', 'value'],
    async run({ selector, value, frame = '' }, ctx) {
      return withPage(ctx, async (p) => {
        const locator = (await locatorRoot(p, frame)).locator(selector);
        if (await locator.count() !== 1) throw new Error(`selector must match exactly one select: ${selector}`);
        await locator.selectOption(String(value));
        audit(ctx, 'select', { selector, value });
        return withOwnerHandoff(p, ctx, { result: `Selected option ${value} in ${selector}. Nothing was submitted.`, meta: { selector, value }, summary: `selected ${selector}` });
      });
    },
  }),

  def({
    name: 'browser.upload',
    group: 'browser',
    risk: 'write',
    desc: 'Attach a local file to a file input. This only selects the file in the browser; it is not uploaded until the user submits, and submission is blocked.',
    params: { selector: 'string: selector for the file input', filePath: 'string: local absolute or working-directory-relative file path' },
    required: ['selector', 'filePath'],
    async run({ selector, filePath }, ctx) {
      return withPage(ctx, async (p) => {
        const abs = path.resolve(filePath);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file does not exist: ${abs}`);
        const locator = p.locator(selector);
        if (await locator.count() !== 1) throw new Error(`selector must match exactly one file input: ${selector}`);
        await locator.setInputFiles(abs);
        audit(ctx, 'attach-file', { selector, file: path.basename(abs) });
        return withOwnerHandoff(p, ctx, { result: `Attached ${path.basename(abs)} in ${selector}. The file was not uploaded and the form was not submitted.`, meta: { selector, file: path.basename(abs) }, summary: `attached ${path.basename(abs)}` });
      });
    },
  }),

  def({
    name: 'browser.press',
    group: 'browser',
    risk: 'write',
    desc: 'Press a keyboard key on the selected element. Enter that would submit a form is intercepted; non-GET requests remain blocked.',
    params: { selector: 'string: Playwright locator selector', key: 'string: key such as Tab, Space, ArrowDown or Enter' },
    required: ['selector', 'key'],
    async run({ selector, key }, ctx) {
      return withPage(ctx, async (p) => {
        const locator = p.locator(selector);
        if (await locator.count() !== 1) throw new Error(`selector must match exactly one element: ${selector}`);
        await syncBrowserWriteOrigins(p, ctx);
        await locator.press(String(key));
        await p.waitForTimeout(150);
        audit(ctx, 'press', { selector, key });
        return withOwnerHandoff(p, ctx, { result: `Pressed ${key} on ${selector}. URL: ${p.url()}`, meta: { selector, key, url: p.url() }, summary: `pressed ${key}` });
      });
    },
  }),

  def({
    name: 'browser.download',
    group: 'browser',
    risk: 'write',
    desc: 'Click one element (selector or Set-of-Marks ref) that starts a file download and save the downloaded bytes into the workspace. Returns the saved path, byte count and sha256 so the result can be proven with a file criterion. The same submit guards as browser.click apply: ungranted final-submit controls are refused before anything is sent. If no download starts before timeoutMs, returns download_timeout instead of pretending a file arrived.',
    params: {
      selector: 'string: optional Playwright locator selector for the download link/button; provide exactly one of selector or ref',
      ref: 'string: optional Set-of-Marks ref such as e3 from browser.inspect; provide exactly one of selector or ref',
      path: 'string: optional destination path (workspace-relative or absolute inside the workspace); default downloads/<suggested filename>',
      timeoutMs: 'number: optional milliseconds to wait for the download to start, 100-60000 (default 15000)',
      frame: 'string: optional iframe selector containing the download element',
    },
    required: [],
    examples: ['browser.download({selector:"a#report",path:"downloads/report.pdf"})', 'browser.download({ref:"e4"})'],
    async run({ selector = '', ref = '', path: requestedPath = '', timeoutMs = 15000, frame = '' } = {}, ctx) {
      return withPage(ctx, async (p) => {
        const refName = String(ref || '');
        let targetSelector = String(selector || '');
        if ((targetSelector ? 1 : 0) + (refName ? 1 : 0) !== 1) throw new Error('browser.download requires exactly one of selector or ref');
        const waitMs = Math.min(60000, Math.max(100, Math.trunc(Number(timeoutMs) || 15000)));
        if (refName) targetSelector = await resolveGroundedSelector(p, ctx, refName, frame);
        const downloadPromise = p.waitForEvent('download', { timeout: waitMs });
        downloadPromise.catch(() => {}); // a refused click must not leave an unhandled rejection behind
        const element = await safeClick(p, targetSelector, undefined, ctx, frame);
        let download;
        try {
          download = await downloadPromise;
        } catch {
          return {
            ok: false,
            error: { code: 'download_timeout', message: `No download started within ${waitMs}ms after clicking ${refName || targetSelector}. Inspect the page state; the click may have navigated or opened a tab instead (browser.tabs).` },
            meta: { selector: targetSelector, ...(refName ? { ref: refName } : {}), element },
            summary: 'no download observed',
          };
        }
        const failure = await download.failure().catch(() => null);
        if (failure) {
          return {
            ok: false,
            error: { code: 'download_failed', message: `Browser download failed: ${String(failure.message || failure).slice(0, 500)}` },
            meta: { selector: targetSelector, ...(refName ? { ref: refName } : {}), element },
            summary: 'download failed',
          };
        }
        const suggested = path.basename(String(download.suggestedFilename() || 'download.bin')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download.bin';
        const workspace = ctx.cfg?.get?.('workspace') || dirs.cache;
        let target = requestedPath
          ? (path.isAbsolute(requestedPath) ? requestedPath : path.join(workspace, requestedPath))
          : path.join(workspace, 'downloads', suggested);
        if (!requestedPath && fs.existsSync(target)) {
          const ext = path.extname(suggested);
          target = path.join(path.dirname(target), `${path.basename(suggested, ext)}-${Date.now()}${ext}`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await download.saveAs(target);
        const bytes = fs.readFileSync(target);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        let source = '';
        try { const u = new URL(download.url()); source = `${u.origin}${u.pathname}`; } catch { /* suggested filename remains the evidence */ }
        audit(ctx, 'download', { selector: targetSelector, ...(refName ? { ref: refName } : {}), path: target, bytes: bytes.length });
        return {
          result: `Downloaded ${suggested} to ${target} (${bytes.length} bytes, sha256 ${sha256}).`,
          meta: { path: target, suggestedFilename: suggested, bytes: bytes.length, sha256, source, selector: targetSelector, ...(refName ? { ref: refName } : {}), element },
          summary: `downloaded ${suggested} (${bytes.length} bytes)`,
        };
      });
    },
  }),

  def({
    name: 'browser.tabs',
    group: 'browser',
    risk: 'write',
    desc: 'List, switch or close tabs in the current browser session. Links that open a new tab do not move the active page by themselves: list tabs, then switch to the index whose URL/title matches the page you need. Internal browser UI pages (edge://, chrome:// and similar, e.g. the downloads hub Edge opens after a download) are never listed. Switching clears Set-of-Marks refs (they belong to the previous page). Closing the active tab activates the last remaining tab (or a fresh blank page when none remain).',
    params: {
      action: 'string: optional action [list|switch|close] (default list)',
      index: 'number: optional 0-based tab index for switch/close',
    },
    required: [],
    examples: ['browser.tabs({})', 'browser.tabs({action:"switch",index:1})', 'browser.tabs({action:"close",index:0})'],
    async run({ action = 'list', index } = {}, ctx) {
      return withSession(ctx, async (state) => {
        if (!state.context) return { result: 'No browser session is open.', meta: { tabs: [] }, summary: 'no browser tabs' };
        const describe = async (pages) => Promise.all(pages.map(async (pg, i) => ({
          index: i,
          url: pg.url(),
          title: await pg.title().catch(() => ''),
          active: pg === state.page,
        })));
        // Internal browser UI pages (edge://downloads-hub opens by itself after
        // a download in Edge, chrome:// pages, devtools) are not agent tabs:
        // listing or switching to them would corrupt indexes and strand the
        // model on a page no tool can operate.
        const openPages = () => state.context.pages().filter((pg) => !pg.isClosed() && /^(?:https?|about|data):/i.test(pg.url() || 'about:blank'));
        const act = String(action || 'list').toLowerCase();
        if (act === 'list') {
          const tabs = await describe(openPages());
          return {
            result: `${tabs.length} tab(s) (* = active):\n${tabs.map((t) => `${t.active ? '*' : ' '} [${t.index}] ${t.title || '(no title)'} — ${t.url}`).join('\n')}`,
            meta: { tabs },
            summary: `${tabs.length} tab(s)`,
          };
        }
        if (!['switch', 'close'].includes(act)) throw new Error(`unknown tabs action: ${action} (list|switch|close)`);
        const pages = openPages();
        const idx = Number(index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) throw new Error(`tab index out of range: ${index} (${pages.length} tab(s) open)`);
        if (act === 'switch') {
          state.page = pages[idx];
          clearRefs(groundSession(ctx));
          await state.page.bringToFront().catch(() => {});
          await syncBrowserWriteOrigins(state.page, ctx);
          const tabs = await describe(openPages());
          audit(ctx, 'tab-switch', { index: idx, url: state.page.url() });
          return { result: `Switched to tab [${idx}] ${state.page.url()}`, meta: { tabs, activeIndex: idx }, summary: `switched to tab ${idx}` };
        }
        const closing = pages[idx];
        const wasActive = closing === state.page;
        const closedUrl = closing.url();
        await closing.close().catch(() => {});
        if (wasActive) {
          const remaining = openPages();
          state.page = remaining[remaining.length - 1] || await state.context.newPage();
          clearRefs(groundSession(ctx));
          await syncBrowserWriteOrigins(state.page, ctx).catch(() => {});
        }
        const tabs = await describe(openPages());
        audit(ctx, 'tab-close', { index: idx, url: closedUrl });
        return { result: `Closed tab [${idx}] ${closedUrl}. Active tab is now ${state.page?.url() || '(none)'}.`, meta: { tabs }, summary: `closed tab ${idx}` };
      });
    },
  }),

  def({
    name: 'browser.clear_marks',
    group: 'browser',
    risk: 'write',
    desc: 'Remove MAJIN Set-of-Marks overlays and data-majin-ref attributes from the current page (or from one iframe via frame) and forget the cached refs. This changes only MAJIN annotations; it does not alter site form values or send a request.',
    params: { frame: 'string: optional iframe selector whose marks should be cleared instead of the main page' },
    async run({ frame = '' } = {}, ctx) {
      return withPage(ctx, async (p) => {
        const clearRoot = await locatorRoot(p, frame);
        const before = await clearRoot.evaluate(() => ({
          marks: document.querySelectorAll('.majin-mark').length,
          refs: document.querySelectorAll('[data-majin-ref]').length,
        }));
        await clearRoot.evaluate(CLEAR_JS);
        clearRefs(groundSession(ctx));
        audit(ctx, 'clear-marks', before);
        return { result: `Cleared ${before.marks} Set-of-Marks overlay(s) and ${before.refs} element ref(s).`, meta: before, summary: 'browser marks cleared' };
      });
    },
  }),

  def({
    name: 'browser.close',
    group: 'browser',
    risk: 'read',
    desc: 'Close the current Playwright browser session. The isolated persistent profile is kept for next time.',
    params: {},
    async run(_args, ctx) {
      return withSession(ctx, async (state) => {
        if (!state.context) return { result: 'No browser session is open.', summary: 'browser already closed' };
        const oldPage = state.page;
        await state.context.close().catch(() => {});
        state.context = null;
        state.page = null;
        state.browserType = null;
        clearRefs(groundSession(ctx));
        audit(ctx, 'close', {}, oldPage);
        return { result: 'Browser session closed; the local profile was kept. No form was submitted.', summary: 'browser closed' };
      });
    },
  }),
];

export { validateUrl };
