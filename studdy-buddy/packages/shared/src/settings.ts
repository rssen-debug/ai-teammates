import { z } from 'zod';

/**
 * Settings are validated with zod both in the renderer form and again in the
 * main process. The main process is authoritative.
 */

export const permissionModeSchema = z.enum(['OBSERVE_ONLY', 'VISUAL_GUIDE', 'APPROVED_ACTION']);

export const providerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, 'Give the provider a name').max(60),
  baseUrl: z
    .string()
    .url('Must be a full URL, e.g. https://api.deepseek.com/v1')
    .refine((v) => v.startsWith('https://') || v.includes('localhost') || v.includes('127.0.0.1'), {
      message: 'Use https:// (plain http is only allowed for localhost)',
    }),
  modelId: z.string().min(1, 'Model id is required').max(120),
  visionModelId: z.string().max(120).nullable().default(null),
  fallbackModelId: z.string().max(120).nullable().default(null),
  reasoning: z.enum(['off', 'auto', 'deep']).default('auto'),
  maxTokensPerRequest: z.number().int().min(64).max(32_000).default(1024),
  dailyCostLimitUsd: z.number().min(0).max(1000).default(2),
  inputCostPerMTok: z.number().min(0).max(1000).default(0.14),
  outputCostPerMTok: z.number().min(0).max(1000).default(0.28),
});

export type ProviderConfigInput = z.infer<typeof providerConfigSchema>;

export const voiceSettingsSchema = z.object({
  /** Voice is OFF by default by explicit product requirement. */
  enabled: z.boolean().default(false),
  provider: z.enum(['windows-neural', 'windows-native', 'openai-compatible', 'elevenlabs', 'none']).default('none'),
  voiceId: z.string().max(120).default(''),
  language: z.enum(['sv-SE', 'en-US']).default('sv-SE'),
  speed: z.number().min(0.5).max(2).default(1),
  volume: z.number().min(0).max(1).default(0.9),
  /** Speech-to-text is opt-in separately from TTS. */
  sttEnabled: z.boolean().default(false),
  wakeWordEnabled: z.boolean().default(false),
});

export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  reducedMotion: z.boolean().default(false),
  defaultMode: z.enum(['QUICK', 'NORMAL', 'TEACH', 'DEEP', 'STEP_BY_STEP', 'DEBUG']).default('NORMAL'),
  proactive: z.enum(['OFF', 'QUIET', 'NORMAL']).default('QUIET'),
  language: z.enum(['sv-SE', 'en-US']).default('sv-SE'),
  permissionMode: permissionModeSchema.default('OBSERVE_ONLY'),
  launchAtLogin: z.boolean().default(false),
  alwaysOnTop: z.boolean().default(true),
  mascotScale: z.number().min(0.7).max(1.8).default(1),
  voice: voiceSettingsSchema.default({}),
  mascotPosition: z
    .object({ x: z.number().int(), y: z.number().int(), displayId: z.string().nullable() })
    .nullable()
    .default(null),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export function parseSettings(raw: unknown): Settings {
  const parsed = settingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // Merge what we can rather than throwing away the student's preferences.
  const base = DEFAULT_SETTINGS;
  if (raw && typeof raw === 'object') {
    const shallow = settingsSchema.safeParse({ ...base, ...(raw as Record<string, unknown>) });
    if (shallow.success) return shallow.data;
  }
  return base;
}

/** Deep-merge partial settings updates, then validate. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const merged = deepMerge(current as unknown as Record<string, unknown>, (patch ?? {}) as Record<string, unknown>);
  return parseSettings(merged);
}

export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}
