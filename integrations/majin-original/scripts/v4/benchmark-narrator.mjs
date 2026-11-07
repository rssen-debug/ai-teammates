// Opt-in local synthetic benchmark. No microphone, provider call or phone PASS.
import fs from 'node:fs';
const port = Number(process.argv[2] || 18766);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port');
const base = `http://127.0.0.1:${port}`;
const text = 'I can help you build and test a small application. First I will inspect the available tools and your working files. Then I will verify the result and report any remaining blockers.';
const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(90000) };
const health = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })).json();
const started = performance.now();
const response = await fetch(`${base}/speak-stream`, options);
if (!response.ok) throw new Error(`Stream HTTP ${response.status}`);
const decoder = new TextDecoder();
let buffer = '', firstMs = null, chunks = 0, done = false;
for await (const bytes of response.body) {
  buffer += decoder.decode(bytes, { stream: true });
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (done) throw new Error('Data after done');
    if (frame.type === 'audio') {
      if (frame.sequence !== chunks) throw new Error('Out of order');
      const wav = Buffer.from(frame.data, 'base64');
      if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV');
      firstMs ??= Math.round(performance.now() - started); chunks++;
    } else if (frame.type === 'done' && frame.chunks === chunks) done = true;
    else throw new Error('Stream failed');
  }
}
if (!done || !chunks || buffer.trim()) throw new Error('Incomplete stream');
const streamedMs = Math.round(performance.now() - started);
const fullStarted = performance.now();
const full = await fetch(`${base}/speak`, { ...options, signal: AbortSignal.timeout(90000) });
if (!full.ok) throw new Error(`WAV HTTP ${full.status}`);
const bytes = (await full.arrayBuffer()).byteLength;
const evidence = { at: new Date().toISOString(), kind: 'synthetic-loopback-tts-only', physicalDevicePass: false, health, text, firstMs, streamedMs, chunks, fullMs: Math.round(performance.now() - fullStarted), fullBytes: bytes };
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
