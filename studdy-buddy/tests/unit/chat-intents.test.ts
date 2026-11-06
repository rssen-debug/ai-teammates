import { describe, it, expect } from 'vitest';
import { parseLaunchIntent, isAccessQuestion, isInboxRequest, isLiveQuestion } from '@studdy/core';

describe('chat intents', () => {
  it('parses generic multi-word launch without browser aliases', () => {
    expect(parseLaunchIntent('kan du öppna programmet Google Chrome åt mig?')?.programName).toBe('Google Chrome');
    expect(parseLaunchIntent('öppna minnet')?.openMemory).toBe(true);
  });
  it('access question does not swallow launch request', () => {
    expect(isAccessQuestion('kan du öppna programmet Google Chrome')).toBe(false);
    expect(isAccessQuestion('har du full åtkomst?')).toBe(true);
  });
  it('detects inbox and live questions', () => {
    expect(isInboxRequest('visa min gmail')).toBe(true);
    expect(isLiveQuestion('är du live?')).toBe(true);
  });
});
