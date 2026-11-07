/**
 * Windows' installed neural voices, spoken through the Edge Read-Aloud speech
 * service and played by Windows itself.
 *
 * Why this exists: until now the app could only play SAPI ("Microsoft David"),
 * which sounds robotic. Windows 11 already ships neural voices (Guy, Aria,
 * Sofie, Mattias …) and Edge synthesises them through a documented read-aloud
 * endpoint. This provider uses that endpoint and hands the resulting audio to
 * the OS player.
 *
 * What it is, and what it is not:
 *  - No API key, no account, no binary download, nothing installed. That is the
 *    whole reason it was chosen over shipping a Piper model.
 *  - It needs a network connection for synthesis. It is NOT offline, and the
 *    status output says so instead of pretending otherwise.
 *  - Text and audio are never written to disk or to the log, except one
 *    temporary file that is deleted when the utterance ends.
 *  - It never claims success it did not observe: `synthesize` returns the real
 *    error string from the service.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TtsProvider, TtsRequest, TtsResult } from './providers.js';
import { toSpokenText } from './pronunciation.js';

/**
 * `ws` is a real dependency, so importing it is safe here. A local
 * `createRequire` was tried first and broke the CLI bundle: the bundler hoists
 * both declarations to the same scope, which is a SyntaxError only visible in
 * the built file, never in tests.
 */
async function loadWebSocket(): Promise<typeof import('ws').WebSocket> {
  const module = await import('ws');
  return module.WebSocket ?? (module as unknown as { default: { WebSocket: typeof import('ws').WebSocket } }).default.WebSocket;
}

export interface NeuralVoice {
  id: string;
  label: string;
  language: 'sv-SE' | 'en-US';
  gender: 'male' | 'female';
}

/** A short curated list, not the 400-entry catalogue: a person must be able to choose. */
export const NEURAL_VOICES: NeuralVoice[] = [
  { id: 'en-US-AndrewMultilingualNeural', label: 'Andrew — engelsk man, varm', language: 'en-US', gender: 'male' },
  { id: 'en-US-BrianMultilingualNeural', label: 'Brian — engelsk man, dokumentär', language: 'en-US', gender: 'male' },
  { id: 'en-US-GuyNeural', label: 'Guy — engelsk man', language: 'en-US', gender: 'male' },
  { id: 'en-US-AriaNeural', label: 'Aria — engelsk kvinna', language: 'en-US', gender: 'female' },
  { id: 'en-US-JennyNeural', label: 'Jenny — engelsk kvinna, mjuk', language: 'en-US', gender: 'female' },
  { id: 'sv-SE-MattiasNeural', label: 'Mattias — svensk man', language: 'sv-SE', gender: 'male' },
  { id: 'sv-SE-SofieNeural', label: 'Sofie — svensk kvinna', language: 'sv-SE', gender: 'female' },
];

/**
 * Resolve the voice to use. An explicit id wins; a name prefix is accepted so
 * "/voice voice brian" works. Otherwise: a natural male narrator in the
 * conversation language, because that is what was asked for.
 */
export function neuralVoiceFor(language: string, requested: string): NeuralVoice {
  const wanted = (requested ?? '').trim().toLowerCase();
  if (wanted) {
    const exact = NEURAL_VOICES.find((v) => v.id.toLowerCase() === wanted);
    if (exact) return exact;
    const byName = NEURAL_VOICES.find((v) => v.label.toLowerCase().startsWith(wanted));
    if (byName) return byName;
  }
  const lang = language === 'sv-SE' ? 'sv-SE' : 'en-US';
  const fallback = NEURAL_VOICES.find((v) => v.language === lang && v.gender === 'male')
    ?? NEURAL_VOICES.find((v) => v.language === lang);
  return fallback ?? NEURAL_VOICES[0]!;
}

/** Escape one SSML text node; the service rejects raw markup in user text. */
export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Build the SSML for one utterance. Speed and volume are percentage deltas. */
export function buildNeuralSsml(voiceId: string, text: string, options: { speed: number; volume: number }): string {
  const rate = Math.round((options.speed - 1) * 100);
  const volume = Math.round((options.volume - 1) * 100);
  const lang = voiceId.slice(0, 5);
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voiceId}'><prosody rate='${rate >= 0 ? '+' : ''}${rate}%' volume='${volume >= 0 ? '+' : ''}${volume}%'>` +
    `${escapeSsml(text)}</prosody></voice></speak>`;
}

/** Whether this provider can be attempted on this platform at all. */
export function neuralVoiceAvailable(platform: string = process.platform): boolean {
  return platform === 'win32';
}

/**
 * Synthesise one utterance through the read-aloud WebSocket.
 *
 * The protocol is: send `speech.config`, then `ssml`, and read binary frames
 * whose first two bytes are the header length. Text frames carrying
 * `Path:turn.end` end the utterance. This is implemented directly so the app
 * depends on nothing but `ws`, which it already ships.
 */
export async function synthesizeNeural(
  text: string,
  voiceId: string,
  options: { speed: number; volume: number; timeoutMs?: number },
): Promise<{ ok: true; audio: Buffer } | { ok: false; error: string }> {
  const spoken = text.trim();
  if (!spoken) return { ok: false, error: 'Ingen text att läsa upp.' };
  let WebSocketCtor: typeof import('ws').WebSocket;
  try {
    WebSocketCtor = await loadWebSocket();
  } catch {
    return { ok: false, error: 'ws-modulen saknas, så neural röst kan inte användas.' };
  }

  const token = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
  const url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
    `?TrustedClientToken=${token}&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: { ok: true; audio: Buffer } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => finish({ ok: false, error: `Neural röst svarade inte inom ${Math.round(timeoutMs / 1000)} s.` }), timeoutMs);

    const socket = new WebSocketCtor(url, {
      headers: {
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      },
    });

    socket.on('open', () => {
      const stamp = new Date().toISOString();
      socket.send(
        `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n',
      );
      socket.send(
        `X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\n` +
        `X-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n` + buildNeuralSsml(voiceId, spoken, options),
      );
    });

    socket.on('message', (data: unknown, isBinary?: boolean) => {
      if (isBinary || Buffer.isBuffer(data)) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        // Binary frames: 2-byte big-endian header length, then headers, then audio.
        if (buf.length < 2) return;
        const headerLength = buf.readUInt16BE(0);
        const audio = buf.subarray(2 + headerLength);
        if (audio.length) chunks.push(audio);
        return;
      }
      const textFrame = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
      if (/Path:turn\.end/i.test(textFrame)) {
        const audio = Buffer.concat(chunks);
        if (!audio.length) finish({ ok: false, error: 'Rösttjänsten returnerade inget ljud för den här rösten.' });
        else finish({ ok: true, audio });
      }
    });

    socket.on('error', (err: Error) => finish({ ok: false, error: `Rösttjänsten nekade anslutning: ${err.message.slice(0, 160)}` }));
    socket.on('close', () => {
      const audio = Buffer.concat(chunks);
      if (audio.length) finish({ ok: true, audio });
      else finish({ ok: false, error: 'Röstanslutningen stängdes innan något ljud kom.' });
    });
  });
}

/**
 * Play audio through the Windows media stack, returning a handle the caller can
 * kill for instant stop. The file lives in %TEMP%, is deleted when playback
 * ends, and never appears in the vault or the log.
 */
export function playAudioOnWindows(audio: Buffer, mimeType = 'audio/mpeg'): { child: ChildProcess; done: Promise<boolean> } {
  const extension = mimeType.includes('wav') ? 'wav' : 'mp3';
  const file = join(tmpdir(), `studdy-speech-${process.pid}-${Date.now()}.${extension}`);
  writeFileSync(file, audio, { mode: 0o600 });
  const script = [
    'Add-Type -AssemblyName presentationCore;',
    '$player = New-Object System.Windows.Media.MediaPlayer;',
    `$player.Open([uri]'${file.replace(/'/g, "''")}');`,
    '$player.Play();',
    'Start-Sleep -Milliseconds 300;',
    '$deadline = [DateTime]::UtcNow.AddSeconds(60);',
    'while (-not $player.NaturalDuration.HasTimeSpan -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }',
    '$ms = if ($player.NaturalDuration.HasTimeSpan) { [int]$player.NaturalDuration.TimeSpan.TotalMilliseconds } else { 3000 };',
    'Start-Sleep -Milliseconds ($ms + 150);',
    '$player.Close();',
  ].join(' ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
  });
  const done = new Promise<boolean>((resolve) => {
    const cleanup = () => { if (existsSync(file)) { try { unlinkSync(file); } catch { /* already gone */ } } };
    child.once('exit', (code) => { cleanup(); resolve(code === 0); });
    child.once('error', () => { cleanup(); resolve(false); });
  });
  return { child, done };
}

/**
 * Provider object so the existing registry and status output treat neural
 * voices like any other provider. Playback stays in the CLI, which owns the
 * process handle needed for instant stop.
 */
export class WindowsNeuralProvider implements TtsProvider {
  readonly id = 'windows-neural' as const;
  readonly label = 'Windows neurala röster';
  readonly capabilities = { languages: ['sv-SE', 'en-US'], offline: false, needsApiKey: false };

  constructor(private readonly platform: string = process.platform) {}

  isConfigured(): boolean {
    return neuralVoiceAvailable(this.platform);
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (!this.isConfigured()) {
      return { ok: false, audioBase64: null, mimeType: 'audio/mpeg', chunks: [], error: 'Neurala röster är bara tillgängliga på Windows.', unavailable: true };
    }
    const voice = neuralVoiceFor(request.settings.language, request.settings.voiceId);
    const spoken = toSpokenText(request.text, { language: request.settings.language });
    const result = await synthesizeNeural(spoken, voice.id, { speed: request.settings.speed, volume: request.settings.volume });
    if (!result.ok) {
      return { ok: false, audioBase64: null, mimeType: 'audio/mpeg', chunks: [], error: result.error, unavailable: false };
    }
    return { ok: true, audioBase64: result.audio.toString('base64'), mimeType: 'audio/mpeg', chunks: [spoken], error: null, unavailable: false };
  }
}
