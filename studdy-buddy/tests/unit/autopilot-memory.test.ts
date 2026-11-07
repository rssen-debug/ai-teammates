import { describe, it, expect } from 'vitest';
import { extractProfileFact, isNewFact } from '@studdy/core';
import { ObsidianMemory } from '@studdy/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The user asked for autopilot memory: no /remember, it should learn on its own.
 * The risk with anything automatic is that it stores garbage, secrets, or
 * invented facts about a person. These tests exist to make that impossible to
 * ship by accident.
 */

describe('autopilot profile extraction', () => {
  it('learns a first-person statement about the user', () => {
    expect(extractProfileFact('Jag pluggar till nätverkstekniker på distans.')).toBe('Jag pluggar till nätverkstekniker på distans');
    expect(extractProfileFact('my exam is in March and I am nervous')).toBe('my exam is in March and I am nervous');
  });

  it('learns a stated preference', () => {
    expect(extractProfileFact('Jag föredrar korta svar utan exempel.')).toBe('Jag föredrar korta svar utan exempel');
  });

  it('never stores a question as a fact', () => {
    // A question is a request, not a statement about the person.
    expect(extractProfileFact('Jag undrar vad subnetting är?')).toBeNull();
    expect(extractProfileFact('kan jag få hjälp med min uppgift?')).toBeNull();
  });

  it('never stores anything that looks like a credential or personal id', () => {
    const secrets = [
      'min nyckel är sk-abcdefghijklmnopqrstuvwx',
      'jag har api key sk-proj-1234567890123456789012',
      'mitt personnummer är 19900101-1234 och jag pluggar',
      'jag heter a@b.se och pluggar nätverk',
      'min token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'jag föredrar https://example.com/course',
    ];
    for (const text of secrets) expect(extractProfileFact(text)).toBeNull();
  });

  it('ignores small talk with no durable fact', () => {
    expect(extractProfileFact('hej')).toBeNull();
    expect(extractProfileFact('okej tack då')).toBeNull();
    expect(extractProfileFact('det där var svårt')).toBeNull();
  });

  it('ignores statements about the app rather than the person', () => {
    expect(extractProfileFact('den här appen fungerar inte som jag vill')).toBeNull();
  });
});

describe('duplicate suppression', () => {
  it('does not store the same fact twice in other words', () => {
    const existing = ['Jag pluggar till nätverkstekniker på distans'];
    expect(isNewFact('Jag pluggar till nätverkstekniker på distans', existing)).toBe(false);
    expect(isNewFact('jag pluggar nätverkstekniker på distans', existing)).toBe(false);
  });

  it('stores a genuinely new fact', () => {
    const existing = ['Jag pluggar till nätverkstekniker på distans'];
    expect(isNewFact('Jag föredrar korta svar utan exempel', existing)).toBe(true);
  });
});

describe('autopilot memory in the vault', () => {
  it('stores a learned fact and makes it visible in the profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-auto-'));
    try {
      const memory = new ObsidianMemory(dir);
      const learned = memory.rememberProfileAuto('Jag studerar CCNA och mitt mål är att klara tentan i mars.');
      expect(learned).toBeTruthy();
      expect(memory.profileFacts()).toContain(learned);
      // Second time in other words: nothing new is written.
      expect(memory.rememberProfileAuto(learned!)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the vault untouched when there is nothing to learn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studdy-auto-'));
    try {
      const memory = new ObsidianMemory(dir);
      expect(memory.rememberProfileAuto('vad är en router?')).toBeNull();
      expect(memory.profileFacts()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
