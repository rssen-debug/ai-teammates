/**
 * Renderer-safe utilities. This module must not import Node built-ins because
 * it is bundled into the Electron renderer and the browser extension.
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Non-cryptographic unique id. Never used for security decisions. */
export function createId(prefix = 'id'): string {
  let rand = '';
  for (let i = 0; i < 10; i += 1) {
    rand += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** Stable FNV-1a hash, used for dedupe keys (screenshots, questions, pages). */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function stableKey(...parts: (string | number | null | undefined)[]): string {
  return fnv1a(parts.map((p) => String(p ?? '').trim().toLowerCase()).join('\u0001'));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

export function startOfDayIso(iso: string): string {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export function dayKey(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

/** Sentence-ish splitter used by the length validator. */
export function splitSentences(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const rough = cleaned.split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ0-9"'(])/g);
  return rough.map((s) => s.trim()).filter(Boolean);
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Deterministic sum so tests can reason about pseudo-random behaviour. */
export function seededNumber(seed: string): number {
  const hex = fnv1a(seed);
  return parseInt(hex, 16) / 0xffffffff;
}
