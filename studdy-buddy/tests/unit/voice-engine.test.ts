import { describe, it, expect, vi } from 'vitest';
import {
  toSpokenText,
  spokenIp,
  spokenMac,
  spellToken,
  chunkForSpeech,
  assertSpeechIsRequested,
  voiceAvailability,
  selectProvider,
  OpenAiTtsProvider,
} from '@studdy/voice-engine';
import { DEFAULT_SETTINGS, settingsSchema } from '@studdy/shared';

describe('pronunciation preprocessing', () => {
  it('reads an IPv4 address octet by octet in Swedish', () => {
    const spoken = spokenIp('192.168.1.1', 'sv-SE');
    expect(spoken).toContain('ett nio två');
    expect(spoken).toContain('punkt');
    expect(spoken).not.toMatch(/192/);
  });

  it('keeps CIDR prefix as a number and speaks the address', () => {
    const spoken = toSpokenText('Nätet är 10.0.0.0/24.', { language: 'sv-SE' });
    expect(spoken).toContain('snedstreck 24');
    expect(spoken).toContain('ett noll');
  });

  it('spells a MAC address group by group', () => {
    const spoken = spokenMac('00:1A:2B:3C:4D:5E', 'en-US');
    expect(spoken).toContain('zero zero');
    expect(spoken).toContain('dash');
    expect(spoken).not.toContain(':');
  });

  it('handles the Cisco dotted MAC form', () => {
    const spoken = toSpokenText('MAC 0001.6455.2001', { language: 'en-US' });
    expect(spoken).toContain('zero');
    expect(spoken).not.toContain('0001.6455');
  });

  it('spells interface names character by character', () => {
    expect(spellToken('Fa0/1', 'sv-SE')).toContain('snedstreck');
    expect(spellToken('Gi0/2', 'en-US')).toContain('slash');
    const spoken = toSpokenText('Kontrollera Gi0/1 nu.', { language: 'en-US' });
    expect(spoken).toMatch(/gee eye zero/);
  });

  it('expands acronyms per language', () => {
    expect(toSpokenText('OSI-modellen', { language: 'sv-SE' })).toContain('o ess i');
    expect(toSpokenText('ARP request', { language: 'en-US' })).toContain('A R P');
    expect(toSpokenText('VLAN 10', { language: 'sv-SE' })).toContain('ve lan');
  });

  it('leaves ordinary prose untouched', () => {
    const text = 'En switch lär sig MAC-adresser och skickar vidare ramen.';
    const spoken = toSpokenText(text, { language: 'sv-SE' });
    expect(spoken).toContain('switch');
    expect(spoken).toContain('ramen');
  });

  it('does not leave double spaces after substitutions', () => {
    expect(toSpokenText('IP 10.0.0.1  och  mer', { language: 'sv-SE' })).not.toMatch(/ {2,}/);
  });
});

describe('speech chunking', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkForSpeech('Hej.', 900)).toEqual(['Hej.']);
  });

  it('splits at sentence boundaries under the limit', () => {
    const text = 'Ett. Två. Tre. Fyra.';
    const chunks = chunkForSpeech(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('Fyra.');
    expect(chunks.every((c) => c.length <= 12)).toBe(true);
  });
});

describe('voice must never speak unless requested', () => {
  const enabled = settingsSchema.parse({ voice: { enabled: true } });
  const disabled = DEFAULT_SETTINGS;

  it('is off by default', () => {
    expect(DEFAULT_SETTINGS.voice.enabled).toBe(false);
  });

  it('blocks speech when voice is disabled', () => {
    expect(assertSpeechIsRequested({ userRequestedSpeech: true, voice: disabled.voice }).allowed).toBe(false);
  });

  it('blocks speech when the student did not ask', () => {
    const result = assertSpeechIsRequested({ userRequestedSpeech: false, voice: enabled.voice });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/begäran/i);
  });

  it('allows speech only when both conditions hold', () => {
    expect(assertSpeechIsRequested({ userRequestedSpeech: true, voice: enabled.voice }).allowed).toBe(true);
  });
});

describe('provider availability honesty', () => {
  it('does not claim cloud voice works without a key', () => {
    const list = voiceAvailability({ voiceSettings: DEFAULT_SETTINGS.voice, platform: 'win32' });
    const openai = list.find((p) => p.provider === 'openai-compatible');
    const native = list.find((p) => p.provider === 'windows-native');
    expect(openai?.configured).toBe(false);
    expect(native?.configured).toBe(true);
    expect(native?.offline).toBe(true);
  });

  it('reports native voice unavailable on non-Windows platforms', () => {
    const list = voiceAvailability({ voiceSettings: DEFAULT_SETTINGS.voice, platform: 'linux' });
    expect(list.find((p) => p.provider === 'windows-native')?.configured).toBe(false);
  });

  it('does not select any provider when the student chose none', () => {
    const choice = selectProvider({ voiceSettings: DEFAULT_SETTINGS.voice, platform: 'win32' });
    expect(choice.provider).toBeNull();
    expect(choice.note).toMatch(/avstängd/);
  });

  it('falls back to the offline native voice and says so', () => {
    const settings = settingsSchema.parse({ voice: { enabled: true, provider: 'elevenlabs' } });
    const choice = selectProvider({ voiceSettings: settings.voice, platform: 'win32' });
    expect(choice.provider?.id).toBe('windows-native');
    expect(choice.note).toMatch(/Föll tillbaka/);
  });

  it('reports that no provider is configured on Linux without keys', () => {
    const settings = settingsSchema.parse({ voice: { enabled: true, provider: 'openai-compatible' } });
    const choice = selectProvider({ voiceSettings: settings.voice, platform: 'linux' });
    expect(choice.provider).toBeNull();
    expect(choice.note).toMatch(/inte tillgänglig/);
  });
});

describe('OpenAI-compatible TTS client', () => {
  it('sends the preprocessed text, not the raw technical string', async () => {
    let sentBody = '';
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new OpenAiTtsProvider({ apiKey: 'sk-x', fetchImpl });
    const settings = settingsSchema.parse({ voice: { enabled: true, language: 'sv-SE' } });
    const result = await provider.synthesize({ text: 'Adressen är 192.168.0.1/24.', settings: settings.voice });

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(sentBody) as { input: string };
    expect(parsed.input).toContain('snedstreck');
    expect(parsed.input).not.toContain('192.168.0.1/24');
  });

  it('reports a provider error honestly', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const provider = new OpenAiTtsProvider({ apiKey: 'bad', fetchImpl });
    const result = await provider.synthesize({ text: 'hej', settings: DEFAULT_SETTINGS.voice });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it('marks itself unavailable without a key', async () => {
    const provider = new OpenAiTtsProvider({ apiKey: null });
    const result = await provider.synthesize({ text: 'hej', settings: DEFAULT_SETTINGS.voice });
    expect(result.unavailable).toBe(true);
  });
});
