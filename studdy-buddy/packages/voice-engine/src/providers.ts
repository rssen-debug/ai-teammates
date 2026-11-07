import type { VoiceSettings } from '@studdy/shared';
import { requestOnce, TimeoutError } from '@studdy/shared';
import { chunkForSpeech, toSpokenText } from './pronunciation.js';

/**
 * Text-to-speech providers.
 *
 * Honest capability reporting is the point of this file: each provider declares
 * what it can and cannot do, and `listVoices` returns *configured* availability
 * rather than pretending a cloud key exists.
 *
 *  - windows-native: uses the OS SAPI voices via PowerShell. Works offline on
 *    Windows out of the box (no key), which is the default fallback.
 *  - openai-compatible: POST /audio/speech.
 *  - elevenlabs: POST /v1/text-to-speech/{voiceId}.
 */

export type TtsProviderId = 'windows-native' | 'openai-compatible' | 'elevenlabs' | 'none';

export interface TtsRequest {
  text: string;
  settings: VoiceSettings;
  signal?: AbortSignal;
}

export interface TtsResult {
  ok: boolean;
  /** Base64-encoded audio, or null when the provider is unavailable. */
  audioBase64: string | null;
  mimeType: string;
  /** Chunks we actually synthesised (for streaming playback). */
  chunks: string[];
  error: string | null;
  /** True when no provider is configured - the UI must say so, not fake audio. */
  unavailable: boolean;
}

export interface TtsProvider {
  id: TtsProviderId;
  label: string;
  /** What this provider actually supports, stated plainly. */
  capabilities: { languages: string[]; offline: boolean; needsApiKey: boolean };
  isConfigured(): boolean;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

export interface ProviderHttpConfig {
  apiKey: string | null;
  baseUrl?: string;
  voiceId?: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiTtsProvider implements TtsProvider {
  readonly id = 'openai-compatible' as const;
  readonly label = 'OpenAI-kompatibel TTS';
  readonly capabilities = { languages: ['sv-SE', 'en-US'], offline: false, needsApiKey: true };

  constructor(private readonly config: ProviderHttpConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (!this.isConfigured()) {
      return { ok: false, audioBase64: null, mimeType: 'audio/mpeg', chunks: [], error: 'Ingen API-nyckel för röst är konfigurerad.', unavailable: true };
    }
    const chunks = chunkForSpeech(toSpokenText(request.text, { language: request.settings.language }));
    const audioParts: string[] = [];
    try {
      for (const chunk of chunks) {
        const res = await requestOnce(`${(this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
          body: JSON.stringify({
            model: request.settings.voiceId || 'tts-1',
            voice: 'alloy',
            input: chunk,
            speed: request.settings.speed,
            response_format: 'mp3',
          }),
          timeoutMs: 45_000,
          signal: request.signal,
          fetchImpl: this.config.fetchImpl,
        });
        if (!res.ok) {
          const body = await res.text();
          return { ok: false, audioBase64: null, mimeType: 'audio/mpeg', chunks, error: `TTS misslyckades (HTTP ${res.status}): ${body.slice(0, 200)}`, unavailable: false };
        }
        const buf = Buffer.from(await res.arrayBuffer());
        audioParts.push(buf.toString('base64'));
      }
      return { ok: true, audioBase64: audioParts.join(''), mimeType: 'audio/mpeg', chunks, error: null, unavailable: false };
    } catch (err) {
      const message = err instanceof TimeoutError ? 'TTS-timeout' : err instanceof Error ? err.message : String(err);
      return { ok: false, audioBase64: null, mimeType: 'audio/mpeg', chunks, error: message, unavailable: false };
    }
  }
}

export class ElevenLabsProvider implements TtsProvider {
  readonly id = 'elevenlabs' as const;
  readonly label = 'ElevenLabs';
  readonly capabilities = { languages: ['sv-SE', 'en-US'], offline: false, needsApiKey: true };

  constructor(private readonly config: ProviderHttpConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey && (this.config.voiceId ?? '').length > 0);
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (!this.isConfigured()) {
      return { ok: false, audioBase64: null, mimeType: 'audio/mpeg', chunks: [], error: 'ElevenLabs kräver både API-nyckel och voice-id.', unavailable: true };
    }
    const voiceId = this.config.voiceId as string;
    const chunks = chunkForSpeech(toSpokenText(request.text, { language: request.settings.language }));
    const parts: string[] = [];
    try {
      for (const chunk of chunks) {
        const res = await requestOnce(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'xi-api-key': this.config.apiKey as string },
          body: JSON.stringify({
            text: chunk,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          timeoutMs: 60_000,
          signal: request.signal,
          fetchImpl: this.config.fetchImpl,
        });
        if (!res.ok) {
          return { ok: false, audioBase64: null, mimeType: 'audio/mpeg', chunks, error: `ElevenLabs svarade HTTP ${res.status}`, unavailable: false };
        }
        parts.push(Buffer.from(await res.arrayBuffer()).toString('base64'));
      }
      return { ok: true, audioBase64: parts.join(''), mimeType: 'audio/mpeg', chunks, error: null, unavailable: false };
    } catch (err) {
      return { ok: false, audioBase64: null, mimeType: 'audio/mpeg', chunks, error: err instanceof Error ? err.message : String(err), unavailable: false };
    }
  }
}

/**
 * Windows SAPI, driven through PowerShell.
 *
 * We do NOT synthesise audio into memory here: SAPI speaks directly, which is
 * the lowest-latency offline option on Windows and needs no key. The command
 * returns after the utterance finishes so the app can report "speaking" state
 * accurately. Stop is handled by the caller killing the child process.
 */
export class WindowsNativeProvider implements TtsProvider {
  readonly id = 'windows-native' as const;
  readonly label = 'Windows röster (SAPI)';
  readonly capabilities = { languages: ['sv-SE', 'en-US'], offline: true, needsApiKey: false };

  constructor(private readonly platform: string = process.platform) {}

  isConfigured(): boolean {
    return this.platform === 'win32';
  }

  buildCommand(request: TtsRequest): { command: string; args: string[] } {
    const spoken = toSpokenText(request.text, { language: request.settings.language });
    const rate = Math.round((request.settings.speed - 1) * 5); // SAPI: -10..10
    const volume = Math.round(request.settings.volume * 100);
    const culture = request.settings.language === 'sv-SE' ? 'sv-SE' : 'en-US';
    // Single-quoted PowerShell string; escape embedded single quotes by doubling.
    const escaped = spoken.replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      `$s.Rate = ${rate};`,
      `$s.Volume = ${volume};`,
      settings.voiceId && /^[a-zA-Z0-9 ._-]{1,120}$/.test(settings.voiceId)
        ? `try { $s.SelectVoice('${settings.voiceId.replace(/'/g, "''")}') } catch { $s.SelectVoiceByHints('NotSet','NotSet',0,[System.Globalization.CultureInfo]::GetCultureInfo('${culture}')) };`
        : `try { $s.SelectVoiceByHints('NotSet','NotSet',0,[System.Globalization.CultureInfo]::GetCultureInfo('${culture}')) } catch {};`,
      `$s.Speak('${escaped}');`,
    ].join(' ');
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        audioBase64: null,
        mimeType: 'audio/wav',
        chunks: [],
        error: 'Windows-röster är bara tillgängliga på Windows.',
        unavailable: true,
      };
    }
    // Actual playback is owned by the Electron main process (it holds the child
    // process handle so it can stop on command). Here we only expose the command.
    return {
      ok: true,
      audioBase64: null,
      mimeType: 'audio/wav',
      chunks: chunkForSpeech(toSpokenText(request.text, { language: request.settings.language })),
      error: null,
      unavailable: false,
    };
  }
}

export interface VoiceRegistryOptions {
  voiceSettings: VoiceSettings;
  openAi?: ProviderHttpConfig;
  elevenLabs?: ProviderHttpConfig;
  platform?: string;
}

export interface VoiceAvailability {
  provider: TtsProviderId;
  label: string;
  configured: boolean;
  offline: boolean;
  languages: string[];
  detail: string;
}

/**
 * Reports which providers are actually usable. The settings screen renders this
 * verbatim, so a student is never told voice works when it does not.
 */
export function voiceAvailability(options: VoiceRegistryOptions): VoiceAvailability[] {
  const platform = options.platform ?? process.platform;
  const native = new WindowsNativeProvider(platform);
  const openai = new OpenAiTtsProvider(options.openAi ?? { apiKey: null });
  const eleven = new ElevenLabsProvider(options.elevenLabs ?? { apiKey: null });

  return [
    {
      provider: 'windows-native',
      label: native.label,
      configured: native.isConfigured(),
      offline: true,
      languages: native.capabilities.languages,
      detail: native.isConfigured() ? 'Använder installerade röster i Windows.' : 'Kräver Windows.',
    },
    {
      provider: 'openai-compatible',
      label: openai.label,
      configured: openai.isConfigured(),
      offline: false,
      languages: openai.capabilities.languages,
      detail: openai.isConfigured() ? 'API-nyckel finns.' : 'Ingen API-nyckel angiven.',
    },
    {
      provider: 'elevenlabs',
      label: eleven.label,
      configured: eleven.isConfigured(),
      offline: false,
      languages: eleven.capabilities.languages,
      detail: eleven.isConfigured() ? 'API-nyckel och voice-id finns.' : 'Kräver API-nyckel och voice-id.',
    },
  ];
}

/**
 * Picks the provider to use: honour the student's choice, but fall back to a
 * working one rather than silently doing nothing.
 */
export function selectProvider(options: VoiceRegistryOptions): { provider: TtsProvider | null; note: string | null } {
  const settings = options.voiceSettings;
  if (!settings.enabled) return { provider: null, note: 'Röst är avstängd i inställningarna.' };

  const platform = options.platform ?? process.platform;
  const candidates: TtsProvider[] = [];
  if (settings.provider === 'windows-native') candidates.push(new WindowsNativeProvider(platform));
  if (settings.provider === 'openai-compatible') candidates.push(new OpenAiTtsProvider(options.openAi ?? { apiKey: null }));
  if (settings.provider === 'elevenlabs') candidates.push(new ElevenLabsProvider(options.elevenLabs ?? { apiKey: null }));
  // Always allow the offline native voice as a last resort on Windows.
  if (platform === 'win32' && settings.provider !== 'windows-native') candidates.push(new WindowsNativeProvider(platform));

  for (const provider of candidates) {
    if (provider.isConfigured()) {
      return provider.id === settings.provider ? { provider, note: null } : { provider, note: `Föll tillbaka på ${provider.label}.` };
    }
  }
  return { provider: null, note: 'Ingen röstprovider är konfigurerad. Röst är därför inte tillgänglig.' };
}

/**
 * The hard product rule, as code: speech must never start on its own.
 * Every call path that could produce audio goes through this guard.
 */
export function assertSpeechIsRequested(context: {
  userRequestedSpeech: boolean;
  /** The *voice* sub-settings, not the whole app settings object. */
  voice: VoiceSettings;
}): { allowed: boolean; reason: string } {
  if (!context.voice.enabled) return { allowed: false, reason: 'Röst är avstängd i inställningarna.' };
  if (!context.userRequestedSpeech) return { allowed: false, reason: 'Ingen uttalad begäran om uppläsning.' };
  return { allowed: true, reason: 'ok' };
}
