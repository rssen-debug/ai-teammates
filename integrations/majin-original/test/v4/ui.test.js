import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startTestServer } from './helpers.mjs';
import {
  detectVoiceSupport,
  recognitionLang,
  shouldAutoSend,
  speechText,
  voiceErrorMessage,
} from '../../src/v4/ui/voice.js';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/v4/ui');

function pngSize(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.slice(1, 4).toString('ascii'), 'PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('layout: one centred content column for topbar, hero, transcript and composer', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.match(css, /--content-w:\s*820px/, 'the shared column width is not declared');
  for (const selector of ['.topbar', '.stage', '.composer']) {
    const block = new RegExp(`\\${selector} \\{[^}]*\\}`).exec(css)?.[0] || '';
    assert.match(block, /max-width:\s*var\(--content-w\)/, `${selector} does not use the shared column`);
    assert.match(block, /margin-inline:\s*auto/, `${selector} is not centred`);
  }
  // The old 900px/780px mix is what made the composer and the transcript sit on
  // different axes on a desktop monitor.
  assert.ok(!/max-width:\s*900px/.test(css), 'a second, wider column came back');
  assert.ok(!/max-width:\s*780px/.test(css), 'the transcript uses a narrower column than the composer');
  // The spirit is centred inside the hero.
  const hero = (/\n\.hero \{[^}]*\}/.exec(css)?.[0] || '');
  assert.match(hero, /align-items:\s*center/);
  assert.match(hero, /justify-content:\s*center/);
});

test('layout: the history drawer is closed by default and never a permanent sidebar', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  const drawer = /<aside class="history"[^>]*>/.exec(html)?.[0] || '';
  assert.match(drawer, /\bhidden\b/, 'the drawer is visible before the user opens it');
  assert.match(html, /id="history-btn"/);
  assert.match(html, /id="history-close"/);
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  // The base rule (not the >=720px override) decides the overlay behaviour.
  const block = (/\n\.history \{[^}]*\}/.exec(css)?.[0] || '');
  assert.match(block, /position:\s*fixed/, 'the drawer must overlay, not resize the transcript');
  assert.ok(css.includes('width: min(86vw, 380px)'), 'the phone drawer width is missing');
  // Swipe gestures are bound, from the edge only.
  const js = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  assert.match(js, /touchstart/);
  assert.match(js, /edge:/);
  assert.match(js, /openHistory\(\)/);
});

test('layout: a fixed height floor is not used, so iOS keyboard and desktop agree', () => {
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.ok(!/height:\s*100vh\b/.test(css), '100vh is broken under the iOS keyboard');
  assert.match(css, /100dvh/);
  assert.match(css, /env\(safe-area-inset-bottom/);
});

test('model selector explains an unavailable active choice without silently switching providers', () => {
  const js = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const strings = fs.readFileSync(path.join(UI, 'strings.js'), 'utf8');
  assert.match(js, /else if \(active\)[\s\S]{0,250}model\.selectionUnavailable/);
  assert.match(js, /model\.error\.unavailable/);
  assert.match(strings, /Ingen modellförfrågan skickades och ingen annan modell valdes/);
  assert.match(strings, /Öppna modellväljaren/);
});

test('pwa: manifest is valid and installable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(UI, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.short_name, 'MAJIN');
  assert.ok(manifest.name.length > 3);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'));
  assert.ok(sizes.includes('512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
});

test('pwa: every declared icon exists with the declared pixel size', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(UI, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) {
    const file = path.join(UI, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), icon.src);
    const { width, height } = pngSize(file);
    assert.equal(`${width}x${height}`, icon.sizes);
  }
});

test('pwa: the service worker never touches API traffic', () => {
  const sw = fs.readFileSync(path.join(UI, 'sw.js'), 'utf8');
  assert.ok(sw.includes("url.pathname.startsWith('/api/')"));
  assert.ok(sw.includes('if (request.method !== \'GET\') return;'));
  assert.ok(!/caches\.put\([^)]*api/.test(sw));
});

test('mobile: viewport, safe areas and keyboard support are declared', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /theme-color/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /rel="manifest"/);
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /orientation: landscape/);
  assert.match(css, /min-width: 720px/);
});

test('accessibility: primary controls have labels, live regions and 42px targets', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.match(html, /id="mic-btn" aria-label="Tala"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /role="status"/);
  assert.match(html, /id="input"[^>]*enterkeyhint="send"/);
  assert.match(html, /id="attach-btn" aria-label="Bifoga fil"/);
  assert.match(html, /id="file-input"[^>]*accept=/);
  assert.match(html, /class="preview-frame" sandbox="allow-scripts"/);
  assert.ok(!/sandbox="[^"]*allow-same-origin/.test(html), 'a previewed page must never share the app origin');
  const css = fs.readFileSync(path.join(UI, 'app.css'), 'utf8');
  assert.match(css, /\.mic, \.send, \.stop \{[^}]*width: 42px/);
  assert.match(css, /:focus-visible/);
});

test('security: the UI ships no inline script and no secrets', () => {
  const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*src=)/i.test(html), 'no inline <script>');
  assert.ok(!/on(click|load|error)=/i.test(html), 'no inline handlers');
  for (const f of ['app.js', 'spirit.js', 'voice.js', 'sw.js', 'strings.js', 'session.js']) {
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    assert.ok(!/sk-[a-zA-Z0-9]{16,}/.test(src), `${f} has no key`);
    assert.ok(!/ghp_[a-zA-Z0-9]{20,}/.test(src), `${f} has no token`);
  }
});

test('ui: every asset is served with the right content type', async () => {
  const s = await startTestServer();
  try {
    const expected = {
      '/': 'text/html',
      '/app.css': 'text/css',
      '/app.js': 'text/javascript',
      '/spirit.js': 'text/javascript',
      '/voice.js': 'text/javascript',
      '/strings.js': 'text/javascript',
      '/session.js': 'text/javascript',
      '/manifest.webmanifest': 'application/manifest+json',
      '/sw.js': 'text/javascript',
      '/icons/icon-192.png': 'image/png',
      '/icons/icon-512.png': 'image/png',
      '/icons/maskable-512.png': 'image/png',
    };
    for (const [route, type] of Object.entries(expected)) {
      const res = await fetch(`${s.base}${route}`);
      assert.equal(res.status, 200, route);
      assert.ok((res.headers.get('content-type') || '').startsWith(type), `${route}: ${res.headers.get('content-type')}`);
    }
  } finally {
    await s.close();
  }
});

test('voice: capability detection is honest on every browser shape', () => {
  assert.deepEqual(detectVoiceSupport({}), { recognition: false, synthesis: false, mode: 'text-only', continuous: false, bargeIn: false });
  const withRec = detectVoiceSupport({ SpeechRecognition: class {} });
  assert.equal(withRec.mode, 'tap-to-talk');
  assert.equal(withRec.continuous, false, 'never claim always-listening');
  assert.equal(withRec.bargeIn, false, 'never claim server-side barge-in');
  const webkit = detectVoiceSupport({ webkitSpeechRecognition: class {}, speechSynthesis: {}, SpeechSynthesisUtterance: class {} });
  assert.equal(webkit.recognition, true);
  assert.equal(webkit.synthesis, true);
});

test('voice: language follows the device with a Swedish default', () => {
  assert.equal(recognitionLang('sv-SE'), 'sv-SE');
  assert.equal(recognitionLang('en-GB'), 'en-US');
  assert.equal(recognitionLang('de-DE'), 'sv-SE');
  assert.equal(recognitionLang(''), 'sv-SE');
  assert.equal(recognitionLang(undefined), 'sv-SE');
});

test('voice: permission errors are explained, not swallowed', () => {
  assert.match(voiceErrorMessage('not-allowed'), /blockerad/);
  assert.match(voiceErrorMessage('service-not-allowed'), /blockerad/);
  assert.match(voiceErrorMessage('no-speech'), /hörde inget/);
  assert.match(voiceErrorMessage('audio-capture'), /mikrofon/i);
  assert.match(voiceErrorMessage('network'), /nätverk/);
  assert.equal(voiceErrorMessage('aborted'), '');
});

test('voice: auto-send only on a final transcript outside an active turn', () => {
  assert.equal(shouldAutoSend({ finalTranscript: 'hej', autosend: true, streaming: false }), true);
  assert.equal(shouldAutoSend({ finalTranscript: '', autosend: true, streaming: false }), false);
  assert.equal(shouldAutoSend({ finalTranscript: 'hej', autosend: false, streaming: false }), false);
  assert.equal(shouldAutoSend({ finalTranscript: 'hej', autosend: true, streaming: true }), false);
});

test('voice: speech text is stripped of markup and bounded', () => {
  assert.equal(speechText('**Klart** `nu`'), 'Klart nu');
  assert.equal(speechText('   '), '');
  assert.equal(speechText('a'.repeat(2000)).length, 1200);
});
