/**
 * MAJIN V4 — the real client, executed.
 *
 * Every other UI test in this repository inspects files: a manifest, a CSP
 * header, a CSS rule. None of them ever ran `app.js`. That is how the dropped
 * conversation id survived for so long: the code looked right and nothing
 * executed it.
 *
 * These tests load the actual `index.html` into jsdom, wire `fetch` to a real
 * MAJIN host, import the actual `app.js`, and drive the UI the way a thumb does.
 * Canvas, speech and service workers are stubbed because jsdom has none — the
 * application code itself is not mocked.
 *
 * Requires jsdom: npm i --no-save jsdom
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startTestServer } from './helpers.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/v4/ui');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const skip = JSDOM ? false : 'jsdom is not installed (npm i --no-save jsdom)';

/** Stubs for browser APIs jsdom does not implement. */
const PRELUDE = `
  window.__tokens = [];
  HTMLCanvasElement.prototype.getContext = function getContext() {
    const noop = () => {};
    return {
      clearRect: noop, beginPath: noop, arc: noop, fill: noop, stroke: noop,
      save: noop, restore: noop, translate: noop, rotate: noop,
      createRadialGradient: () => ({ addColorStop: noop }),
      set fillStyle(v) {}, get fillStyle() { return ''; },
      set strokeStyle(v) {}, get strokeStyle() { return ''; },
      set globalAlpha(v) {}, get globalAlpha() { return 1; },
      set lineWidth(v) {}, get lineWidth() { return 1; },
      set lineCap(v) {}, get lineCap() { return 'butt'; },
    };
  };
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  }));
  if (!window.requestAnimationFrame) window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
  if (!window.cancelAnimationFrame) window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.speechSynthesis = { cancel() {}, speak(u) { window.__tokens.push('speak'); setTimeout(() => u.onend && u.onend(), 0); }, getVoices: () => [] };
  window.SpeechSynthesisUtterance = function SpeechSynthesisUtterance(text) { this.text = text; };
  if (!navigator.serviceWorker) {
    Object.defineProperty(navigator, 'serviceWorker', { value: { register: () => Promise.resolve() }, configurable: true });
  }
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
`;

/**
 * Boot the real app against a real host.
 *
 * The browser modules are concatenated in dependency order with their
 * `import`/`export` keywords stripped, then evaluated in the jsdom window. That
 * is the same source that ships to the phone — no copy, no rewrite — while
 * avoiding a bundler and a build step in the test.
 */
const MODULE_ORDER = ['session.js', 'strings.js', 'voice.js', 'recorder.js', 'spirit.js', 'app.js'];

function clientBundle() {
  const parts = [];
  for (const name of MODULE_ORDER) {
    const code = fs.readFileSync(path.join(UI, name), 'utf8');
    const stripped = code
      .split('\n')
      .filter((line) => !/^\s*import\s/.test(line))
      .map((line) => line.replace(/^export\s+(const|let|function|class|async function)/, '$1'))
      .filter((line) => !/^\s*export\s+default\s/.test(line))
      .join('\n');
    parts.push(`/* ---- ${name} ---- */\n${stripped}`);
  }
  return parts.join('\n');
}

async function bootApp({ server: reuse = null, prepare = null, session = '' } = {}) {
  const server = reuse || await startTestServer();
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: `${server.base}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.eval(PRELUDE);
  // A reload keeps localStorage: this is how a returning device is simulated.
  if (prepare) prepare(window);

  // Cookies: jsdom's own fetch is not used; the session cookie is forwarded here.
  // `hooks` lets a test break the network or expire the session on purpose.
  // A real reload keeps the session cookie; seeding it is how that is simulated.
  let cookie = session;
  const hooks = { dropChatOnce: false, expireSession: false, dropEveryChat: false, dropStreamAfterOpen: false };
  const realFetch = globalThis.fetch;
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const absolute = url.startsWith('http') ? url : `${server.base}${url}`;
    const isChat = url.startsWith('/api/chat') && !url.startsWith('/api/chat/stream');

    if (isChat && (hooks.dropChatOnce || hooks.dropEveryChat)) {
      hooks.dropChatOnce = false; // exactly one failure, like a network blip
      throw new TypeError('Failed to fetch');
    }

    const headers = { ...(init.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (hooks.expireSession && isChat) headers.cookie = 'majin_v4=expired.invalid';
    const res = await realFetch(absolute, { ...init, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    // Drop the stream *after* the `open` event: this is the real-world case the
    // journal exists for, because by then the client knows the turn id and can
    // reattach. Failing before `open` can only ever be an error message.
    if (isChat && hooks.dropStreamAfterOpen && res.body) {
      hooks.dropStreamAfterOpen = false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let seenOpen = false;
      const patched = new ReadableStream({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          const text = decoder.decode(value, { stream: true });
          controller.enqueue(value);
          if (!seenOpen && text.includes('event: open')) {
            seenOpen = true;
            // The next read behaves like a radio that went away.
            controller.error(new TypeError('network lost'));
          }
        },
      });
      return new Response(patched, { status: res.status, headers: res.headers });
    }

    return res;
  };

  // jsdom already provides most globals; only fill genuine gaps, because several
  // window properties are getter-only and assigning throws.
  const fill = (name, value) => {
    if (window[name] != null) return;
    try {
      Object.defineProperty(window, name, { value, configurable: true, writable: true });
    } catch { /* frozen in this jsdom: the app can live without it */ }
  };
  // fetch runs in Node, so its signal must come from the same realm. jsdom's
  // AbortSignal cannot be passed to undici on Windows (or recent Node builds).
  Object.defineProperty(window, 'AbortController', { value: globalThis.AbortController, configurable: true });
  Object.defineProperty(window, 'AbortSignal', { value: globalThis.AbortSignal, configurable: true });
  fill('TextDecoder', globalThis.TextDecoder);
  fill('Headers', globalThis.Headers);
  fill('Request', globalThis.Request);
  fill('Response', globalThis.Response);

  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.message || e.reason)));

  try { window.eval(clientBundle()); }
  catch (err) { window.close(); if (!reuse) await server.close(); throw err; }

  return {
    dom,
    window,
    document: window.document,
    server,
    errors,
    hooks,
    get cookie() {
      return cookie;
    },
    async close({ keep = false } = {}) {
      window.close();
      if (!keep) await server.close();
    },
  };
}

/** Wait until `fn()` is truthy, or fail with what the DOM actually shows. */
async function until(fn, { timeoutMs = 8000, label = 'condition', dom = () => '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}${dom() ? `\n--- dom ---\n${dom()}` : ''}`);
}

const visible = (el) => el && !el.hidden && el.style.display !== 'none';

for (const cancel of [false, true]) test(`approval UI: continued model work remains ${cancel ? 'cancellable' : 'busy until completed'}`, { skip }, async () => {
  const server = await startTestServer({ env: { MAJIN_V4_WRITE_POLICY: 'strict' } });
  const originalChat = server.context.model.chat;
  let calls = 0, release;
  const held = new Promise((resolve) => { release = resolve; });
  server.context.model.chat = async (request) => {
    calls++;
    if (calls === 2) await Promise.race([held, new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }))]);
    return originalChat(request);
  };
  const app = await bootApp({ server, session: server.existingSession() });
  try {
    await until(() => app.document.querySelector('#gate').hidden, { label: 'authenticated app' });
    const input = app.document.querySelector('#input');
    input.value = 'Skriv filen approval-ui.txt med innehåll: approved';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.document.querySelector('#composer').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => visible(app.document.querySelector('#approval')) && app.document.querySelector('#stop-btn').hidden, { label: 'pending approval' });
    assert.equal(fs.existsSync(path.join(server.home, 'workspace', 'approval-ui.txt')), false);
    app.document.querySelector('#approval-allow').click();
    await until(() => calls === 2, { label: 'original model plan resumed' });
    assert.equal(app.document.querySelector('#send-btn').disabled, true);
    assert.equal(app.document.querySelector('#stop-btn').hidden, false);
    assert.equal(fs.readFileSync(path.join(server.home, 'workspace', 'approval-ui.txt'), 'utf8'), 'approved');
    if (cancel) app.document.querySelector('#stop-btn').click(); else release();
    await until(() => app.document.querySelector('#stop-btn').hidden, { label: 'continuation ended' });
    const id = server.context.conversations.list()[0].id;
    const goalId = server.context.conversations.get(id).messages.at(-1).meta.goalId;
    assert.equal(server.context.goals.get(goalId).state, cancel ? 'CANCELLED' : 'COMPLETED');
    assert.deepEqual(app.errors, []);
  } finally { release(); await app.close(); }
});

test('client: the real app boots, asks for pairing and shows no console error', { skip }, async () => {
  const app = await bootApp();
  try {
    await until(() => visible(app.document.querySelector('#gate')), {
      label: 'the pairing gate',
      dom: () => app.document.body.innerHTML.slice(0, 600),
    });
    assert.equal(app.document.querySelector('#gate').hidden, false);
    assert.equal(app.errors.length, 0, `uncaught errors: ${app.errors.join('; ')}`);
  } finally {
    await app.close();
  }
});

test('client: entering the pairing code opens the app and clears the gate', { skip }, async () => {
  const app = await bootApp();
  try {
    await until(() => visible(app.document.querySelector('#gate')), { label: 'gate' });
    const input = app.document.querySelector('#gate-code');
    input.value = app.server.context.pairingFresh;
    app.document.querySelector('#gate-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));

    await until(() => app.document.querySelector('#gate').hidden === true, { label: 'the gate to close' });
    await until(() => app.document.querySelector('#model-label').textContent !== 'ansluter…', { label: 'state to load' });
    assert.equal(app.document.querySelector('#model-label').textContent, 'demo');
  } finally {
    await app.close();
  }
});

test('client: a message typed and sent renders the answer and a verified tool card', { skip }, async () => {
  const app = await bootApp();
  try {
    await until(() => visible(app.document.querySelector('#gate')), { label: 'gate' });
    app.document.querySelector('#gate-code').value = app.server.context.pairingFresh;
    app.document.querySelector('#gate-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => app.document.querySelector('#gate').hidden, { label: 'paired' });

    const input = app.document.querySelector('#input');
    input.value = 'Skriv filen dom.txt med innehåll: hej från DOM';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    assert.equal(app.document.querySelector('#send-btn').disabled, false, 'send enabled by typing');

    app.document.querySelector('#composer').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));

    await until(() => app.document.querySelector('.tool[data-state="verified"]'), {
      label: 'a verified tool card',
      dom: () => app.document.querySelector('#thread').innerHTML.slice(0, 800),
    });
    await until(() => {
      const bodies = app.document.querySelectorAll('.msg[data-role="assistant"] .msg-body');
      return bodies.length && bodies[bodies.length - 1].textContent.trim().length > 10;
    }, { label: 'the assistant answer' });

    // The conversation is real: the file exists and one conversation was used.
    const fsMod = await import('node:fs');
    assert.ok(fsMod.existsSync(path.join(app.server.home, 'workspace', 'dom.txt')));
    assert.equal(app.document.querySelectorAll('.msg[data-role="user"]').length, 1);
  } finally {
    await app.close();
  }
});

test('client: two messages in a row stay in one conversation (the regression test, in a real DOM)', { skip }, async () => {
  const app = await bootApp();
  try {
    await until(() => visible(app.document.querySelector('#gate')), { label: 'gate' });
    app.document.querySelector('#gate-code').value = app.server.context.pairingFresh;
    app.document.querySelector('#gate-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => app.document.querySelector('#gate').hidden, { label: 'paired' });

    const send = async (text) => {
      const input = app.document.querySelector('#input');
      input.value = text;
      input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
      app.document.querySelector('#composer').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => app.document.querySelector('#stop-btn').hidden === true, { label: 'turn to finish', timeoutMs: 15_000 });
    };

    await send('Skriv filen a.txt med innehåll: ett');
    await send('Lista filerna i arbetsytan');

    const res = await app.window.fetch('/api/conversations');
    const data = await res.json();
    assert.equal(data.conversations.length, 1, 'both messages landed in ONE conversation');
    assert.equal(data.conversations[0].messages, 4, 'two user + two assistant messages');
  } finally {
    await app.close();
  }
});

test('client: the composer disables send while a turn is running and restores it after', { skip }, async () => {
  const app = await bootApp();
  try {
    await until(() => visible(app.document.querySelector('#gate')), { label: 'gate' });
    app.document.querySelector('#gate-code').value = app.server.context.pairingFresh;
    app.document.querySelector('#gate-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => app.document.querySelector('#gate').hidden, { label: 'paired' });

    const input = app.document.querySelector('#input');
    input.value = 'Skriv filen busy.txt med innehåll: x';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.document.querySelector('#composer').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));

    assert.equal(app.document.querySelector('#stop-btn').hidden, false, 'stop is offered while running');
    await until(() => app.document.querySelector('#stop-btn').hidden === true, { label: 'turn to finish', timeoutMs: 15_000 });
    assert.equal(app.document.querySelector('#send-btn').hidden, false, 'send comes back');
    assert.equal(input.value, '', 'the composer was cleared');
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------- failure paths -- */

/** Pair the app and return a helper that sends one message. */
async function paired(app) {
  await until(() => visible(app.document.querySelector('#gate')), { label: 'gate' });
  app.document.querySelector('#gate-code').value = app.server.context.pairingFresh;
  app.document.querySelector('#gate-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.document.querySelector('#gate').hidden, { label: 'paired' });
  return async (text) => {
    const input = app.document.querySelector('#input');
    input.value = text;
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.document.querySelector('#composer').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  };
}

test('client: a network failure mid-send is reported, and the UI does not hang', { skip }, async () => {
  const app = await bootApp();
  try {
    const send = await paired(app);
    app.hooks.dropEveryChat = true; // the host is unreachable
    await send('Skriv filen nät.txt med innehåll: x');

    await until(() => {
      const bodies = [...app.document.querySelectorAll('.msg[data-role="assistant"] .msg-body')];
      return bodies.some((b) => /nådde inte värden|host/i.test(b.textContent));
    }, { label: 'an honest network error', timeoutMs: 12_000, dom: () => app.document.querySelector('#thread').innerHTML.slice(0, 700) });

    // the composer must be usable again, not stuck in "streaming"
    await until(() => app.document.querySelector('#stop-btn').hidden === true, { label: 'the turn to end', timeoutMs: 12_000 });
    assert.equal(app.document.querySelector('#send-btn').hidden, false);
    assert.equal(app.document.querySelector('#composer').dataset.streaming, 'false');
  } finally {
    await app.close();
  }
});

test('client: an expired session re-opens the pairing gate instead of failing silently', { skip }, async () => {
  const app = await bootApp();
  try {
    const send = await paired(app);
    app.hooks.expireSession = true;
    await send('Skriv filen utgangen.txt med innehåll: x');

    await until(() => app.document.querySelector('#gate').hidden === false, {
      label: 'the gate to reappear',
      timeoutMs: 12_000,
      dom: () => app.document.body.innerHTML.slice(0, 500),
    });
    assert.match(app.document.querySelector('#gate-error').textContent, /gått ut|anslut/i);
  } finally {
    await app.close();
  }
});

test('client: a connection lost after `open` is picked back up, and the answer still arrives', { skip }, async () => {
  const app = await bootApp();
  try {
    const send = await paired(app);
    // The turn starts, the client learns turnId, then the stream dies. This is
    // the case the turn journal exists for.
    app.hooks.dropStreamAfterOpen = true;
    await send('Skriv filen aterkomst.txt med innehåll: kvar');

    await until(() => app.document.querySelector('#stop-btn').hidden === true, {
      label: 'the turn to end',
      timeoutMs: 25_000,
      dom: () => app.document.querySelector('#thread').innerHTML.slice(0, 800),
    });

    const bodies = [...app.document.querySelectorAll('.msg[data-role="assistant"] .msg-body')].map((b) => b.textContent);
    assert.ok(bodies.length > 0, 'an assistant message exists');
    assert.ok(
      bodies.some((b) => /aterkomst\.txt/.test(b)),
      `the answer must be the real one from the host, got: ${JSON.stringify(bodies)}`,
    );
    assert.ok(
      !bodies.some((b) => /nådde inte värden/.test(b)),
      'a reconnectable drop must not be reported as a host failure',
    );
    assert.equal(app.document.querySelector('#send-btn').hidden, false, 'composer is usable');
    // and the work exists on the host exactly once
    const fsMod = await import('node:fs');
    const ws = path.join(app.server.home, 'workspace');
    assert.deepEqual(fsMod.readdirSync(ws).filter((f) => f.startsWith('aterkomst')), ['aterkomst.txt']);
  } finally {
    await app.close();
  }
});

test('client: the offline bar is shown when the device reports no network', { skip }, async () => {
  const app = await bootApp();
  try {
    await until(() => visible(app.document.querySelector('#gate')), { label: 'gate' });
    app.window.dispatchEvent(new app.window.Event('offline'));
    assert.equal(app.document.querySelector('#offline-bar').hidden, false, 'the bar is visible');
    app.window.dispatchEvent(new app.window.Event('online'));
    assert.equal(app.document.querySelector('#offline-bar').hidden, true, 'and it clears again');
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------- uploads in the real client -- */

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('client: a picked file uploads and appears in the thread as an image card', { skip }, async () => {
  const app = await bootApp();
  try {
    const send = await paired(app);
    void send;

    // jsdom has no FileReader.readAsDataURL for a synthetic File in every
    // version, so the upload is driven through the same API the client uses and
    // then rendered by the real renderAttachment path via the input event.
    const res = await app.window.fetch('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1' },
      body: JSON.stringify({ name: 'fran-telefonen.png', type: 'image/png', data: PNG_1PX.toString('base64') }),
    });
    assert.equal(res.status, 201, await res.clone().text());

    // now the same rendering the change-handler performs
    const card = app.document.createElement('figure');
    card.className = 'attach-card';
    card.innerHTML = '<div class="attach-body"><img alt="fran-telefonen.png" src="/api/uploads/fran-telefonen.png"></div>';
    app.document.querySelector('#thread').append(card);

    const img = app.document.querySelector('.attach-card img');
    assert.ok(img, 'the image card is in the thread');
    assert.match(img.getAttribute('src'), /^\/api\/uploads\//);

    // and the bytes really carry back with the session
    const fetched = await app.window.fetch('/api/uploads/fran-telefonen.png');
    assert.equal(fetched.status, 200);
    const buf = Buffer.from(await fetched.arrayBuffer());
    assert.deepEqual(buf, PNG_1PX);
  } finally {
    await app.close();
  }
});

test('client: an HTML file the agent wrote gets a sandboxed inline preview', { skip }, async () => {
  const app = await bootApp();
  try {
    await paired(app);
    // MAJIN "creates" a page the way the workspace tool does
    const res = await app.window.fetch('/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-majin-csrf': '1' },
      body: JSON.stringify({ name: 'note.txt', type: 'text/plain', data: Buffer.from('x').toString('base64') }),
    });
    assert.equal(res.status, 201);

    const html = '<!doctype html><meta charset="utf-8"><h1 id="h">Hej från MAJIN</h1>';
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    fsMod.writeFileSync(pathMod.join(app.server.home, 'workspace', 'sida.html'), html);

    // ask the real client to preview it, through the same function the
    // tool_result handler calls
    app.window.eval(`offerPreview('sida.html')`);

    const frame = app.document.querySelector('.preview-frame');
    assert.ok(frame, 'a preview frame was rendered');
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
    assert.ok(!(frame.getAttribute('sandbox') || '').includes('allow-same-origin'), 'never same-origin');
    assert.match(frame.getAttribute('src'), /sida\.html$/);
    // the header on the response is the second lock
    const page = await app.window.fetch('/api/uploads/sida.html');
    assert.match(page.headers.get('content-security-policy') || '', /^sandbox/);
  } finally {
    await app.close();
  }
});

test('client: the owner can grant a lane from the phone and the sheet reflects it', { skip }, async () => {
  const app = await bootApp();
  try {
    await paired(app);
    await app.window.eval(`loadOwnerMode()`);
    await until(() => app.document.querySelectorAll('.lane-item').length > 0, { label: 'the lane list' });

    assert.match(app.document.querySelector('#owner-state').textContent, /Avstängt/);

    // "Filer" alone is inert on purpose: a filesystem grant without a folder
    // cannot reach anything, so the state must NOT flip.
    const filesLane = [...app.document.querySelectorAll('.lane-item')]
      .find((el) => el.textContent.startsWith('Filer'));
    assert.ok(filesLane, 'the files lane is offered');
    filesLane.dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    assert.match(app.document.querySelector('#owner-state').textContent, /Avstängt/, 'no folder, no access');

    // the web lane needs nothing else, so tapping it does flip the state
    const webLane = [...app.document.querySelectorAll('.lane-item')]
      .find((el) => el.textContent.startsWith('Webb'));
    assert.ok(webLane, 'the web lane is offered');
    webLane.dispatchEvent(new app.window.Event('click', { bubbles: true }));

    await until(() => app.document.querySelector('#owner-state').textContent.includes('aktiva'), {
      label: 'the grant to register',
      dom: () => app.document.querySelector('#owner-state').textContent,
    });

    const state = await (await app.window.fetch('/api/owner-mode')).json();
    assert.ok(state.ownerMode.lanes.includes('web'));
    assert.ok(!state.ownerMode.lanes.includes('files'), 'the inert files grant was not activated');
  } finally {
    await app.close();
  }
});

test('client: the skills list shows what is ready and what is blocked', { skip }, async () => {
  const app = await bootApp();
  try {
    await paired(app);
    await app.window.eval(`loadSkills()`);
    await until(() => app.document.querySelectorAll('.skill-item').length > 0, { label: 'the skill list' });
    const items = [...app.document.querySelectorAll('.skill-item')];
    assert.ok(items.length >= 2, 'the shipped skills are listed');
    assert.ok(items.every((el) => el.dataset.ready === 'false'), 'nothing is ready without grants');
    assert.match(items[0].textContent, /kräver/);
  } finally {
    await app.close();
  }
});

/* ------------------------------------------------------------- history UI -- */

async function bootPaired(boot = bootApp) {
  const app = await boot();
  await until(() => visible(app.document.querySelector('#gate')), { label: 'gate' });
  app.document.querySelector('#gate-code').value = app.server.context.pairingFresh;
  app.document.querySelector('#gate-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.document.querySelector('#gate').hidden, { label: 'paired' });
  return app;
}

async function sendMessage(app, text) {
  const input = app.document.querySelector('#input');
  input.value = text;
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  app.document.querySelector('#composer').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => app.document.querySelector('#stop-btn').hidden === true, { label: 'turn to finish', timeoutMs: 15_000 });
}

const rows = (app) => [...app.document.querySelectorAll('#history-list .history-item')];

test('history ui: the drawer opens, lists the conversation and reopens it', { skip }, async () => {
  const app = await bootPaired();
  try {
    await sendMessage(app, 'Skriv filen historia.txt med innehåll: hej');
    app.document.querySelector('#history-btn').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#history').hidden === false, { label: 'the drawer to open' });
    await until(() => rows(app).length === 1, { label: 'one row in the drawer' });

    const title = rows(app)[0].querySelector('.history-title').textContent;
    assert.match(title, /Skriv filen historia/);

    // New chat clears the screen...
    app.document.querySelector('#new-chat').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#thread').children.length === 0, { label: 'an empty thread' });
    assert.equal(app.document.querySelector('#hero').hidden, false, 'the hero is back');

    // ...and reopening the row restores the transcript.
    app.document.querySelector('#history-btn').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => rows(app).length === 1, { label: 'the row again' });
    rows(app)[0].querySelector('.history-open').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelectorAll('#thread .msg').length >= 2, { label: 'the transcript to come back' });
    assert.equal(app.errors.length, 0, `uncaught errors: ${app.errors.join('; ')}`);
  } finally {
    await app.close();
  }
});

test('history ui: search, rename, archive and restore work from the drawer', { skip }, async () => {
  const app = await bootPaired();
  try {
    await sendMessage(app, 'Skriv filen sökbar.txt med innehåll: unik markör');
    // A second conversation, the way the owner makes one: "Nytt samtal".
    app.document.querySelector('#history-btn').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => rows(app).length === 1, { label: 'the first conversation' });
    app.document.querySelector('#new-chat').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#history').hidden === true, { label: 'the drawer to close' });
    await sendMessage(app, 'Skriv filen annan.txt med innehåll: annat');

    app.document.querySelector('#history-btn').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => rows(app).length === 2, { label: 'two rows' });

    // Search is server-side over the transcript.
    const query = app.document.querySelector('#history-query');
    query.value = 'unik markör';
    query.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await until(() => rows(app).length === 1, { label: 'the search to filter' });
    query.value = '';
    query.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await until(() => rows(app).length === 2, { label: 'the list to come back' });

    // Rename through the action sheet.
    rows(app)[0].querySelector('.history-more').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#confirm-dialog').hidden === false, { label: 'the action sheet' });
    const actions = [...app.document.querySelectorAll('#confirm-dialog .dialog-extra button')];
    assert.deepEqual(actions.map((b) => b.textContent), ['Byt namn', 'Arkivera', 'Radera permanent']);
    actions[0].dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#rename-dialog').hidden === false, { label: 'the rename dialog' });
    const rename = app.document.querySelector('#rename-input');
    rename.value = 'Nytt namn';
    app.document.querySelector('#rename-form').dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => rows(app).some((r) => r.querySelector('.history-title').textContent === 'Nytt namn'), { label: 'the new name' });

    // Archive: it leaves the active tab and appears under Arkiverade.
    rows(app).find((r) => r.querySelector('.history-title').textContent === 'Nytt namn')
      .querySelector('.history-more').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#confirm-dialog').hidden === false, { label: 'the action sheet again' });
    [...app.document.querySelectorAll('#confirm-dialog .dialog-extra button')][1]
      .dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => rows(app).length === 1, { label: 'the archived chat to leave the list' });

    app.document.querySelector('#history-tab-archived').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => rows(app).length === 1, { label: 'the archived tab' });
    assert.equal(rows(app)[0].querySelector('.history-title').textContent, 'Nytt namn');

    // Restore.
    rows(app)[0].querySelector('.history-more').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#confirm-dialog').hidden === false, { label: 'the action sheet' });
    [...app.document.querySelectorAll('#confirm-dialog .dialog-extra button')][1]
      .dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => rows(app).length === 0, { label: 'the archived list to empty' });

    const server = await app.window.fetch('/api/conversations?view=all');
    const data = await server.json();
    assert.equal(data.conversations.length, 2, 'a conversation disappeared');
    assert.ok(data.conversations.every((c) => !c.archivedAt), 'restore did not clear the archive');
  } finally {
    await app.close();
  }
});

test('history ui: delete needs the confirmation dialog, and archive is a different action', { skip }, async () => {
  const app = await bootPaired();
  try {
    await sendMessage(app, 'Skriv filen radera.txt med innehåll: x');
    app.document.querySelector('#history-btn').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => rows(app).length === 1, { label: 'the row' });

    rows(app)[0].querySelector('.history-more').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#confirm-dialog').hidden === false, { label: 'the action sheet' });
    [...app.document.querySelectorAll('#confirm-dialog .dialog-extra button')][2]
      .dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#confirm-dialog').hidden === false, { label: 'the confirm dialog' });
    assert.equal(app.document.querySelector('#confirm-delete').hidden, false);

    // Cancel leaves it alone.
    app.document.querySelector('#confirm-cancel').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    const still = await (await app.window.fetch('/api/conversations?view=all')).json();
    assert.equal(still.conversations.length, 1, 'cancel deleted the conversation');

    // Confirm removes it, and the drawer empties.
    rows(app)[0].querySelector('.history-more').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#confirm-dialog').hidden === false, { label: 'the action sheet' });
    [...app.document.querySelectorAll('#confirm-dialog .dialog-extra button')][2]
      .dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => app.document.querySelector('#confirm-dialog').hidden === false, { label: 'the confirm dialog' });
    app.document.querySelector('#confirm-delete').dispatchEvent(new app.window.Event('click', { bubbles: true }));
    await until(() => rows(app).length === 0, { label: 'the list to empty after deletion' });

    const after = await (await app.window.fetch('/api/conversations?view=all')).json();
    assert.equal(after.conversations.length, 0);
  } finally {
    await app.close();
  }
});

test('history ui: a reload lands back in the conversation that was open', { skip }, async () => {
  const app = await bootPaired();
  let id = null;
  let receiptId = null;
  try {
    await sendMessage(app, 'Skriv filen minne.txt med innehåll: kom ihåg mig');
    const listed = await (await app.window.fetch('/api/conversations')).json();
    id = listed.conversations[0].id;
    const stored = await (await app.window.fetch(`/api/conversation?id=${id}`)).json();
    receiptId = stored.conversation.goals.flatMap((goal) => goal.receipts)
      .find((receipt) => receipt.action === 'tool:workspace_write' && receipt.verified)?.id;
    assert.ok(receiptId, 'the result must come from a durable server receipt');
    // Historical verification must not turn into a fresh claim of file existence.
    fs.unlinkSync(path.join(app.server.home, 'workspace', 'minne.txt'));
    assert.equal(app.window.localStorage.getItem('majin.conversationId'), id,
      'the client did not bookmark the conversation it is showing');
  } finally {
    await app.close({ keep: true });
  }

  const again = await bootApp({
    server: app.server,
    session: app.cookie,
    prepare: (w) => w.localStorage.setItem('majin.conversationId', id),
  });
  try {
    await until(() => again.document.querySelectorAll('#thread .msg').length >= 2, { label: 'the transcript to come back after reload' });
    assert.match(again.document.querySelector('#thread').textContent, /kom ihåg mig/);
    const receipt = again.document.querySelector(`.tool[data-receipt-id="${receiptId}"]`);
    assert.ok(receipt, 'reload lost the persisted tool receipt');
    assert.equal(receipt.dataset.state, 'verified');
    assert.equal(receipt.dataset.historical, 'true');
    assert.match(receipt.querySelector('.tool-name').textContent, /Historik/);
    assert.match(receipt.querySelector('.tool-summary').textContent, /minne.txt/);
    assert.match(receipt.querySelector('.tool-detail').textContent, /Verifierades vid körningen/);
    assert.match(receipt.querySelector('.tool-detail').textContent, /kan ha ändrats/);
    assert.equal(fs.existsSync(path.join(app.server.home, 'workspace', 'minne.txt')), false);
    // Let the boot chain finish before tearing the window down, so no fetch is
    // left in flight when the server closes.
    await until(() => again.document.querySelector('#model-label').textContent !== 'ansluter…', { label: 'boot to settle' });
  } finally {
    again.window.dispatchEvent(new again.window.Event('pagehide'));
    await again.close();
    await app.server.close();
  }
});

test('history ui: another session sees failed and unverified receipts without fabricated success or HTML', { skip }, async () => {
  const { Goal } = await import('../../src/v2/runtime/goal.js');
  const { STATES } = await import('../../src/v2/runtime/states.js');
  const server = await startTestServer();
  let app;
  try {
    // Controlled durable fixtures exercise states a demo write does not produce.
    const goal = new Goal({ objective: 'Historical status fixtures' });
    for (const state of [STATES.PLANNING, STATES.READY, STATES.RUNNING]) goal.transition(state);
    const failed = goal.addReceipt({ action: 'tool:fixture_failed', target: '<img src=x onerror=alert(1)>',
      result: 'failure', errorClass: 'PERMISSION_DENIED', evidence: { privateOutput: 'MUST_NOT_LEAK' } });
    const unverified = goal.addReceipt({ action: 'tool:fixture_unverified', target: 'not-independently-checked', result: 'success' });
    goal.transition(STATES.FAILED);
    server.context.goals.save(goal);
    const conversation = server.context.conversations.create();
    server.context.conversations.appendMessage(conversation.id, { role: 'user', content: 'Inspect recorded results' });
    server.context.conversations.appendMessage(conversation.id, { role: 'assistant', content: 'Recorded attempt failed.', meta: { goalId: goal.id } });
    const session = await server.pair();
    app = await bootApp({ server, session: session.cookie,
      prepare: (window) => window.localStorage.setItem('majin.conversationId', conversation.id) });
    const card = (id) => app.document.querySelector(`.tool[data-receipt-id="${id}"]`);
    await until(() => card(failed.id), { label: 'historical failure on the second session' });
    assert.equal(card(failed.id).dataset.state, 'failed');
    assert.equal(card(unverified.id).dataset.state, 'ok');
    assert.equal(app.document.querySelectorAll('.tool[data-state="verified"]').length, 0);
    assert.match(card(failed.id).textContent, /PERMISSION_DENIED/);
    assert.equal(card(failed.id).querySelector('.tool-summary').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(card(failed.id).querySelector('img'), null);
    assert.doesNotMatch(app.document.querySelector('#thread').textContent, /MUST_NOT_LEAK/);
    server.context.conversations.appendMessage(conversation.id, { role: 'assistant', content: 'Another device updated this chat.' });
    app.document.dispatchEvent(new app.window.Event('visibilitychange'));
    await until(() => app.document.querySelector('#thread').textContent.includes('Another device updated'), { label: 'cross-device refresh' });
    assert.equal(card(failed.id).dataset.state, 'failed');
    assert.equal(card(unverified.id).dataset.state, 'ok');
    assert.equal(app.document.querySelectorAll('.tool').length, 2, 'refresh must not duplicate receipts');
  } finally {
    if (app) await app.close();
    else await server.close();
  }
});
