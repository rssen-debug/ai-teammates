import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer } from './helpers.mjs';

for (const engine of (process.env.MAJIN_TOUCH_WEBKIT === '1' ? ['chromium', 'webkit'] : ['chromium'])) {
  test(`voice capture ${engine}: real container encoding, VAD interruption and microphone cleanup`, async (t) => {
    const playwright = await import('playwright');
    let browser;
    try { browser = await playwright[engine].launch(engine === 'chromium' && process.env.MAJIN_E2E_CHROMIUM ? { executablePath: process.env.MAJIN_E2E_CHROMIUM } : {}); }
    catch (err) { if (engine === 'webkit' || process.env.MAJIN_E2E_CHROMIUM) throw err; t.skip('Chromium unavailable'); return; }
    const server = await startTestServer();
    t.after(async () => { await browser.close(); await server.close(); });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const { cookie } = await server.pair(); const eq = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: server.base }]);
    const page = await context.newPage();
    await page.goto(server.base);
    await page.waitForFunction(() => document.querySelector('#gate').hidden);
    await page.locator('#input').tap();
    // Use WebAudio as the source, then the browser's REAL MediaRecorder encoder.
    // This verifies AAC/MP4 compatibility, not a physical iPhone microphone.
    const result = await page.evaluate(async () => {
      const { VoiceCapture } = await import('/recorder.js');
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context || !window.MediaRecorder) return { unsupported: true, audioContext: Boolean(Context), mediaRecorder: Boolean(window.MediaRecorder) };
      const source = new Context(); await source.resume();
      const oscillator = source.createOscillator(); const gain = source.createGain();
      const destination = source.createMediaStreamDestination();
      gain.gain.value = 0; oscillator.connect(gain).connect(destination); oscillator.start();
      let interrupted = 0; const states = []; const errors = [];
      const mediaDevices = { getUserMedia: async () => destination.stream };
      const scope = { AudioContext: Context, MediaRecorder, Blob, navigator: { mediaDevices }, setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window) };
      let complete;
      const done = new Promise((resolve) => { complete = resolve; });
      const capture = new VoiceCapture({ scope, onState: (s) => states.push(s), onSpeech: () => interrupted++, onError: (e) => errors.push(e.message),
        onSegment: async (blob) => {
          const bytes = [...new Uint8Array(await blob.arrayBuffer())];
          const type = blob.type; capture.stop(); complete({ bytes, type });
        },
      });
      await capture.start();
      gain.gain.value = 0.2;
      const onsetDeadline = Date.now() + 10000;
      while (!interrupted && Date.now() < onsetDeadline) await new Promise((r) => setTimeout(r, 50));
      gain.gain.value = 0;
      const timeout = setTimeout(() => { capture.stop(); complete({ timeout: true }); }, 6000);
      const encoded = await done; clearTimeout(timeout);
      oscillator.stop(); await source.close();
      return { ...encoded, interrupted, states, errors, active: capture.active, timer: capture.timer, track: destination.stream.getTracks()[0].readyState };
    });
    if (result.unsupported) { t.skip(`This ${engine} build lacks media APIs: ${JSON.stringify(result)}; physical Safari acceptance remains required`); return; }
    assert.equal(result.timeout, undefined, JSON.stringify(result));
    assert.deepEqual(result.errors, []);
    assert.equal(result.interrupted, 1);
    assert.equal(result.active, false); assert.equal(result.timer, null); assert.equal(result.track, 'ended');
    assert.ok(result.bytes.length > 200);
    if (engine === 'webkit') {
      assert.match(result.type, /audio\/mp4/);
      assert.equal(Buffer.from(result.bytes).subarray(4, 8).toString(), 'ftyp');
    }
    if (process.env.MAJIN_VOICE_EVIDENCE) {
      fs.mkdirSync(process.env.MAJIN_VOICE_EVIDENCE, { recursive: true });
      const { bytes, ...evidence } = result;
      fs.writeFileSync(path.join(process.env.MAJIN_VOICE_EVIDENCE, `${engine}-voice.json`), JSON.stringify({ ...evidence, encodedBytes: bytes.length, physicalDevice: false, source: 'WebAudio oscillator', at: new Date().toISOString() }, null, 2));
      fs.writeFileSync(path.join(process.env.MAJIN_VOICE_EVIDENCE, `${engine}-capture.${result.type.includes('mp4') ? 'm4a' : 'webm'}`), Buffer.from(bytes));
    }
  });
}

test('iOS client: uses capture instead of Siri, sends transcript, interrupts synthesis and releases mic on background', async (t) => {
  const { chromium } = await import('playwright');
  let browser;
  try { browser = await chromium.launch(process.env.MAJIN_E2E_CHROMIUM ? { executablePath: process.env.MAJIN_E2E_CHROMIUM } : {}); }
  catch (err) { if (process.env.MAJIN_E2E_CHROMIUM) throw err; t.skip('Chromium unavailable'); return; }
  const server = await startTestServer();
  t.after(async () => { await browser.close(); await server.close(); });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 Version/18.4 Mobile/15E148 Safari/604.1' });
  const { cookie } = await server.pair(); const eq = cookie.indexOf('=');
  await context.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: server.base }]);
  const page = await context.newPage();
  let uploads = 0;
  let sentAsVoice = false;
  page.on('request', (request) => { if (request.url().endsWith('/api/chat') && request.method() === 'POST') sentAsVoice = request.postDataJSON().voiceTurn === true; });
  let narratorCalls = 0;
  await page.route('**/api/voice', (route) => route.fulfill({ json: { serverSide: { tts: [{ mode: 'command', available: true }] } } }));
  await page.route('**/api/voice/speak', (route) => {
    narratorCalls++;
    assert.equal(route.request().postDataJSON().mode, 'command');
    return route.fulfill({ body: Buffer.alloc(64), contentType: 'audio/wav' });
  });
  await page.route('**/api/voice/transcribe', async (route) => {
    uploads++; const body = route.request().postDataJSON();
    assert.match(body.type, /^audio\//); assert.ok(Buffer.from(body.data, 'base64').length > 200);
    await route.fulfill({ json: { ok: true, transcript: 'Skriv filen ios-voice.txt med innehåll: voice capture works', synthetic: true } });
  });
  await page.addInitScript(() => {
    window.__cancelledSpeech = 0; window.__captureCalls = 0; window.__narratorStarts = 0;
    window.Audio = class {
      constructor() { this.paused = true; window.__narrator = this; }
      play() { this.paused = false; if (this.src?.startsWith('blob:')) window.__narratorStarts++; return Promise.resolve(); }
      pause() { this.paused = true; }
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speaking: false, cancel() { this.speaking = false; window.__cancelledSpeech++; },
      speak(utterance) { if (utterance.text) this.speaking = true; }, getVoices() { return []; },
    } });
    window.SpeechRecognition = class { start() { throw new Error('Siri must not be used on iOS'); } };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      window.__captureCalls++;
      const audio = new AudioContext(); await audio.resume();
      const osc = audio.createOscillator(); const gain = audio.createGain();
      const destination = audio.createMediaStreamDestination();
      gain.gain.value = 0; osc.connect(gain).connect(destination); osc.start();
      window.__micSource = { audio, osc, gain, destination };
      return destination.stream;
    } });
  });
  await page.goto(server.base);
  await page.waitForFunction(() => document.querySelector('#gate').hidden);
  await page.locator('#mic-btn').tap();
  await page.waitForFunction(() => window.__captureCalls === 1 && document.querySelector('#mic-btn').getAttribute('aria-pressed') === 'true');
  await page.evaluate(() => { speechSynthesis.speaking = true; window.__beforeSpeech = window.__cancelledSpeech; window.__micSource.gain.gain.value = 0.2; });
  await page.waitForFunction(() => window.__cancelledSpeech > window.__beforeSpeech);
  await page.evaluate(() => { window.__micSource.gain.gain.value = 0; });
  await page.waitForFunction(() => document.querySelector('.tool[data-state="verified"]'));
  assert.equal(fs.readFileSync(path.join(server.home, 'workspace/ios-voice.txt'), 'utf8'), 'voice capture works');
  assert.equal(uploads, 1);
  assert.equal(sentAsVoice, true, 'spoken input requests concise same-language replies');
  await page.waitForFunction(() => window.__narratorStarts === 1);
  assert.equal(narratorCalls, 1, 'configured host voice is requested instead of the browser default');
  await page.evaluate(() => { window.__micSource.gain.gain.value = 0.2; });
  await page.waitForFunction(() => window.__narrator.paused, { timeout: 10000 });
  await page.evaluate(() => { window.__micSource.gain.gain.value = 0; });
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => window.__micSource.destination.stream.getTracks().every((track) => track.readyState === 'ended'));
  assert.equal(await page.locator('#mic-btn').getAttribute('aria-pressed'), 'false');
  await page.evaluate(async () => { window.__micSource.osc.stop(); await window.__micSource.audio.close(); });
});
