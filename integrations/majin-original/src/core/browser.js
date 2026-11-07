/** MAJIN — real browser-use over the Chrome DevTools Protocol.
 *
 * Design contract (DECISIONS.md): we control the browser the user already
 * HAS (Edge ships with every Windows, Chrome elsewhere) instead of shipping
 * a bundled rendering engine or a Python framework. Node ≥ 22's built-in
 * fetch + WebSocket are enough to speak CDP; everything WebSocket-shaped
 * in this module is lazily created at first real use so the module loads on
 * older runtimes too — a browser action on such a runtime gets a human
 * sentence, not a crash.
 *
 * AUTOPILOT rules baked in (master brief):
 *   - Every agent session owns its OWN browser instance with its OWN
 *     profile directory — two agents can never click in each other's tabs
 *     (test G), because they never share a surface.
 *   - Concurrent instances are capped (config browser.maxInstances, the
 *     slots are process-wide and locked); a fourth session queues instead
 *     of spawning a splash of windows.
 *   - Loop guard: the same action signature three times in a row with the
 *     same outcome = we are stuck; the tool throws an honest error rather
 *     than clicking itself into seventy identical failures.
 *   - Evidence before confidence: every action tool answers with the page's
 *     own words (element text, value that stuck, URL the click produced),
 *     never a bare "done".
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dirs } from './paths.js';
import { fileLocks } from './tasks.js';

/* ------------------------------ loop guard ------------------------------ */

export class LoopJournal {
  constructor({ window = 8 } = {}) {
    this.window = window;
    this.bySession = new Map();
  }

  /** A signature is (tool, target, args). Throws LoopStuckError after three
      identical consecutive actions with the same outcome — deterministic,
      zero-LLM stuck-loop detection. */
  guard(session, signature, outcome = '') {
    const k = String(session || 'default');
    const list = this.bySession.get(k) || [];
    const last3 = list.slice(-2);
    if (last3.length === 2 && last3.every((e) => e.sig === signature && e.outcome === outcome)) {
      throw new Error(
        `browser loop detected: "${signature}" already ran 3 times in a row with the same result — change the approach (new selector, new step, or ask the user) instead of clicking it a fourth time`,
      );
    }
    list.push({ sig: signature, outcome, at: Date.now() });
    if (list.length > this.window) list.splice(0, list.length - this.window);
    this.bySession.set(k, list);
  }

  acts(session) {
    return [...(this.bySession.get(String(session || 'default')) || [])];
  }
}

export const journal = new LoopJournal();

/* --------------------------- browser discovery --------------------------- */

/** Candidate executables per platform, in sanity order. Kept as data so a
    test can read the table without touching the filesystem. */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const pf = env['ProgramFiles'] || 'C:\\Program Files';
    const pfx = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || 'C:\\Users\\user\\AppData\\Local';
    return [
      `${pfx}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx}\\Google\\Chrome\\Application\\chrome.exe`,
      `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/chromium'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'];
}

export function findBrowser(candidates = browserCandidates()) {
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/* ------------------------------ slot pool -------------------------------- */

/** maxInstances concurrent browsers, process-wide. Slots are fileLocks on
    `browser:slot:N` — a waiting agent waits for a SLOT to free, never for
    every other task (same semantics as file conflicts). */
export function createBrowserPool({ locks = fileLocks, max = 3 } = {}) {
  const held = new Map(); // session → { slot, release }
  return {
    async claim(session, { timeoutMs = 0 } = {}) {
      const k = String(session || 'default');
      if (held.has(k)) return held.get(k).slot;
      for (let n = 1; n <= max; n += 1) {
        try {
          const release = await locks.acquire(`browser:slot:${n}`, k, { timeoutMs });
          const rec = { slot: n, release };
          held.set(k, rec);
          return n;
        } catch {
          /* slot busy — try the next */
        }
      }
      throw new Error(`all ${max} browser instances are busy — finish or close one of the running browser tasks and try again`);
    },
    release(session) {
      const rec = held.get(String(session || 'default'));
      if (rec) {
        rec.release();
        held.delete(String(session || 'default'));
      }
      return Boolean(rec);
    },
    slotOf(session) {
      return held.get(String(session || 'default'))?.slot || null;
    },
    count: () => held.size,
    max: () => max,
  };
}

/* ------------------------------ CDP client ------------------------------- */

const RPC_TIMEOUT_MS = 20000;

async function wsConnect(wsUrl, factory, signal = null) {
  signal?.throwIfAborted();
  const make = factory || ((u) => new globalThis.WebSocket(u));
  if (typeof make !== 'function' || (factory == null && typeof globalThis.WebSocket !== 'function')) {
    throw new Error('this runtime has no built-in WebSocket (needs node ≥22 — the packaged MAJIN exe already has one)');
  }
  const ws = make(wsUrl);
  await new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error) => {
      if(finished)return;
      finished=true;
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      if(error) { try { ws.close(); } catch {} reject(error); } else resolve();
    };
    const onAbort = () => finish(signal.reason || new Error('browser connection cancelled'));
    const t = setTimeout(() => finish(new Error('browser debug port never answered (10 s)')), 10000);
    ws.onopen = () => finish();
    ws.onerror = () => finish(new Error('could not open the browser debug connection'));
    signal?.addEventListener('abort', onAbort, {once:true});
    if(signal?.aborted)onAbort();
  });
  return ws;
}

export function cdpRpc(ws) {
  let id = 0;
  const waiting = new Map();
  const disconnected = () => {
    for (const request of [...waiting.values()]) request.reject(new Error('browser debug connection closed'));
  };
  ws.onclose = disconnected;
  ws.onerror = disconnected;
  ws.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(typeof msg.data === 'string' ? msg.data : String(msg.data));
    } catch {
      return;
    }
    const w = waiting.get(ev.id);
    if (w) {
      waiting.delete(ev.id);
      if (ev.error) w.reject(new Error(ev.error.message || 'CDP error'));
      else w.resolve(ev.result || {});
    }
  };
  return (method, params = {}, { timeoutMs = RPC_TIMEOUT_MS, sessionId = null, signal = null } = {}) => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      if(signal?.aborted) { reject(signal.reason || new Error('browser operation cancelled')); return; }
      const finish = (error, value) => {
        waiting.delete(requestId);
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        if(error) reject(error); else resolve(value);
      };
      const onAbort = () => finish(signal.reason || new Error('browser operation cancelled'));
      const t = setTimeout(() => {
        finish(new Error(`CDP timeout after ${timeoutMs}ms on ${method}`));
      }, timeoutMs);
      waiting.set(requestId, {
        resolve: (v) => finish(null,v),
        reject: (e) => finish(e),
      });
      signal?.addEventListener('abort',onAbort,{once:true});
      try { ws.send(JSON.stringify(sessionId ? { id:requestId, method, params, sessionId } : { id:requestId, method, params })); }
      catch(error) { finish(error); }
    });
  };
}

/* --------------------------- browser session ----------------------------- */

const sess = new Map(); // sessionId (agent session) → live browser, own window + own profile
const launches = new Map(); // single-flight per session: concurrent calls share one startup
const failedLaunches = new Map(); // short circuit breaker: stop Chrome spawn storms
const BROWSER_START_COOLDOWN_MS = 60_000;
export function browserLaunchState(session) {
  const key = String(session || 'default');
  return { active: sess.has(key), launching: launches.has(key),
    retryAfterMs: Math.max(0, (failedLaunches.get(key) || 0) - Date.now()) };
}

function profileFor(session) {
  return path.join(dirs.cache, 'browser-' + String(session).replace(/[^\w.-]/g, '_'));
}

async function httpJson(url, { timeoutMs = 5000, signal = null } = {}) {
  const r = await fetch(url, { signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}



// Browser-owned sign-in/sync pages may appear after startup. A new page alone
// is not evidence that the user's click opened it: require the current opener.
export function isChildTarget(target, browser, beforeTargets = null) {
  const before = beforeTargets instanceof Set ? beforeTargets : new Set(beforeTargets || []);
  const openedDuringAction = beforeTargets != null && !before.has(target.targetId);
  return target.type === 'page' && target.url !== 'about:blank'
    && target.targetId !== browser.targetId && !target.attached
    && !browser.knownTabs.has(target.targetId)
    && (target.openerId === browser.targetId || openedDuringAction);
}

export async function waitForNavigation(navigation, read, { attempts = 150, delayMs = 100, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), signal = null } = {}) {
  if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
  if (navigation.isDownload) throw new Error('The URL started a download instead of opening a page');
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    try {
      const document = await read();
      if ((!navigation.loaderId || document.loaderId === navigation.loaderId) && ['interactive', 'complete'].includes(document.readyState)) return document;
    } catch { signal?.throwIfAborted(); /* execution contexts can disappear while a document commits */ }
    await wait(delayMs);
  }
  throw new Error('Navigation did not produce a ready document before the timeout');
}

/** Launch (or reuse) the browser for ONE agent session and navigate it. */
export async function openFor({ session, url = null, headless = true, cfgGet = null, pool = null, exe = null, wsFactory = null, signal = null } = {}) {
  session = String(session || 'default');
  const pending = launches.get(session);
  if (pending) {
    const browser = await pending;
    if (url && url !== 'about:blank' && await browser.eval('location.href', { signal }) !== String(url))
      await browser.goto(url, { signal });
    return browser;
  }
  const delay = (failedLaunches.get(session) || 0) - Date.now();
  if (delay > 0 && !sess.has(session))
    throw new Error('Chrome startup failed recently; retry in ' + Math.ceil(delay / 1000)
      + ' seconds. MAJIN will not spawn more Chrome windows during the cooldown.');
  const launching = (async () => {
    try {
      const browser = await openForOnce({ session, url, headless, cfgGet, pool, exe, wsFactory, signal });
      failedLaunches.delete(session);
      return browser;
    } catch (error) {
      if (!signal?.aborted) failedLaunches.set(session, Date.now() + BROWSER_START_COOLDOWN_MS);
      throw error;
    }
  })();
  launches.set(session, launching);
  try { return await launching; }
  finally { if (launches.get(session) === launching) launches.delete(session); }
}

async function openForOnce({ session, url = null, headless = true, cfgGet = null, pool = null, exe = null, wsFactory = null, signal = null } = {}) {
  signal?.throwIfAborted();
  session = String(session || 'default');
  const existing = sess.get(session);
  if (existing) {
    // Reuse the live tab, including a partially completed application form.
    // Reopening an identical URL destroys field contents and causes repeated
    // loading spinners on client-rendered sites such as Teamtailor.
    try {
      const current = await existing.eval('location.href', { signal });
      if (url && url !== 'about:blank' && current !== String(url)) {
        await existing.goto(url, { signal });
      }
      return existing;
    } catch (error) {
      signal?.throwIfAborted();
      // Chrome may have been closed manually; never keep an unusable CDP
      // handle in the pool. A new browser is legitimate only after this.
      try { await existing.close?.(); } catch { /* already closed */ }
      sess.delete(session);
    }
  }
  const thePool = pool || createBrowserPool({ max: Number(cfgGet?.('browser.maxInstances')) || 3 });
  const slot = await thePool.claim(session);
  let proc = null, ws = null, cdp = null;
  const onAbort = () => {
    const disconnect = () => { try { ws?.close(); } catch { /* already closed */ } };
    if(cdp) cdp('Browser.close',{}, {timeoutMs:500}).catch(()=>{}).finally(disconnect);
    else disconnect();
    try { proc?.kill(); } catch { /* already exited */ }
  };
  signal?.addEventListener('abort',onAbort,{once:true});
  try {
  signal?.throwIfAborted();
  // If the preferred browser is blocked by policy, try a DISTINCT installed
  // browser (Edge vs Chrome) once. Never retry the same visible executable
  // repeatedly: this caused the reported blank-tab storms.
  const candidates = exe ? [exe] : browserCandidates().filter(candidate => fs.existsSync(candidate));
  // Different install locations of msedge.exe are not separate fallbacks.
  const families = new Set();
  const binaries = candidates.filter(candidate => {
    const family = path.basename(candidate).toLowerCase();
    if (families.has(family)) return false;
    families.add(family);
    return true;
  });
  const bin = binaries[0] || null;
  if (!bin) {
    thePool.release(session);
    throw new Error('found no Chrome or Edge on this machine — install one of them and MAJIN can drive it');
  }
  // Every fresh launch needs an exclusive profile. Reusing a stale directory
  // owned by a zombie Chrome triggers Windows single-instance handoff instead
  // of starting a new CDP port. In-memory sessions still reuse their tab.
  fs.mkdirSync(dirs.cache, { recursive: true });
  let profile = fs.mkdtempSync(path.join(dirs.cache, 'browser-run-'));
  let version = null;
  let lastErr = null;
  /* Del 5ABE flake-hardening (CI evidence: runs 39261715303 + 39265517682):
     the Windows runner's policy gate sometimes swallows the FIRST spawned
     Edge for ~10 s — one shot of luck was the difference between green and a
     red suite. Bounded retry: attempt 1 as before, attempt 2 with a fresh
     random port + longer deadline. Honest: the final error text is unchanged. */
  // A visible Chrome launch with an already-running user-data-dir can hand
  // the command to that process and exit. Retrying spawns blank tabs in the
  // existing window instead of creating a CDP endpoint. Only headless CI
  // launches may take the second bounded startup attempt.
  const maxLaunchAttempts = binaries.length > 1 ? 2 : headless === false ? 1 : 2;
  for (let attempt = 1; attempt <= maxLaunchAttempts && !version; attempt++) {
    signal?.throwIfAborted();
    if (proc && !proc.killed) { try { proc.kill(); } catch { /* gone */ } }
    if (attempt > 1) {
      // Never attach a second browser binary to the prior process's profile.
      profile = fs.mkdtempSync(path.join(dirs.cache, 'browser-run-'));
    }
    const port = randomPort();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    ];
    if (headless !== false) args.push('--headless=new');
    // Never pass about:blank as a launch URL. With a locked/active Chrome
    // profile Windows forwards that argument to the existing instance,
    // creating one extra blank tab on EVERY failed attempt.
    const launchBin = binaries[Math.min(attempt - 1, binaries.length - 1)];
    proc = spawn(launchBin, args, { detached: false, stdio: 'ignore' });
    let spawnError = null;
    proc.once('error',error=>{spawnError=error;});
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (attempt === 1 ? 10000 : 15000);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if(spawnError)throw spawnError;
      // Existing Chrome may accept the launch request and immediately exit
      // the child (single-instance handoff). Do not launch again against the
      // same profile; the original instance is not ours to kill.
      if (proc.exitCode !== null || proc.signalCode !== null) {
        // A real process failure is evidence to try the OTHER browser, not
        // evidence that the user needs to open Chrome or enter CLI flags.
        if (attempt < maxLaunchAttempts) break;
        throw new Error('Chrome/Edge exited before CDP was available; both available launch strategies failed.');
      }
      try {
        version = await httpJson(`${base}/json/version`, { timeoutMs: 1200, signal });
        break;
      } catch (e2) {
        signal?.throwIfAborted();
        lastErr = e2;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (version?.webSocketDebuggerUrl) break;
    version = null;
    if (attempt < maxLaunchAttempts) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!version || !version.webSocketDebuggerUrl) {
    try { if (proc && !proc.killed) proc.kill(); } catch { /* gone */ }
    thePool.release(session);
    throw new Error('the browser debug port never came up — the browser may be blocked by a policy on this machine');
  }
    signal?.throwIfAborted();
    ws = await wsConnect(version.webSocketDebuggerUrl, wsFactory, signal);
  cdp = cdpRpc(ws);
  const sendRaw = ({ sessionId = null, method, params = {} }, opts = null) =>
    cdp(method, params, { sessionId, ...(opts || {}) });

  /* flat-mode attach: protocol messages carry the sessionId on the same
     websocket — the modern CDP layout, no nested sendMessageToTarget */
  // Edge starts with an empty tab. Reuse it instead of creating a second
  // about:blank tab/window. A fallback target is needed for locked-down
  // policies and mocked browsers without an initial page.
  const { targetInfos: initialTabs = [] } = await cdp('Target.getTargets');
  // Reuse an existing populated page in this agent-owned profile first.
  const existingPage = initialTabs.find(t => t.type === 'page' && t.url && t.url !== 'about:blank' && !t.attached);
  const startupTab = initialTabs.find(t => t.type === 'page' && t.url === 'about:blank' && !t.attached);
  const targetId = existingPage?.targetId || startupTab?.targetId ||
    (await cdp('Target.createTarget', { url: 'about:blank' })).targetId;
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  // Keep the original tab IDs pinned so followNewTarget never switches back
  // to an unrelated stale page after clicks.
  const { targetInfos: bornTabs = [] } = await cdp('Target.getTargets');
  const close = () => {
    if (b.closed) return b.closed;
    thePool.release(session);
    sess.delete(session);
    // Edge may relaunch itself on Windows, leaving the spawned PID already
    // exited. Close the browser over its own CDP connection before killing
    // the original process; otherwise a headless profile keeps running.
    b.closed = (async () => {
      try { await cdp('Browser.close', {}, { timeoutMs: 3000 }); } catch { /* already gone */ }
      try { ws.close(); } catch { /* gone */ }
      try { if (!proc.killed) proc.kill(); } catch { /* gone */ }
      // Best effort, after owned process has exited. Never delete a live or
      // unrelated Chrome profile just to make cleanup appear successful.
      try {
        if (proc.exitCode !== null || proc.signalCode !== null)
          fs.rmSync(profile, { recursive: true, force: true });
      } catch { /* Windows may still hold files */ }
    })();
    return b.closed;
  };
  const b = { session, sessionId, targetId, headless: headless !== false, debuggerUrl: version.webSocketDebuggerUrl, send: null, goto: null, eval: null, close, proc, slot, knownTabs: new Set(bornTabs.map((t) => t.targetId)) };
  /* send reads b.sessionId EVERY call — smarttab can re-wire it later */
  const send = (method, params = {}, opts = null) => sendRaw({ sessionId: b.sessionId, method, params }, opts);
  b.send = send;
  b.goto = async (u, {signal: navigationSignal = null} = {}) => {
    navigationSignal?.throwIfAborted();
    await send('Page.enable', {}, {signal:navigationSignal});
    const navigation = await send('Page.navigate', { url: u }, {signal:navigationSignal});
    // readyState from the previous about:blank is not navigation evidence.
    // CDP's loaderId identifies the document committed by this navigation.
    return waitForNavigation(navigation, async () => {
      const { frameTree } = await send('Page.getFrameTree', {}, {signal:navigationSignal});
      const meta = await b.eval('(() => ({ readyState: document.readyState, url: location.href, title: document.title }))()', {signal:navigationSignal});
      return { ...meta, loaderId: frameTree.frame.loaderId };
    }, {signal:navigationSignal});
  };
  b.eval = async (expression, {signal: evaluationSignal = null} = {}) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, {signal:evaluationSignal});
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.text || 'evaluate threw'));
    return r.result ? r.result.value : undefined;
  };
  b.snapshotTargets = async () => {
    const { targetInfos = [] } = await cdp('Target.getTargets');
    return new Set(targetInfos.map((target) => target.targetId));
  };
  // Attaching without a URL must not erase an in-progress application.
  if (url && url !== 'about:blank') {
    const currentUrl = await b.eval('location.href', {signal}).catch(() => null);
    if (currentUrl !== String(url)) await b.goto(url, {signal});
  }
  signal?.throwIfAborted();
  sess.set(session, b);
  // Chrome may restore surplus blank tabs in MAJIN's dedicated profile.
  // Never close populated pages, or the active target.
  try {
    const { targetInfos: tabs = [] } = await cdp('Target.getTargets');
    for (const tab of tabs) {
      if (tab.type !== 'page' || tab.targetId === b.targetId || tab.url !== 'about:blank') continue;
      await cdp('Target.closeTarget', { targetId: tab.targetId }, { timeoutMs: 1500 });
    }
  } catch { /* best-effort cleanup */ }

  /* smarttab: a click that opens a NEW page target must not strand the agent
     in the old, empty tab. 1.5 s window to catch the spawn, then re-attach. */
  b.followNewTarget = async ({ windowMs = 1500, beforeTargets = null } = {}) => {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      const { targetInfos = [] } = await cdp('Target.getTargets');
      const mine = targetInfos.find((t) => t.targetId === b.targetId);
      /* A new nonblank tab from this opener, or created since the click snapshot.
         Edge may omit openerId for target=_blank links (implicit noopener). */
      const spawnTarget = targetInfos.find((t) => isChildTarget(t, b, beforeTargets));
      if (spawnTarget) {
        const { sessionId: s2 } = await cdp('Target.attachToTarget', { targetId: spawnTarget.targetId, flatten: true });
        b.sessionId = s2;
        b.targetId = spawnTarget.targetId;
        b.knownTabs.add(spawnTarget.targetId);
        const meta = await b.eval('(() => ({ url: location.href, title: document.title }))()');
        await new Promise((r) => setTimeout(r, 300));
        return { followed: true, ...meta };
      }
      if (!mine) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { followed: false };
  };
    return b;
  } catch (e) {
    /* safety net: a browser exists by now — never leak the process/ws/slot,
       whatever broke between spawn and a working session */
    try { if (cdp) await cdp('Browser.close', {}, { timeoutMs: 3000 }); } catch { /* gone */ }
    try { ws?.close(); } catch { /* gone */ }
    try { if (proc && !proc.killed) proc.kill(); } catch { /* gone */ }
    thePool.release(session);
    sess.delete(session);
    try {
      if (proc?.exitCode !== null || proc?.signalCode !== null)
        fs.rmSync(profile, { recursive: true, force: true });
    } catch { /* Windows process still owns files */ }
    throw e;
  } finally { signal?.removeEventListener('abort',onAbort); }
}

const randomPort = () => 49152 + Math.floor(Math.random() * 12000);

export function isOpen(session) {
  return sess.has(String(session || 'default'));
}

/** Close this task's browser (if any) and hand its slot back to the fleet. */
export function closeFor(session, { wait = false, headlessOnly = false } = {}) {
  const b = sess.get(String(session || 'default'));
  if (!b) return wait ? Promise.resolve(false) : false;
  if (headlessOnly && b.headless === false) return wait ? Promise.resolve(false) : false;
  let closing;
  try { closing = b.close?.(); } catch { /* gone */ }
  return wait ? Promise.resolve(closing).then(() => true) : true;
}

/** tests + diagnostics only */
export function _resetBrowser() {
  for (const b of sess.values()) { try { b.close?.(); } catch { /* gone */ } }
  sess.clear();
  launches.clear();
  failedLaunches.clear();
  journal.bySession.clear();
}
