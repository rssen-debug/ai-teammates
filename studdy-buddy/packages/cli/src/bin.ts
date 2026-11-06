#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { openDatabase } from '@studdy/database';
import { LearningService } from '@studdy/learning-engine';
import { buildContext, doctor, status, models, progress, logs, type DoctorReport, type CliContext } from './commands.js';
import { toSpokenText, voiceAvailability } from '@studdy/voice-engine';

/**
 * `studdy` CLI entry point.
 *
 * Exit codes: 0 ok, 1 failure, 2 blocked/unavailable environment.
 * `--json` is available on every command for scripting and CI.
 */

const args = process.argv.slice(2);
const json = args.includes('--json');
const command = args.find((a) => !a.startsWith('-')) ?? 'status';

function out(value: string): void {
  process.stdout.write(`${value}\n`);
}

function heading(text: string): void {
  out(`\n\x1b[1m${text}\x1b[0m`);
}

function colour(status: string, text: string): string {
  const codes: Record<string, string> = { OK: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', BLOCKED: '\x1b[90m' };
  return `${codes[status] ?? ''}${text}\x1b[0m`;
}

function makeContext(): CliContext {
  const dataDir = process.env.STUDDY_DATA_DIR;
  return buildContext((path) => openDatabase(path), dataDir);
}

function renderDoctor(report: DoctorReport): void {
  heading('Studdy Buddy – doktor');
  for (const check of report.checks) {
    out(`  ${colour(check.status, check.status.padEnd(8))} ${check.name.padEnd(22)} ${check.detail}`);
  }
  out('');
  out(
    `  ${report.summary.ok} OK · ${report.summary.warn} varning · ${report.summary.fail} fel · ${report.summary.blocked} blockerade`,
  );
  out(`  Datakatalog: ${report.dataDir}`);
  out(`  Schema: v${report.schemaVersion}`);
}

function run(): number {
  const ctx = makeContext();

  switch (command) {
    case 'doctor': {
      const report = doctor(ctx);
      if (json) out(JSON.stringify(report, null, 2));
      else renderDoctor(report);
      ctx.db?.close();
      return report.summary.fail > 0 ? 1 : report.summary.blocked > 0 ? 2 : 0;
    }

    case 'status': {
      const learning = ctx.db ? new LearningService(ctx.db) : null;
      const report = status(ctx, learning);
      if (json) out(JSON.stringify(report, null, 2));
      else {
        heading('Status');
        out(`  Session:      ${report.session ? report.session.id : 'ingen'}`);
        out(`  Senaste nod:  ${report.session?.lastNodeTitle ?? '–'}`);
        out(`  Meddelanden:  ${report.messages}`);
        out(`  Kurs:         ${report.course ? `${report.course.name} (${report.course.modules} moduler)` : 'ingen discovery gjord'}`);
        out(`  Begrepp:      ${report.learning.tracked} spårade, ${report.learning.mastered} behärskade`);
        out(`  Repetition:   ${report.learning.dueForReview.length ? report.learning.dueForReview.join(', ') : 'inget förfallet'}`);
        out(`  Uppgifter:    ${JSON.stringify(report.tasks)}`);
        out(`  Idag:         ${report.usage.requests} anrop, ${report.usage.estimatedCostUsd.toFixed(4)} USD`);
      }
      ctx.db?.close();
      return 0;
    }

    case 'models': {
      const report = models(ctx);
      if (json) out(JSON.stringify(report, null, 2));
      else {
        heading('Modeller');
        if (!report.provider) out('  Ingen provider konfigurerad.');
        else {
          out(`  Provider:  ${report.provider.name}`);
          out(`  Endpoint:  ${report.provider.baseUrl}`);
          out(`  Modell:    ${report.provider.modelId}`);
          out(`  Vision:    ${report.provider.visionModelId ?? 'ej konfigurerad'}`);
          out(`  Nyckel:    ${report.provider.hasKey ? 'finns' : 'saknas'}`);
          out(`  Funktioner:${report.capabilities ? ' uppmätta' : ' inte uppmätta (kör appens "Testa funktioner")'}`);
        }
        out(`  Idag:      ${report.usage.requests} anrop, ${report.usage.estimatedCostUsd.toFixed(4)} USD`);
      }
      ctx.db?.close();
      return 0;
    }

    case 'progress': {
      const learning = ctx.db ? new LearningService(ctx.db) : null;
      const report = progress(ctx, learning);
      if (json) out(JSON.stringify(report, null, 2));
      else {
        heading('Framsteg');
        if (report.concepts.length === 0) out('  Ingen evidens registrerad ännu.');
        for (const c of report.concepts) {
          out(`  ${c.label.padEnd(24)} ${c.state.padEnd(13)} ${(c.probability * 100).toFixed(0).padStart(3)} %`);
        }
        if (report.due.length) out(`\n  Att repetera: ${report.due.join(', ')}`);
      }
      ctx.db?.close();
      return 0;
    }

    case 'logs': {
      const tail = logs(ctx.dataDir, 80);
      if (json) out(JSON.stringify(tail, null, 2));
      else {
        heading(`Logg (${tail.path})`);
        if (!tail.exists) out('  Ingen loggfil ännu.');
        else for (const line of tail.lines) out(`  ${line}`);
      }
      ctx.db?.close();
      return 0;
    }

    case 'test': {
      // Runs the real unit/integration suite through the project's test runner.
      out('Kör testsviten med vitest…');
      ctx.db?.close();
      const result = spawnSync('npx', ['vitest', 'run'], { stdio: 'inherit', cwd: process.cwd(), shell: process.platform === 'win32' });
      return result.status === 0 ? 0 : 1;
    }

    case 'capture-test': {
      heading('Skärmbildstest');
      if (ctx.platform !== 'win32') {
        out(`  ${colour('BLOCKED', 'BLOCKED')} Skärmfångst kräver Windows och den körande appen.`);
        ctx.db?.close();
        return 2;
      }
      out('  Öppna appen, slå på behörigheten "Skärmbild" och använd verktyget i inställningarna.');
      ctx.db?.close();
      return 2;
    }

    case 'diagnose': {
      const report = doctor(ctx);
      if (json) out(JSON.stringify(report, null, 2));
      else renderDoctor(report);
      if (ctx.db) {
        heading('Diagnostik');
        out(`  Schema: v${ctx.db.migrations.currentVersion}`);
        out(`  Uppgiftskö: ${JSON.stringify(ctx.db.tasks.counts())}`);
        ctx.db.close();
      }
      return report.summary.fail > 0 ? 1 : 0;
    }

    case 'voice-test': {
      heading('Rösttest');
      const availability = voiceAvailability({ voiceSettings: { enabled: true, provider: 'windows-native' } as never, platform: ctx.platform });
      for (const v of availability) {
        out(`  ${v.configured ? colour('OK', 'OK      ') : colour('BLOCKED', 'BLOCKED ')} ${v.label.padEnd(28)} ${v.detail}`);
      }
      heading('Uttalstest');
      out(`  ${toSpokenText('Adressen 192.168.1.1/24 har MAC 00:1A:2B:3C:4D:5E på Gi0/1.', { language: 'sv-SE' })}`);
      ctx.db?.close();
      return 0;
    }

    case 'help':
    default: {
      out(`Studdy Buddy CLI

  studdy doctor        Kontrollera miljö, databas, provider, behörigheter
  studdy status        Aktuell session, kurs och användning
  studdy models        Provider, modell-id och uppmätta funktioner
  studdy progress      Begrepp, skattad kunskap och repetition
  studdy logs          Senaste loggposterna
  studdy test          Kör testsviten
  studdy capture-test  Vägledning för skärmfångsttest (Windows)
  studdy diagnose      Utförlig diagnostik
  studdy voice-test    Röstproviders och uttalstest

Flaggor:
  --json               Maskinläsbar utdata

Miljö:
  STUDDY_DATA_DIR      Datakatalog (annars plattformens standard)`);
      ctx.db?.close();
      return 0;
    }
  }
}

try {
  process.exitCode = run();
} catch (err) {
  process.stderr.write(`studdy: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
