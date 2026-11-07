import type { LiveStatus } from '@studdy/core';

export interface LiveMetrics {
  verifiedSnapshots: number;
  verifiedSkills: number;
  level: number;
  memoryFacts: number;
  vaultPath: string | null;
  debuggerPath: string;
}

/** Render measured work only. A skill level is NOT an IQ score. */
export function liveLines(
  live: LiveStatus,
  metrics: LiveMetrics,
  options: { providerConnected: boolean; issues: number; now?: number },
): string[] {
  const now = options.now ?? Date.now();
  const freshness = live.lastObservedAt === null
    ? 'ingen bekräftad observation'
    : Math.max(0, Math.floor((now - live.lastObservedAt) / 1000)) + ' s sedan';
  return [
    '● Process: körs i denna terminal (inte en Windows-bakgrundstjänst)',
    (live.observing ? '●' : '○') + ' UI: ' + (live.observing ? 'AKTIV' : live.state.toUpperCase()),
    '  Aktivt i Windows: ' + (live.foregroundWindow ?? 'okänt'),
    '  Öppna programfönster: ' + (live.openWindowCount ?? 0),
    ...(live.openWindows ?? []).map(name => '    • ' + name),
    '  Läser nu: ' + (live.observing ? (live.windowTitle ?? 'okänt') : 'ingen bekräftad UI-avläsning') +
      (live.observing ? (live.observationScope === 'background' ? ' · bakom terminalen' : ' · förgrund') : ''),
    '  Aktuell aktivitet: ' + live.activity,
    '  Senast verifierad UI-avläsning: ' +
      (live.observing ? live.elementCount + ' element · ' : 'inga aktuella element · ') + freshness,
    '  Verifierade UI-avläsningar: ' + metrics.verifiedSnapshots,
    '  Verifierade verktyg: ' + metrics.verifiedSkills + ' · intern framstegsnivå ' + metrics.level + '/100',
    '  Skillnivån mäter verifierade handlingar, inte AI-intelligens.',
    '  Obsidian: ' + metrics.memoryFacts + ' valda profilminnen · sparas lokalt',
    '  Debugger: ' + options.issues + ' lokala händelser · /debug',
    '  AI: ' + (options.providerConnected ? 'ansluten' : 'ej ansluten'),
    '  Status är mätningar. Ingen dold tankekedja eller påhittad aktivitet visas.',
  ];
}

/** Bounded prompt prefix redrawn in-place by Node readline. Never print a new
 * output line per poll; typed user input is preserved by rl.prompt(true).
 */
export function compactLivePrompt(live: LiveStatus, level: number): string {
  const label = live.observing
    ? (live.windowTitle ?? 'Program').replace(/\s+/g, ' ').replaceAll(String.fromCharCode(27), '').slice(0, 26)
    : live.state === 'starting' ? 'Startar' : live.state === 'off' ? 'Pausad' : 'UI ej läsbart';
  const windows = live.openWindowCount ?? 0;
  // The level is retained in /progress for compatibility; the status line
  // presents interpretable evidence rather than a misleading IQ-like score.
  void level;
  return (live.observing ? '● SER' : '○ SÖKER') +
    ' · ' + windows + ' fönster · ' + label +
    (live.observing ? ' · ' + Math.max(0, live.elementCount) + ' element' : ' · inga verifierade element');
}
