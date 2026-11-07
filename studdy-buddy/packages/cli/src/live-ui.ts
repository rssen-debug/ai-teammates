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
    '  Fönster: ' + (live.observing ? (live.windowTitle ?? 'okänt') : 'inget bekräftat tillåtet fönster'),
    '  Aktuell aktivitet: ' + live.activity,
    '  UI-element: ' + (live.observing ? live.elementCount : 0) + ' · senast: ' + freshness,
    '  Verifierade UI-avläsningar: ' + metrics.verifiedSnapshots,
    '  Skills LVL ' + metrics.level + '/100 · ' + metrics.verifiedSkills + ' unika verifierade verktygsfall',
    '  Skillnivån mäter verifierade handlingar, inte AI-intelligens.',
    '  Obsidian: ' + metrics.memoryFacts + ' valda profilminnen · sparas lokalt',
    '  Debugger: ' + options.issues + ' lokala händelser · /debug',
    '  AI: ' + (options.providerConnected ? 'ansluten' : 'ej ansluten'),
    '  Status är mätningar. Ingen dold tankekedja eller påhittad aktivitet visas.',
  ];
}
