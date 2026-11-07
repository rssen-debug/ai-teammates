#!/usr/bin/env node
/**
 * MAJIN V4 — local voice fixture.
 *
 * A real executable used to prove the V2 command providers end to end without a
 * cloud engine: it is spawned as a child process by `safe-exec` (no shell), must
 * pass the preflight gate, and its output is verified by the V2 file verifier.
 *
 *   node voice-fixture.mjs tts <out.wav> <text>
 *   node voice-fixture.mjs stt <in.wav>
 *
 * TTS writes a 22.05 kHz mono WAV whose length grows with the text, so a test can
 * assert the audio corresponds to what was asked for. It is a tone, not speech:
 * the fixture proves the pipeline, never the voice.
 * STT prints the transcript recorded in the WAV's LIST/INFO comment chunk, or an
 * empty line when there is none — so an empty transcript stays an honest
 * "inconclusive" instead of a fabricated sentence.
 */
import fs from 'node:fs';

const [mode, target, ...rest] = process.argv.slice(2);

function writeWav(file, seconds, sampleRate = 22_050) {
  const samples = Math.max(1, Math.floor(seconds * sampleRate));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    // two soft tones, amplitude follows an envelope so it is audible and bounded
    const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 8);
    const value = Math.sin(2 * Math.PI * 220 * t) * 0.2 + Math.sin(2 * Math.PI * 330 * t) * 0.12;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * env)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

function readComment(file) {
  const buf = fs.readFileSync(file);
  // Our own marker: a trailing "MAJINSTT:<text>" ASCII trailer after the data chunk.
  const marker = Buffer.from('MAJINSTT:');
  const idx = buf.lastIndexOf(marker);
  if (idx < 0) return '';
  return buf.subarray(idx + marker.length).toString('utf8').trim();
}

if (mode === 'tts') {
  const words = String(rest.join(' ') || '').trim();
  if (!target) {
    process.stderr.write('tts requires an output path\n');
    process.exit(2);
  }
  const seconds = Math.min(6, Math.max(0.2, words.split(/\s+/).filter(Boolean).length * 0.18));
  writeWav(target, seconds);
  process.stdout.write(`${target}\n`);
  process.exit(0);
}

if (mode === 'stt' || mode === 'stt-json') {
  if (!target || !fs.existsSync(target)) {
    process.stderr.write('stt requires an existing wav path\n');
    process.exit(2);
  }
  const transcript = readComment(target);
  process.stdout.write(mode === 'stt-json' ? JSON.stringify({ transcript, language: 'en' }) : `${transcript}\n`);
  process.exit(0);
}

process.stderr.write('usage: voice-fixture.mjs tts <out.wav> <text> | stt <in.wav>\n');
process.exit(2);
