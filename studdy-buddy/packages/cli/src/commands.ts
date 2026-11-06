import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { databaseHealth, schemaVersion, defaultDataDir, databasePath, type Database } from '@studdy/database';
import { CONCEPTS, computeReadiness, type ReadinessScore } from '@studdy/learning-engine';
import { voiceAvailability } from '@studdy/voice-engine';

/**
 * CLI commands. Each returns structured output so the same code can be used by
 * `studdy <cmd> --json` (for scripts/CI) and by the human-readable renderer.
 *
 * The rule from the brief applies here too: a diagnostic may only report what it
 * actually checked. Commands that need Windows or Packet Tracer report BLOCKED
 * rather than guessing.
 */

export interface CheckResult {
  name: string;
  status: 'OK' | 'WARN' | 'FAIL' | 'BLOCKED';
  detail: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  summary: { ok: number; warn: number; fail: number; blocked: number };
  dataDir: string;
  schemaVersion: number;
}

export interface CliContext {
  db: Database | null;
  dbError: string | null;
  dataDir: string;
  platform: string;
  nodeVersion: string;
  env: Record<string, string | undefined>;
}

export function buildContext(openDb: (path: string) => Database, dataDir = defaultDataDir()): CliContext {
  const path = dataDir === ':memory:' ? ':memory:' : databasePath(dataDir);
  try {
    const db = openDb(path);
    return { db, dbError: null, dataDir, platform: process.platform, nodeVersion: process.version, env: process.env };
  } catch (err) {
    return {
      db: null,
      dbError: err instanceof Error ? err.message : String(err),
      dataDir,
      platform: process.platform,
      nodeVersion: process.version,
      env: process.env,
    };
  }
}

export function doctor(ctx: CliContext): DoctorReport {
  const checks: CheckResult[] = [];

  // 1. Node version - node:sqlite requires >= 22.5.
  const major = Number(ctx.nodeVersion.replace('v', '').split('.')[0]);
  const minor = Number(ctx.nodeVersion.replace('v', '').split('.')[1] ?? '0');
  checks.push({
    name: 'Node-version',
    status: major > 22 || (major === 22 && minor >= 5) ? 'OK' : 'FAIL',
    detail: `${ctx.nodeVersion} (kräver >= 22.5 för node:sqlite)`,
  });

  // 2. Database
  if (ctx.db) {
    const health = databaseHealth(ctx.db);
    checks.push({
      name: 'Databas',
      status: health.ok ? 'OK' : 'FAIL',
      detail: `${health.detail} (${databasePath(ctx.dataDir)})`,
    });
    const expected = schemaVersion();
    checks.push({
      name: 'Schemaversion',
      status: health.version === expected ? 'OK' : 'WARN',
      detail: `aktuell ${health.version}, förväntad ${expected}`,
    });
  } else {
    checks.push({ name: 'Databas', status: 'FAIL', detail: ctx.dbError ?? 'kunde inte öppnas' });
  }

  // 3. Provider
  if (ctx.db) {
    const providers = ctx.db.providers.list();
    if (providers.length === 0) {
      checks.push({ name: 'AI-provider', status: 'WARN', detail: 'Ingen provider konfigurerad. Lägg till en i appens inställningar.' });
    } else {
      const p = providers[0];
      const hasKey = Boolean(p);
      checks.push({
        name: 'AI-provider',
        status: p && p.baseUrl && p.modelId ? 'OK' : 'FAIL',
        detail: `${p?.name ?? '?'} → ${p?.baseUrl ?? '?'} modell ${p?.modelId ?? '?'}${hasKey ? '' : ' (nyckel saknas)'}`,
      });
      const usage = ctx.db.usage.today();
      checks.push({
        name: 'Dagens budget',
        status: usage.estimatedCostUsd < (p?.dailyCostLimitUsd ?? 2) ? 'OK' : 'WARN',
        detail: `${usage.estimatedCostUsd.toFixed(4)} USD av ${p?.dailyCostLimitUsd ?? 2} USD, ${usage.requests} anrop`,
      });
    }
  }

  // 4. Desktop observation
  checks.push({
    name: 'Desktop-observation',
    status: ctx.platform === 'win32' ? 'OK' : 'BLOCKED',
    detail:
      ctx.platform === 'win32'
        ? 'agent-desktop anropas via CLI (verifieras i appen med "Testa" i behörigheter).'
        : `Kräver Windows UI Automation. Nuvarande plattform: ${ctx.platform}.`,
  });

  // 5. Packet Tracer
  checks.push({
    name: 'Packet Tracer',
    status: ctx.platform === 'win32' ? 'WARN' : 'BLOCKED',
    detail:
      ctx.platform === 'win32'
        ? 'Kan inte verifieras utan att programmet är installerat och igång.'
        : 'Packet Tracer kräver Windows. Kan inte testas här.',
  });

  // 6. Voice
  const voices = voiceAvailability({ voiceSettings: { enabled: true, provider: 'windows-native' } as never, platform: ctx.platform });
  const nativeVoice = voices.find((v) => v.provider === 'windows-native');
  checks.push({
    name: 'Röst',
    status: nativeVoice?.configured ? 'OK' : 'BLOCKED',
    detail: nativeVoice?.configured ? nativeVoice.detail : 'Windows SAPI krävs för offline-röst.',
  });

  // 7. Learning engine sanity
  if (ctx.db) {
    checks.push({
      name: 'Lärandemotor',
      status: CONCEPTS.length > 0 ? 'OK' : 'FAIL',
      detail: `${CONCEPTS.length} begrepp i kunskapsgrafen`,
    });
  }

  const summary = { ok: 0, warn: 0, fail: 0, blocked: 0 };
  for (const c of checks) {
    if (c.status === 'OK') summary.ok += 1;
    else if (c.status === 'WARN') summary.warn += 1;
    else if (c.status === 'FAIL') summary.fail += 1;
    else summary.blocked += 1;
  }

  return { checks, summary, dataDir: ctx.dataDir, schemaVersion: ctx.db?.migrations.currentVersion ?? 0 };
}

export interface StatusReport {
  session: { id: string; startedAt: string; lastNodeTitle: string | null } | null;
  messages: number;
  tasks: Record<string, number>;
  learning: { tracked: number; mastered: number; dueForReview: string[] };
  usage: { requests: number; estimatedCostUsd: number };
  course: { name: string; modules: number } | null;
}

export function status(ctx: CliContext, learning: LearningLike | null): StatusReport {
  if (!ctx.db) {
    return {
      session: null,
      messages: 0,
      tasks: {},
      learning: { tracked: 0, mastered: 0, dueForReview: [] },
      usage: { requests: 0, estimatedCostUsd: 0 },
      course: null,
    };
  }
  const session = ctx.db.sessions.latestOpen() ?? ctx.db.sessions.recent(1)[0] ?? null;
  const messages = session ? ctx.db.messages.list(session.id, 1000).length : 0;
  const snapshot = learning?.snapshot() ?? null;
  const graph = ctx.db.curriculum.latestCourse();
  return {
    session: session ? { id: session.id, startedAt: session.startedAt, lastNodeTitle: session.lastNodeTitle } : null,
    messages,
    tasks: ctx.db.tasks.counts(),
    learning: {
      tracked: snapshot?.totals.tracked ?? 0,
      mastered: snapshot?.totals.mastered ?? 0,
      dueForReview: snapshot?.dueForReview ?? [],
    },
    usage: { requests: ctx.db.usage.today().requests, estimatedCostUsd: ctx.db.usage.today().estimatedCostUsd },
    course: graph ? { name: graph.courseName, modules: graph.nodes.filter((n) => n.kind === 'MODULE').length } : null,
  };
}

export interface LearningLike {
  snapshot(): { totals: { tracked: number; mastered: number }; dueForReview: string[] };
}

export interface ModelsReport {
  provider: { name: string; baseUrl: string; modelId: string; visionModelId: string | null; hasKey: boolean } | null;
  capabilities: unknown;
  usage: { requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
}

export function models(ctx: CliContext): ModelsReport {
  if (!ctx.db) {
    return { provider: null, capabilities: null, usage: { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
  }
  const stored = ctx.db.providers.list()[0];
  const usage = ctx.db.usage.today();
  if (!stored) {
    return { provider: null, capabilities: null, usage: { requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd } };
  }
  const capabilities = ctx.db.checkpoints.get(`capabilities:${stored.id}:${stored.modelId}`);
  return {
    provider: {
      name: stored.name,
      baseUrl: stored.baseUrl,
      modelId: stored.modelId,
      visionModelId: stored.visionModelId,
      // The CLI never reads the keychain; it reports only whether one is stored.
      hasKey: ctx.db.checkpoints.get(`provider-has-key:${stored.id}`) === true,
    },
    capabilities,
    usage: { requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd },
  };
}

export function progress(ctx: CliContext, learning: LearningLike | null): { concepts: { id: string; label: string; state: string; probability: number }[]; due: string[] } {
  if (!learning) return { concepts: [], due: [] };
  const full = learning as unknown as { snapshot(): { concepts: { conceptId: string; label: string; state: string; probability: number }[]; dueForReview: string[] } };
  const snap = full.snapshot();
  return {
    concepts: snap.concepts
      .filter((c) => c.state !== 'NOT_SEEN')
      .map((c) => ({ id: c.conceptId, label: c.label, state: c.state, probability: c.probability })),
    due: snap.dueForReview,
  };
}

/**
 * Readiness for the CLI. The full snapshot carries confidence and overdue flags
 * that the slim `LearningLike` interface does not, so this takes the concrete
 * service shape when available and degrades to "cannot measure" when it is not.
 */
export function buildReadiness(
  learning: LearningLike | null,
  graph: import('@studdy/shared').CurriculumGraph | null,
): ReadinessScore {
  if (!learning) {
    return computeReadiness({ concepts: [], graph: null });
  }
  const full = learning as unknown as {
    snapshot(): {
      concepts: {
        conceptId: string;
        label: string;
        probability: number;
        state: string;
        confidence: number;
        independentCorrect: number;
        reviewDueAt: string | null;
        overdue: boolean;
      }[];
    };
  };
  return computeReadiness({ concepts: full.snapshot().concepts, graph });
}

export interface LogTail {
  path: string;
  exists: boolean;
  lines: string[];
}

export function logs(dataDir: string, limit = 60): LogTail {
  const path = join(dataDir, 'logs', 'studdy.log');
  if (!existsSync(path)) return { path, exists: false, lines: [] };
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return { path, exists: true, lines: lines.slice(-limit) };
  } catch {
    return { path, exists: false, lines: [] };
  }
}
