import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { computeDotMatrixState, formatXpTicker, TOTAL_SKILL_DOTS } from '../../src/v5/ui/dot-matrix.js';
import { bootV5App } from '../../src/v5/ui/app.js';
import { createV5Server } from '../../src/v5/server.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'majin-v5-ui-'));
}

/** Zero-dependency DOM harness built from `src/v5/ui/index.html` for deterministic UI testing. */
function createHtmlDom(htmlSource) {
  const byId = new Map();
  const docListeners = new Map();

  function makeElement(tagName, id = '', attrs = {}) {
    const listeners = new Map();
    const el = {
      tagName: tagName.toUpperCase(),
      id,
      className: attrs.class || '',
      hidden: Boolean(attrs.hidden),
      disabled: Boolean(attrs.disabled),
      value: '',
      textContent: '',
      dataset: {},
      children: [],
      attributes: new Map(Object.entries(attrs)),
      set innerHTML(val) {
        if (val === '') this.children = [];
      },
      get innerHTML() {
        return '';
      },
      setAttribute(k, v) {
        this.attributes.set(k, String(v));
      },
      getAttribute(k) {
        return this.attributes.get(k) ?? null;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(event) {
        const fns = listeners.get(event.type) || [];
        for (const fn of fns) fn(event);
      },
      click() {
        this.dispatchEvent({ type: 'click', preventDefault() {} });
      },
      getContext() {
        return {
          clearRect() {},
          createRadialGradient() {
            return { addColorStop() {} };
          },
          beginPath() {},
          arc() {},
          fill() {},
          stroke() {},
          save() {},
          restore() {},
        };
      },
    };
    if (id) byId.set(id, el);
    return el;
  }

  // Extract all elements with id="..." from index.html
  const tagRe = /<([a-z0-9]+)\b([^>]*?\bid="([^"]+)"[^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(htmlSource)) !== null) {
    const [, tag, rawAttrs, id] = m;
    const attrs = {};
    if (/\bhidden\b/i.test(rawAttrs)) attrs.hidden = true;
    if (/\bdisabled\b/i.test(rawAttrs)) attrs.disabled = true;
    const srcMatch = rawAttrs.match(/\bsrc="([^"]+)"/i);
    if (srcMatch) attrs.src = srcMatch[1];
    makeElement(tag, id, attrs);
  }

  const body = makeElement('body', 'body');
  return {
    body,
    getElementById(id) {
      return byId.get(id) || null;
    },
    createElement(tag) {
      return makeElement(tag);
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    dispatchKeydown(key) {
      const fns = docListeners.get('keydown') || [];
      for (const fn of fns) fn({ key });
    },
  };
}

test('99-dot matrix state & Black Box UI DOM: 99 segments, "Formulär 18/99 · +24 XP", closed skill tree by default, activity vs learning separation', () => {
  // 1. Verify pure 99-dot matrix calculation at Level 1, 18, and 99
  const s18 = computeDotMatrixState({
    skillId: 'browser.forms',
    displayName: 'Formulär', // input vocabulary, never rendered
    level: 18,
    xp: 3660,
    lastXpGain: 24,
    freshness: 'FRESH',
    maturityStatus: 'VERIFIED',
  });
  assert.equal(s18.totalDots, 99);
  assert.equal(s18.greenDotsCount, 18);
  assert.equal(s18.unfilledDotsCount, 81);
  assert.equal(s18.cohesiveMastery99, false);
  assert.equal(s18.tickerText, 'Formulär 18/99 · +24 XP'); // input vocabulary, never rendered

  const s99 = computeDotMatrixState({
    skillId: 'browser.forms',
    displayName: 'Formulär', // input vocabulary, never rendered
    level: 99,
    xp: 13_034_431,
    lastXpGain: 60,
    freshness: 'FRESH',
    maturityStatus: 'MASTERED',
  });
  assert.equal(s99.greenDotsCount, 99);
  assert.equal(s99.cohesiveMastery99, true);
  assert.match(s99.statusTextLabel, /MASTERED \(99\/99\)/);

  // 2. Boot Black Box HTML in deterministic DOM harness
  const html = fs.readFileSync(path.resolve('src/v5/ui/index.html'), 'utf8');
  const document = createHtmlDom(html);
  const app = bootV5App(document, null);

  // Verify Majin logo is present and skill tree is CLOSED by default (`hidden`)
  const logoImg = document.getElementById('majin-logo-img');
  assert.equal(logoImg.getAttribute('src'), '/logo.png');

  const skillTreeDrawer = document.getElementById('skill-tree-drawer');
  assert.equal(skillTreeDrawer.hidden, true, 'Skill tree must be closed by default');

  // Verify 99 DOM dot segments rendered for untrained initial state
  const dotStrip = document.getElementById('dot-segments');
  assert.equal(dotStrip.children.length, TOTAL_SKILL_DOTS);
  const filledCells = dotStrip.children.filter((c) => c.dataset.filled === 'true');
  assert.equal(filledCells.length, 1);

  const tickerEl = document.getElementById('xp-ticker');
  assert.equal(tickerEl.textContent, formatXpTicker({ displayName: 'Skills', level: 1, xpGain: 0 }));

  // Verify clicking logo opens Skill Tree and Escape closes it
  document.getElementById('majin-logo-trigger').click();
  assert.equal(skillTreeDrawer.hidden, false);
  document.dispatchKeydown('Escape');
  assert.equal(skillTreeDrawer.hidden, true);

  // Verify working activity is visually distinct from verified learning
  app.setActivityStatus('working', 'Läser CV', { verifiedLearning: false }); // input vocabulary, never rendered
  assert.equal(document.body.dataset.activity, 'working');
  assert.equal(document.body.dataset.learning, 'none');
  assert.equal(app.getDotState().learningVerifiedSignal, false, 'Working animation must never pretend to be verified learning');
  app.setActivityStatus('idle', 'Redo för ditt mål', { verifiedLearning: false }); // input vocabulary, never rendered
});

test('V5 HTTP Server serves Black Box UI, /logo.png, provider config, goal execution, and mobile-to-Windows host remote control', async () => {
  const dir = tmpDir();
  const srv = createV5Server({ dataDir: dir, host: '127.0.0.1', port: 0 });
  const { url } = await srv.start();

  try {
    // 1. UI and Majin logo
    const uiRes = await fetch(`${url}/`);
    assert.equal(uiRes.status, 200);
    const uiHtml = await uiRes.text();
    assert.match(uiHtml, /MAJIN V5/);

    const logoRes = await fetch(`${url}/logo.png`);
    assert.equal(logoRes.status, 200);
    assert.equal(logoRes.headers.get('content-type'), 'image/png');

    // 2. State endpoint
    const stateRes = await fetch(`${url}/api/v5/state`);
    assert.equal(stateRes.status, 200);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.ok, true);
    assert.equal(stateJson.versionInfo.version, '5.0.0');
    assert.ok(stateJson.skills.length >= 6);

    // 3. Mobile pairing & remote goal execution on the host machine
    const pairingCode = srv.getPairingCode();
    const badPair = await fetch(`${url}/api/v5/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000', deviceName: 'iPhone' }),
    });
    assert.equal(badPair.status, 403);

    const goodPair = await fetch(`${url}/api/v5/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, deviceName: 'iPhone 17 Pro' }),
    });
    assert.equal(goodPair.status, 200);
    const pairData = await goodPair.json();
    assert.ok(pairData.token);

    // Execute a goal remotely from the paired mobile client on the host
    const remoteRes = await fetch(`${url}/api/v5/remote/goal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${pairData.token}`,
      },
      body: JSON.stringify({
        goalText: 'Skapa och verifiera fil på värddatorn', // input vocabulary, never rendered
        actions: [
          {
            id: 'remote-write-1',
            tool: 'workspace_write',
            args: { file: 'from-mobile.txt', content: 'Executed on host via paired mobile client' },
          },
        ],
      }),
    });
    assert.equal(remoteRes.status, 200);
    const remoteData = await remoteRes.json();
    assert.equal(remoteData.executedOnHost, true);
    assert.equal(remoteData.goal.status, 'COMPLETED');
    assert.equal(
      fs.existsSync(path.join(srv.architect.workspaceDir, 'from-mobile.txt')),
      true,
      'Mobile remote command must actually execute on the host workspace',
    );
  } finally {
    await srv.stop();
  }
});

test('JSDOM browser execution & bin/majin-v5.mjs CLI entrypoint work end-to-end', async (t) => {
  // 1. JSDOM real W3C DOM test of src/v5/ui/index.html + bootV5App
  const html = fs.readFileSync(path.resolve('src/v5/ui/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4555/' });
  const doc = dom.window.document;
  // Stub canvas 2D context for JSDOM
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    clearRect() {},
    createRadialGradient() {
      return { addColorStop() {} };
    },
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
  });

  const app = bootV5App(doc, null);
  assert.equal(doc.getElementById('skill-tree-drawer').hidden, true);
  assert.equal(doc.getElementById('dot-segments').children.length, 99);
  doc.getElementById('majin-logo-trigger').click();
  assert.equal(doc.getElementById('skill-tree-drawer').hidden, false);
  app.applySkillMatrixState({
    skillId: 'career.form-fill',
    displayName: 'Formulär', // input vocabulary, never rendered
    level: 99,
    xp: 13_034_431,
    lastXpGain: 60,
    maturityStatus: 'MASTERED',
  });
  assert.equal(app.getDotState().cohesiveMastery99, true);

  // 2. CLI `bin/majin-v5.mjs --version` and `serve --port 0`
  const cliPath = path.resolve('bin/majin-v5.mjs');
  const ver = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
  assert.equal(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /^majin-v5 5\.0\.0/);

  const dataDir = tmpDir();
  const child = spawn(
    process.execPath,
    [cliPath, 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', dataDir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const boundUrl = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for majin-v5 CLI: ${out}`)), 8000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const res = await fetch(`${boundUrl}/api/v5/state`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.versionInfo.version, '5.0.0');
});

