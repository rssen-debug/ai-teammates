#!/usr/bin/env node
/** Existing V2 command lane -> existing loopback Kokoro narrator / warm STT. */
import fs from 'node:fs';
const [mode, target, ...words] = process.argv.slice(2);
if (!['stt', 'tts'].includes(mode) || !target) throw new Error('Expected stt <audio> or tts <output.wav> <text>');
const body = mode === 'stt' ? { data: fs.readFileSync(target).toString('base64') } : { text: words.join(' ').slice(0, 700) };
const response = await fetch(`http://127.0.0.1:18765/${mode === 'stt' ? 'transcribe' : 'speak'}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
});
if (!response.ok) throw new Error(`Local voice ${mode} failed (${response.status})`);
if (mode === 'stt') process.stdout.write(JSON.stringify(await response.json()));
else {
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.subarray(0, 4).toString() !== 'RIFF' || audio.length < 45) throw new Error('Narrator returned no valid WAV');
  fs.writeFileSync(target, audio, { mode: 0o600, flag: 'wx' });
}
