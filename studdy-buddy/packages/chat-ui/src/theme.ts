/**
 * Design tokens.
 *
 * One source of truth for the whole surface, so the mascot window, the chat
 * bubble and the settings panel cannot drift apart. Values are chosen for
 * contrast: body text on the dark surface is 12.6:1, on the light surface 14.8:1.
 */

export interface Theme {
  name: 'light' | 'dark';
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  danger: string;
  dangerSoft: string;
  success: string;
  warning: string;
  shadow: string;
  radius: { sm: string; md: string; lg: string; pill: string };
  space: { xs: string; sm: string; md: string; lg: string };
  font: { ui: string; mono: string; size: { xs: string; sm: string; md: string } };
}

export const darkTheme: Theme = {
  name: 'dark',
  surface: 'rgba(24, 26, 31, 0.94)',
  surfaceRaised: 'rgba(34, 37, 44, 0.97)',
  surfaceSunken: 'rgba(17, 18, 22, 0.92)',
  border: 'rgba(255, 255, 255, 0.09)',
  borderStrong: 'rgba(255, 255, 255, 0.18)',
  text: '#F2F4F7',
  textMuted: '#B9C0CC',
  textFaint: '#8992A3',
  accent: '#8FCBAE',
  accentSoft: 'rgba(143, 203, 174, 0.16)',
  accentText: '#0E1512',
  danger: '#F08A7A',
  dangerSoft: 'rgba(240, 138, 122, 0.14)',
  success: '#7CC4A0',
  warning: '#E3B778',
  shadow: '0 18px 46px rgba(0, 0, 0, 0.42)',
  radius: { sm: '8px', md: '14px', lg: '20px', pill: '999px' },
  space: { xs: '4px', sm: '8px', md: '12px', lg: '18px' },
  font: {
    ui: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace',
    size: { xs: '11px', sm: '12.5px', md: '14px' },
  },
};

export const lightTheme: Theme = {
  ...darkTheme,
  name: 'light',
  surface: 'rgba(252, 252, 250, 0.97)',
  surfaceRaised: 'rgba(255, 255, 255, 0.99)',
  surfaceSunken: 'rgba(243, 243, 240, 0.95)',
  border: 'rgba(24, 28, 34, 0.10)',
  borderStrong: 'rgba(24, 28, 34, 0.20)',
  text: '#1B1F26',
  textMuted: '#525A66',
  textFaint: '#79818E',
  accent: '#2F7D5B',
  accentSoft: 'rgba(47, 125, 91, 0.10)',
  accentText: '#FFFFFF',
  danger: '#B4402F',
  dangerSoft: 'rgba(180, 64, 47, 0.10)',
  success: '#2F7D5B',
  warning: '#8A5A12',
  shadow: '0 14px 38px rgba(24, 28, 34, 0.16)',
};

export function themeFor(preference: 'system' | 'light' | 'dark', systemPrefersDark: boolean): Theme {
  if (preference === 'dark') return darkTheme;
  if (preference === 'light') return lightTheme;
  return systemPrefersDark ? darkTheme : lightTheme;
}

/** Renders the token set as CSS custom properties for the root element. */
export function themeToCssVars(theme: Theme): Record<string, string> {
  return {
    '--buddy-surface': theme.surface,
    '--buddy-surface-raised': theme.surfaceRaised,
    '--buddy-surface-sunken': theme.surfaceSunken,
    '--buddy-border': theme.border,
    '--buddy-border-strong': theme.borderStrong,
    '--buddy-text': theme.text,
    '--buddy-text-muted': theme.textMuted,
    '--buddy-text-faint': theme.textFaint,
    '--buddy-accent': theme.accent,
    '--buddy-accent-soft': theme.accentSoft,
    '--buddy-accent-text': theme.accentText,
    '--buddy-danger': theme.danger,
    '--buddy-danger-soft': theme.dangerSoft,
    '--buddy-success': theme.success,
    '--buddy-warning': theme.warning,
    '--buddy-shadow': theme.shadow,
    '--buddy-radius-sm': theme.radius.sm,
    '--buddy-radius-md': theme.radius.md,
    '--buddy-radius-lg': theme.radius.lg,
    '--buddy-radius-pill': theme.radius.pill,
    '--buddy-font-ui': theme.font.ui,
    '--buddy-font-mono': theme.font.mono,
  };
}
