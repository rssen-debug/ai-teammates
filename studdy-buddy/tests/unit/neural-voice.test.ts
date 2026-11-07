import { describe, it, expect } from 'vitest';
import { NEURAL_VOICES, neuralVoiceFor, buildNeuralSsml, escapeSsml, neuralVoiceAvailable } from '@studdy/voice-engine';
import { proactiveSettingsFor } from '@studdy/core';

/**
 * These lock two user-facing promises:
 *  - the voice is a natural Windows voice, chosen deterministically, and no
 *    download or key is needed to get it;
 *  - proactive messages can never spam, because quiet hours and the governor
 *    are applied before anything is printed.
 */

describe('neural voice selection', () => {
  it('defaults to a natural male narrator in the conversation language', () => {
    expect(neuralVoiceFor('en-US', '').gender).toBe('male');
    expect(neuralVoiceFor('en-US', '').language).toBe('en-US');
    expect(neuralVoiceFor('sv-SE', '').language).toBe('sv-SE');
  });

  it('accepts an exact id and a spoken name', () => {
    expect(neuralVoiceFor('en-US', 'en-US-AriaNeural').id).toBe('en-US-AriaNeural');
    expect(neuralVoiceFor('en-US', 'aria').id).toBe('en-US-AriaNeural');
    expect(neuralVoiceFor('en-US', 'Brian').id).toBe('en-US-BrianMultilingualNeural');
  });

  it('falls back to a real voice when asked for something that does not exist', () => {
    const chosen = neuralVoiceFor('sv-SE', 'sunny');
    expect(NEURAL_VOICES.some((v) => v.id === chosen.id)).toBe(true);
  });

  it('never claims to work off Windows', () => {
    expect(neuralVoiceAvailable('win32')).toBe(true);
    expect(neuralVoiceAvailable('linux')).toBe(false);
    expect(neuralVoiceAvailable('darwin')).toBe(false);
  });
});

describe('SSML', () => {
  it('escapes markup so page text cannot break the request', () => {
    expect(escapeSsml('<script>a & b</script>')).toBe('&lt;script&gt;a &amp; b&lt;/script&gt;');
  });

  it('expresses speed as a percentage delta around normal', () => {
    expect(buildNeuralSsml('en-US-GuyNeural', 'hello', { speed: 1, volume: 1 })).toContain("rate='+0%'");
    expect(buildNeuralSsml('en-US-GuyNeural', 'hello', { speed: 1.2, volume: 1 })).toContain("rate='+20%'");
    expect(buildNeuralSsml('en-US-GuyNeural', 'hello', { speed: 0.8, volume: 1 })).toContain("rate='-20%'");
  });

  it('uses the voice the user chose', () => {
    expect(buildNeuralSsml('sv-SE-MattiasNeural', 'hej', { speed: 1, volume: 1 }))
      .toContain("<voice name='sv-SE-MattiasNeural'>");
  });
});

describe('proactive policy', () => {
  const at = (hour: number) => new Date(2026, 0, 15, hour, 30).getTime();

  it('is silent during quiet hours regardless of the chosen mode', () => {
    for (const hour of [22, 23, 0, 3, 6]) {
      expect(proactiveSettingsFor('NORMAL', at(hour)).mode).toBe('OFF');
    }
  });

  it('allows initiative during the day when the student chose it', () => {
    expect(proactiveSettingsFor('NORMAL', at(14)).mode).toBe('NORMAL');
    expect(proactiveSettingsFor('QUIET', at(14)).cooldownMs).toBeGreaterThan(proactiveSettingsFor('NORMAL', at(14)).cooldownMs);
  });

  it('honours an explicit off', () => {
    expect(proactiveSettingsFor('OFF', at(14)).mode).toBe('OFF');
  });

  it('defaults to quiet, not chatty, when nothing was chosen', () => {
    expect(proactiveSettingsFor(null, at(14)).mode).toBe('QUIET');
    expect(proactiveSettingsFor('nonsense', at(14)).mode).toBe('QUIET');
  });
});
