/**
 * `studdy kernel …` — the operator surface for the unified agent.
 *
 * Everything here reads or writes the same durable state the supervisor uses,
 * so a command can never report something the engine did not record. Exit codes
 * are meaningful: 0 only when the command actually did what it named.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import {
  buildReport,
  renderReport,
  verifyClaim,
  type Evidence,
  type TaskState,
} from '@studdy/agent-core';
import type { StuddyRuntime } from '@studdy/core';

export interface KernelCommandIO {
  out: (value: unknown) => void;
  err: (text: string) => void;
  /** When true, `out` already JSON-encodes objects; text output stays textual. */
  json: boolean;
}

export interface KernelCommandOptions {
  /** Positional arguments after `kernel`. */
  args: string[];
  flags: Record<string, unknown>;
  runtime: StuddyRuntime;
  io: KernelCommandIO;
}

const stringFlag = (flags: Record<string, unknown>, name: string): string | undefined => {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
};

const boolFlag = (flags: Record<string, unknown>, name: string): boolean => flags[name] === true;

function parseJsonFlag(flags: Record<string, unknown>, name: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const raw = stringFlag(flags, name);
  if (raw == null) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: `--${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const KERNEL_HELP = `studdy kernel — körbar, spårbar autonom kö

  studdy kernel status [--json]           Status från verklig sparad state
  studdy kernel enqueue --kind K --tool NAMN [--args JSON] [--priority N]
                        [--dedupe-key K] [--effect-key K] [--irreversible]
  studdy kernel run [--max-tasks N] [--max-runtime-ms N] [--worker-id ID]
  studdy kernel list [--state S]          Lista uppgifter
  studdy kernel get <id>                  En uppgift med historik
  studdy kernel cancel <id> | retry <id>
  studdy kernel reconcile <id> --outcome confirmed|failed_final [--evidence JSON]
  studdy kernel stop | clear-stop         STOP-fil styr en pågående worker
  studdy kernel events [--limit N]        Verklig händelselogg
  studdy kernel verify --statement "…" [--kind K] [--path P] [--readback T]
  studdy tools                            Verktyg som workern faktiskt kan köra

Regler: en uppgift blir aldrig COMPLETED utan bevis; en osäker extern effekt
körs aldrig om; en saknad behörighet ger ett ärligt fel, inte en tyst no-op.`;

export async function runKernelCommand({ args, flags, runtime, io }: KernelCommandOptions): Promise<number> {
  const sub = args[0] ?? 'status';
  const kernel = runtime.kernel();

  switch (sub) {
    case 'help': {
      io.out(KERNEL_HELP);
      return 0;
    }

    case 'status': {
      const report = await buildReport({
        queue: kernel.queue,
        log: kernel.log,
        workersDir: kernel.paths.workersDir,
        home: kernel.home,
      });
      if (io.json) {
        io.out(report);
        return 0;
      }
      io.out(renderReport(report));
      const failed = report.queue.byState.FAILED_FINAL ?? 0;
      const uncertain = report.queue.byState.UNCERTAIN ?? 0;
      if (uncertain > 0) io.out(`\n${uncertain} osäker(a) uppgift(er) kräver ägarbeslut: studdy kernel reconcile <id>`);
      return failed > 0 ? 1 : 0;
    }

    case 'enqueue': {
      const kind = stringFlag(flags, 'kind') ?? 'tool';
      const tool = stringFlag(flags, 'tool');
      if (kind === 'tool' && !tool) {
        io.err('--tool krävs för kind=tool (se studdy tools)');
        return 2;
      }
      const parsedArgs = parseJsonFlag(flags, 'args');
      if (!parsedArgs.ok) {
        io.err(parsedArgs.error);
        return 2;
      }
      if (parsedArgs.value != null && (typeof parsedArgs.value !== 'object' || Array.isArray(parsedArgs.value))) {
        io.err('--args måste vara ett JSON-objekt');
        return 2;
      }
      const payload: Record<string, unknown> = kind === 'tool'
        ? { tool, arguments: parsedArgs.value ?? {} }
        : { ...(parsedArgs.value as Record<string, unknown> | undefined) };
      const priorityRaw = stringFlag(flags, 'priority');
      const priority = priorityRaw == null ? 0 : Number(priorityRaw);
      if (!Number.isFinite(priority)) {
        io.err('--priority måste vara ett tal');
        return 2;
      }
      const { task, deduplicated } = await kernel.queue.add({
        kind,
        title: stringFlag(flags, 'title'),
        payload,
        priority,
        dedupeKey: stringFlag(flags, 'dedupe-key') ?? null,
        effectKey: stringFlag(flags, 'effect-key') ?? null,
        irreversible: boolFlag(flags, 'irreversible'),
      });
      if (io.json) {
        io.out(deduplicated
          ? { ok: true, deduplicated: true, task: { id: task.id, state: task.state } }
          : { ok: true, deduplicated: false, task: { id: task.id, kind: task.kind, state: task.state } });
      } else {
        io.out(deduplicated
          ? `Uppgift fanns redan (${task.id}) i state ${task.state}.`
          : `Köade ${task.kind} som ${task.id}.`);
      }
      return 0;
    }

    case 'run': {
      const maxTasksRaw = stringFlag(flags, 'max-tasks');
      const maxRuntimeRaw = stringFlag(flags, 'max-runtime-ms');
      const maxTasks = maxTasksRaw == null ? 25 : Number(maxTasksRaw);
      const maxRuntimeMs = maxRuntimeRaw == null ? 15 * 60_000 : Number(maxRuntimeRaw);
      if (!Number.isFinite(maxTasks) || maxTasks < 1) {
        io.err('--max-tasks måste vara >= 1');
        return 2;
      }
      if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 1) {
        io.err('--max-runtime-ms måste vara >= 1');
        return 2;
      }
      const workerId = stringFlag(flags, 'worker-id') ?? `studdy-cli-${process.pid}`;
      const { supervisor } = runtime.kernelSupervisor(workerId);
      const summary = await supervisor.run({ maxTasks, maxRuntimeMs });
      const stats = await kernel.queue.stats();
      const result = {
        ok: summary.failed === 0,
        reason: summary.reason,
        workerId,
        executed: summary.executed,
        completed: summary.completed,
        failed: summary.failed,
        blocked: summary.blocked,
        uncertain: summary.uncertain,
        toolCalls: summary.toolCalls,
        remaining: stats.byState.QUEUED,
      };
      if (io.json) {
        io.out(result);
      } else {
        io.out(`Worker ${workerId}: ${summary.reason}`);
        io.out(`  körda ${summary.executed} · klara ${summary.completed} · misslyckade ${summary.failed} · blockerade ${summary.blocked} · osäkra ${summary.uncertain}`);
        io.out(`  kvar i kö ${stats.byState.QUEUED}`);
      }
      // A run that ended because it ran out of time or tasks is not a failure;
      // a run with failed tasks is.
      return summary.failed > 0 ? 1 : 0;
    }

    case 'list': {
      const state = stringFlag(flags, 'state') as TaskState | undefined;
      const limitRaw = stringFlag(flags, 'limit');
      const limit = limitRaw == null ? 50 : Math.max(1, Math.min(500, Number(limitRaw) || 50));
      const tasks = await kernel.queue.list({ state: state ?? null, limit });
      if (io.json) {
        io.out(tasks.map(({ payload: _payload, ...rest }) => rest));
        return 0;
      }
      if (!tasks.length) {
        io.out('Inga uppgifter i kön.');
        return 0;
      }
      io.out('ID                              STATE              PRIO  KIND');
      for (const task of tasks) {
        io.out(`${task.id.padEnd(31)} ${task.state.padEnd(18)} ${String(task.priority).padEnd(5)} ${task.kind}`);
      }
      return 0;
    }

    case 'get': {
      const id = args[1];
      if (!id) {
        io.err('Ange uppgiftens id: studdy kernel get <id>');
        return 2;
      }
      const task = await kernel.queue.get(id);
      if (!task) {
        io.err(`Ingen uppgift med id ${id}`);
        return 1;
      }
      if (io.json) {
        io.out(task);
        return 0;
      }
      io.out(`${task.id}  ${task.state}  ${task.kind}`);
      io.out(`  försök: ${task.attempts}/${task.maxAttempts}  prioritet: ${task.priority}`);
      if (task.blocked) io.out(`  blockerad: ${task.blocked.code} - ${task.blocked.reason}`);
      if (task.lastError) io.out(`  fel: ${task.lastError.code} (${task.lastError.messageClass})`);
      if (task.result?.summary) io.out(`  resultat: ${task.result.summary}`);
      io.out('  historik:');
      for (const entry of task.history) io.out(`    ${entry.at}  ${entry.state}  av ${entry.by}`);
      return 0;
    }

    case 'cancel': {
      const id = args[1];
      if (!id) {
        io.err('Ange uppgiftens id: studdy kernel cancel <id>');
        return 2;
      }
      try {
        const task = await kernel.queue.cancel(id);
        io.out({ ok: true, id: task.id, state: task.state });
        return 0;
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    case 'retry': {
      const id = args[1];
      if (!id) {
        io.err('Ange uppgiftens id: studdy kernel retry <id>');
        return 2;
      }
      try {
        const task = await kernel.queue.requeue(id);
        io.out({ ok: true, id: task.id, state: task.state });
        return 0;
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    case 'reconcile': {
      const id = args[1];
      const outcome = stringFlag(flags, 'outcome');
      if (!id) {
        io.err('Ange uppgiftens id: studdy kernel reconcile <id> --outcome confirmed|failed_final');
        return 2;
      }
      if (outcome !== 'confirmed' && outcome !== 'failed_final') {
        io.err('--outcome måste vara confirmed eller failed_final');
        return 2;
      }
      const evidence = parseJsonFlag(flags, 'evidence');
      if (!evidence.ok) {
        io.err(evidence.error);
        return 2;
      }
      try {
        const task = await kernel.queue.resolveUncertain(id, {
          outcome,
          evidence: evidence.value ?? null,
        });
        io.out({ ok: true, id: task.id, state: task.state });
        return 0;
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    case 'stop': {
      writeFileSync(kernel.paths.stopFile, `stop requested by CLI at ${new Date().toISOString()}\n`, { mode: 0o600 });
      io.out({ ok: true, stopFile: kernel.paths.stopFile, detail: 'En pågående worker stannar vid nästa kontroll.' });
      return 0;
    }

    case 'clear-stop': {
      if (existsSync(kernel.paths.stopFile)) rmSync(kernel.paths.stopFile, { force: true });
      io.out({ ok: true, cleared: true, stopFile: kernel.paths.stopFile });
      return 0;
    }

    case 'events': {
      const limitRaw = stringFlag(flags, 'limit');
      const limit = limitRaw == null ? 30 : Math.max(1, Math.min(2000, Number(limitRaw) || 30));
      const events = kernel.log.read({ limit });
      if (io.json) {
        io.out(events);
        return 0;
      }
      if (!events.length) {
        io.out('Inga händelser loggade ännu.');
        return 0;
      }
      for (const event of events) {
        io.out(`${event.at}  ${String(event.seq).padStart(5)}  ${event.type}  ${JSON.stringify(event.data).slice(0, 120)}`);
      }
      return 0;
    }

    case 'verify': {
      const statement = stringFlag(flags, 'statement');
      if (!statement) {
        io.err('--statement krävs, t.ex. --statement "skapade rapporten"');
        return 2;
      }
      const kind = stringFlag(flags, 'kind');
      const path = stringFlag(flags, 'path');
      const readback = stringFlag(flags, 'readback');
      const operationId = stringFlag(flags, 'operation-id');
      const detail = stringFlag(flags, 'detail');
      const evidence: Evidence | null = kind
        ? {
          kind: kind as Evidence['kind'],
          ...(path ? { path } : {}),
          ...(readback ? { readback } : {}),
          ...(operationId ? { operationId } : {}),
          ...(detail ? { detail } : {}),
        }
        : null;
      const result = verifyClaim({ statement }, evidence);
      if (io.json) {
        io.out(result);
      } else {
        const mark = result.state === 'verified' ? 'PASS' : result.state === 'blocked' ? 'BLOCKED' : 'FAIL';
        io.out(`${mark}  ${result.claim}`);
        for (const reason of result.reasons) io.out(`  - ${reason}`);
      }
      return result.verified ? 0 : 1;
    }

    default: {
      io.err(`Okänt kernel-kommando: ${sub}\n\n${KERNEL_HELP}`);
      return 2;
    }
  }
}

/** `studdy tools` — only tools with a real implementation behind them. */
export async function runToolsCommand({ flags, runtime, io }: Omit<KernelCommandOptions, 'args'>): Promise<number> {
  const invoker = runtime.kernelInvoker();
  const catalog = invoker.catalog();
  const json = flags.json === true;
  if (json) {
    io.out(catalog);
    return 0;
  }
  io.out('Verktyg som workern faktiskt kan köra (behörighet kontrolleras före varje anrop):');
  io.out('');
  for (const tool of catalog) {
    const perm = tool.permission ?? 'ingen';
    io.out(`  ${tool.name.padEnd(18)} ${tool.irreversible ? 'irreversibel' : 'säker'.padEnd(12)}  ${perm}`);
    io.out(`    ${tool.description}`);
  }
  io.out('');
  io.out('Köa arbete: studdy kernel enqueue --kind tool --tool windows.list');
  return 0;
}
