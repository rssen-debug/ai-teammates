#!/usr/bin/env node
/**
 * MAJIN V2 console entry — ties the whole stack into one honest command:
 *   majin-v2 "<objective>" --workspace <dir> [--provider-url <url> --model <m>]
 *   majin-v2 --gauntlet
  majin-v2 --doctor
  majin-v2 --audit-anchor <dir> [--anchor-tsa <rfc3161-url>]
  majin-v2 --audit-verify <dir> --with-anchor --with-tsr [--tsa-ca cafile.pem --tsa-untrusted tsa.crt]
  majin-v2 --audit-export <dir> --out <bundleDir>
  majin-v2 --bundle-verify <bundleDir> [--tsa-ca cafile.pem --tsa-untrusted tsa.crt]
  majin-v2 --models-refresh [--profile opencode-go] / --models [--runner-url http://host:port] [--doctor-whisper-bin <path>] [--port N] | --telemetry-report [dir] [--days N]
 *
 * Exit 0 only when the objective COMPLETED with verified evidence (or the
 * subsidiary command succeeded). Failed goals exit 1. Argparse: node:util
 * parseArgs (zero deps, stable since Node 20).
 */
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { runObjective } from '../src/v2/runtime/orchestrator.js';
import { runWithRecovery } from '../src/v2/recover/outer-loop.js';
import { OpenAICompatibleProvider } from '../src/v2/model/provider.js';
import { TelemetryLedger } from '../src/v2/telemetry/ledger.js';
import { loadConfig } from '../src/v2/config/config.js';
import { resolveProfile } from '../src/v2/model/profiles.js';
import { aggregate, renderReport } from '../src/v2/telemetry/aggregate.js';
import { AuditChain } from '../src/v2/audit/chain.js';
import { keygen as auditKeygen, anchor as auditAnchor, verifyAnchor } from '../src/v2/audit/anchor.js';
import { requestTimestamp, verifyTimestamp } from '../src/v2/audit/timestamp.js';
import { exportBundle, verifyBundle } from '../src/v2/audit/export.js';

const USAGE = `MAJIN V2
  majin-v2 "<objective>" --workspace <dir> [options]
  majin-v2 --gauntlet
  majin-v2 --doctor
  majin-v2 --audit-anchor <dir> [--anchor-tsa <rfc3161-url>]
  majin-v2 --audit-verify <dir> --with-anchor --with-tsr [--tsa-ca cafile.pem --tsa-untrusted tsa.crt]
  majin-v2 --audit-export <dir> --out <bundleDir>
  majin-v2 --bundle-verify <bundleDir> [--tsa-ca cafile.pem --tsa-untrusted tsa.crt]
  majin-v2 --models-refresh [--profile opencode-go] / --models [--runner-url http://host:port] [--doctor-whisper-bin <path>] [--port N]
  majin-v2 --telemetry-report [dir] [--days N]
  majin-v2 --audit-verify <dir> [--with-anchor]
  majin-v2 --audit-keygen <dir>
  majin-v2 --audit-anchor <dir>
  majin-v2 --studio [--port N] [--host H] [--telemetry-dir D] [--audit-dir D] [--enable-writes]
           [--enable-goals --goal-workspace <dir> --profile opencode-go]
           [--enable-voice --voice-dir <dir> --voice-tts buffer|edge --voice-stt-command '<tpl>']

Options:
  --workspace <dir>       where the objective may write (required for objectives)
  --profile <name>        provider preset: opencode-go | opencode-zen | opencode-local
                          (key comes ONLY from env var, e.g. OPENCODE_API_KEY — never args)
  --provider-url <url>    OpenAI-compatible endpoint (e.g. opencode serve)
  --model <id>            model id at that endpoint
  --api-key <key>         optional bearer key
  --planner-model         let the planner role split builds via the model
  --recovery <class>      wrap in the bounded outer recovery loop for that failure class
  --telemetry-dir <dir>   where the JSONL ledger lives (default: <workspace>/telemetry)
  --json                  machine-readable summary
  --days N                telemetry report window (default 7)
`;

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
  options: {
    workspace: { type: 'string' },
    profile: { type: 'string' },
    'provider-url': { type: 'string' },
    model: { type: 'string' },
    'api-key': { type: 'string' },
    'planner-model': { type: 'boolean' },
    recovery: { type: 'string' },
    'telemetry-dir': { type: 'string' },
    gauntlet: { type: 'boolean' },
    doctor: { type: 'boolean' },
    'runner-url': { type: 'string' },
    'doctor-whisper-bin': { type: 'string' },
    'telemetry-report': { type: 'string' },
    'audit-verify': { type: 'string' },
    'with-anchor': { type: 'boolean' },
    'with-tsr': { type: 'boolean' },
    'anchor-tsa': { type: 'string' },
    'audit-export': { type: 'string' },
    out: { type: 'string' },
    'bundle-verify': { type: 'string' },
    'tsa-ca': { type: 'string' },
    'tsa-untrusted': { type: 'string' },
    'audit-keygen': { type: 'string' },
    'audit-anchor': { type: 'string' },
    studio: { type: 'boolean' },
    'enable-writes': { type: 'boolean' },
    'enable-goals': { type: 'boolean' },
    'goal-workspace': { type: 'string' },
    'enable-voice': { type: 'boolean' },
    'voice-dir': { type: 'string' },
    'voice-tts': { type: 'string' },
    'voice-stt-command': { type: 'string' },
    'bundle-dir': { type: 'string' },
    'enable-doctor-panel': { type: 'boolean' },
    'models-refresh': { type: 'boolean' },
    models: { type: 'boolean' },
    port: { type: 'string' },
    host: { type: 'string' },
    'audit-dir': { type: 'string' },
    days: { type: 'string' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  }));
} catch (err) {
  // misuse is exit 2, never a crash — same contract as a missing --workspace
  console.error(`majin-v2: ${err.message}`);
  process.stdout.write(USAGE);
  process.exit(2);
}

async function main() {
  if (values.help || (!values.doctor && !values.gauntlet && !values['telemetry-report'] && values['audit-verify'] === undefined && values['audit-keygen'] === undefined && values['audit-anchor'] === undefined && values['audit-export'] === undefined && values['bundle-verify'] === undefined && !values['models-refresh'] && !values.models && !values.studio && positionals.length === 0)) {
    process.stdout.write(USAGE);
    process.exit(positionals.length || values.help ? 0 : 2);
  }

  if (values.doctor) {
    const { runDoctor, formatDoctor } = await import('../src/v2/ops/doctor.js');
    const result = await runDoctor({
      runnerUrl: values['runner-url'] || null,
      whisperBin: values['doctor-whisper-bin'] || null,
      studioPort: values.port || 4783,
    });
    console.log(formatDoctor(result));
    process.exit(result.verdict === 'NOT_READY' ? 1 : 0);
  }

  if (values.gauntlet) {
    const { runGauntlet } = await import('../src/v2/gauntlet/gauntlet.js');
    const { defaultScenarios } = await import('../src/v2/gauntlet/scenarios.js');
    const { objectiveScenarios } = await import('../src/v2/gauntlet/scenarios-objectives.js');
    const outDir = path.join(process.cwd(), 'docs', 'v2', 'gauntlet');
    const report = await runGauntlet({ scenarios: [...defaultScenarios(), ...objectiveScenarios()], outDir });
    console.log(`gauntlet: ${report.passed}/${report.scenarios} pass, verified ${(report.verifiedSuccessRate * 100).toFixed(0)}%, false success ${report.falseSuccessCount}`);
    process.exit(report.failed === 0 && report.falseSuccessCount === 0 ? 0 : 1);
  }

  if (values['telemetry-report'] !== undefined) {
    const dir = path.resolve(values['telemetry-report'] || process.cwd());
    const rep = aggregate(dir, { lastDays: Number(values.days) || 7 });
    if (values.json) console.log(JSON.stringify(rep, null, 2));
    else process.stdout.write(renderReport(rep));
    process.exit(0);
  }

  if (values['audit-verify'] !== undefined) {
    // independent verifier: fresh AuditChain instance, full walk + anchor check.
    // AUDIT ok | AUDIT broken — no adjectives, machine-parseable (prior-art CLI shape).
    const dir = path.resolve(values['audit-verify']);
    if (!values['audit-verify']) {
      console.error('AUDIT broken LINE=- REASON=USAGE (--audit-verify requires a directory)');
      process.exit(2);
    }
    let verdict;
    try {
      verdict = new AuditChain(dir).verify();
    } catch (err) {
      // constructor-level fork/anchor disagreement is a broken verdict, not a crash
      console.error(`AUDIT broken LINE=- REASON=${err.cls || 'FAILED'} (${err.message})`);
      process.exit(1);
    }
    if (verdict.ok) {
      console.log(`AUDIT ok ENTRIES=${verdict.entries} HEAD=${verdict.head.slice(0, 16)}`);
    } else {
      console.error(`AUDIT broken LINE=${verdict.brokenAt} REASON=${verdict.reason} (${verdict.detail})`);
      process.exit(1);
    }
    if (values['with-anchor']) {
      // external-witness check: catches full-chain rewrites the inner walk cannot
      const av = verifyAnchor(dir);
      console.log(`ANCHOR ${av.cls}${av.fingerprint ? ` FP=${av.fingerprint}` : ''}${av.detail ? ` (${av.detail})` : ''}`);
      if (!av.ok) process.exit(1); // SIG_INVALID / ANCHOR_MISMATCH / CHAIN_BROKEN
    }
    if (values['with-tsr']) {
      // existence-in-time check: proves an anchor predates a moment independent of our clock
      const tv = verifyTimestamp(dir, { caFile: values['tsa-ca'] || null, untrusted: values['tsa-untrusted'] || null });
      console.log(`TSR ${tv.cls}${tv.genTime ? ` TIME="${tv.genTime}"` : ''}${tv.detail ? ` (${tv.detail})` : ''}`);
      if (!tv.ok) process.exit(1); // MISMATCH / UNPARSEABLE / TRUST_FAILED
    }
    process.exit(0);
  }

  if (values['models-refresh']) {
    const { refreshRegistry } = await import('../src/v2/model/registry-refresh.js');
    const { PROVIDER_PROFILES } = await import('../src/v2/model/profiles.js');
    const profile = PROVIDER_PROFILES[values.profile || 'opencode-go'];
    if (!profile) { console.error(`majin-v2: unknown profile ${values.profile}`); process.exit(2); }
    const key = process.env[profile.keyEnv] || '';
    const cache = path.resolve(values['telemetry-dir'] || 'v2-telemetry', 'model-registry.json');
    try {
      const r = await refreshRegistry(cache, { profile, key });
      console.log(`MODELS refreshed count=${r.count} ${r.drift.added.length}added:${r.drift.added.join(',') || '-'} ${r.drift.removed.length}removed:${r.drift.removed.join(',') || '-'} → ${cache}`);
      process.exit(0);
    } catch (err) {
      console.error(`MODELS refresh failed REASON=${err.cls || 'FAILED'} (${err.message})`);
      process.exit(1);
    }
  }

  if (values.models) {
    const { readRegistry } = await import('../src/v2/model/registry-refresh.js');
    const { PROVIDER_PROFILES } = await import('../src/v2/model/profiles.js');
    const profile = PROVIDER_PROFILES[values.profile || 'opencode-go'] || null;
    const cache = path.resolve(values['telemetry-dir'] || 'v2-telemetry', 'model-registry.json');
    const r = readRegistry(cache, { profile });
    if (r.state === 'CACHE_EMPTY' || r.state === 'CACHE_INVALID') {
      console.log(`MODELS ${r.state} (${r.detail})`);
      process.exit(0);
    }
    const hours = r.ageMs == null ? '?' : (r.ageMs / 3600000).toFixed(1);
    console.log(`MODELS ${r.state} count=${r.count} age=${hours}h key=sha256:${r.keyFingerprint}… hash=${String(r.contentHash).slice(0, 12)}…`);
    if (r.drift && (r.drift.added.length || r.drift.removed.length)) {
      console.log(`  drift vs static profile: +[${r.drift.added.join(', ')}] -[${r.drift.removed.join(', ')}]`);
    }
    for (const m of r.models) console.log(`  - ${m}`);
    if (r.state === 'STALE') console.log('  (STALE = honest age flag, not failure — refresh before trusting)');
    process.exit(0);
  }

  if (values['audit-export'] !== undefined) {
    const dir = values['audit-export'];
    const outDir = values.out;
    if (!dir || !outDir) { console.error('majin-v2: --audit-export requires a directory and --out <bundleDir>'); process.exit(2); }
    try {
      const r = exportBundle(path.resolve(dir), path.resolve(outDir));
      console.log(`AUDIT bundle OK files=${r.files} entries=${r.stats.entries} anchors=${r.stats.anchors} tsr=${r.stats.tsr} → ${outDir}`);
      process.exit(0);
    } catch (err) {
      console.error(`AUDIT export failed REASON=${err.cls || 'FAILED'} (${err.message})`);
      process.exit(1);
    }
  }

  if (values['bundle-verify'] !== undefined) {
    const dir = values['bundle-verify'];
    if (!dir) { console.error('majin-v2: --bundle-verify requires a directory'); process.exit(2); }
    const v = verifyBundle(path.resolve(dir), { tsrOpts: { caFile: values['tsa-ca'] || null, untrusted: values['tsa-untrusted'] || null } });
    console.log(`BUNDLE ${v.cls}${v.detail ? ` (${v.detail})` : ''}`);
    process.exit(v.ok ? 0 : 1);
  }

  if (values['audit-keygen'] !== undefined) {
    const dir = values['audit-keygen'];
    if (!dir) { console.error('majin-v2: --audit-keygen requires a directory'); process.exit(2); }
    const r = auditKeygen(path.resolve(dir));
    console.log(r.created ? `AUDIT keygen OK fingerprint=${r.fingerprint} (private key 0600, verifier needs only the public key)` : `AUDIT keygen refused: ${r.note}`);
    process.exit(r.created ? 0 : 1);
  }

  if (values['audit-anchor'] !== undefined) {
    const dir = values['audit-anchor'];
    if (!dir) { console.error('majin-v2: --audit-anchor requires a directory'); process.exit(2); }
    try {
      const rec = auditAnchor(path.resolve(dir));
      console.log(`AUDIT anchored SEQ=${rec.chainSeq} HEAD=${rec.chainHead.slice(0, 16)} ASEq=${rec.aseq} FP=${rec.fingerprint}`);
      if (values['anchor-tsa']) {
        // deliberate, operator-driven trusted timestamp of the anchor just made
        const t = await requestTimestamp(path.resolve(dir), values['anchor-tsa']);
        console.log(`AUDIT timestamped ASEq=${t.aseq} TIME="${t.genTime}" BYTES=${t.bytes} (${t.url})`);
      }
      process.exit(0);
    } catch (err) {
      console.error(`AUDIT anchor failed REASON=${err.cls || 'FAILED'} (${err.message})`);
      process.exit(1);
    }
  }

    if (values.studio) {
    const { createStudioServer } = await import('../src/v2/studio/server.js');
    const { EventBus } = await import('../src/v2/runtime/events.js');
    const bus = new EventBus();
    const telemetryDir = path.resolve(values['telemetry-dir'] || 'telemetry');
    const auditDir = path.resolve(values['audit-dir'] || 'audit');
    let approvals = null;
    let auditBind = null;
    let goalOpts = null;
    let voiceOpts = null;
    if (values['enable-voice']) {
      if (!values['voice-dir']) { console.error('majin-v2: --enable-voice requires --voice-dir <dir>'); process.exit(2); }
      const voiceDir = path.resolve(values['voice-dir']);
      const ttsKind = values['voice-tts'] || 'buffer';
      let tts = null;
      if (ttsKind === 'buffer') {
        const { BufferTtsProvider } = await import('../src/v2/voice/tts.js');
        tts = new BufferTtsProvider();
      } else if (ttsKind === 'edge') {
        const { EdgeTtsProvider } = await import('../src/v2/voice/tts.js');
        tts = new EdgeTtsProvider({});
      } else { console.error(`majin-v2: unknown --voice-tts '${ttsKind}' (buffer|edge)`); process.exit(2); }
      let stt = null;
      if (values['voice-stt-command']) {
        const { CommandSttProvider } = await import('../src/v2/voice/stt.js');
        stt = new CommandSttProvider({ commandTemplate: values['voice-stt-command'] });
      }
      voiceOpts = { outDir: voiceDir, tts, stt };
    }
    if (values['enable-goals']) {
      if (!values['goal-workspace']) { console.error('majin-v2: --enable-goals requires --goal-workspace <dir> (runs may only write to an operator-fixed workspace)'); process.exit(2); }
      const { resolveProfile } = await import('../src/v2/model/profiles.js');
      const { OpenAICompatibleProvider } = await import('../src/v2/model/provider.js');
      let provider = null;
      if (values.profile) {
        try {
          const r = resolveProfile(values.profile, { baseUrl: values['provider-url'] || null, model: values.model || null });
          provider = new OpenAICompatibleProvider({ name: r.name, baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, extraHeaders: r.extraHeaders });
        } catch (err) { console.error(`majin-v2: ${err.message}`); process.exit(2); }
      }
      goalOpts = { workspaceDir: path.resolve(values['goal-workspace']), provider };
    }
    if (values['enable-writes'] || values['enable-goals']) {
      // consent write surface: real Approvals as the only authority, every
      // decision mirrored into the tamper-evident chain via the real bus
      const { Approvals } = await import('../src/v2/safety/approvals.js');
      const { AuditChain } = await import('../src/v2/audit/chain.js');
      const { AuditBind } = await import('../src/v2/audit/bind.js');
      approvals = new Approvals(bus);
      auditBind = new AuditBind(new AuditChain(auditDir));
      auditBind.attach(bus);
    }
    const studio = createStudioServer({ bus, telemetryDir, auditDir, approvals, enableWrites: !!values['enable-writes'], enableGoals: goalOpts, voice: voiceOpts, enableBundle: values['bundle-dir'] ? { dir: path.resolve(values['bundle-dir']) } : null, enableDoctor: values['enable-doctor-panel'] ? { runnerUrl: values['runner-url'] || null, whisperBin: values['doctor-whisper-bin'] || null, studioPort: values.port || 0 } : null });
    const bound = await studio.listen({ port: Number(values.port) || 0, host: values.host || '127.0.0.1' });
    console.log(`MAJIN V2 Studio ${goalOpts ? '(goal runs ENABLED — every run consumes a studio:run-goals grant; workspace ' + goalOpts.workspaceDir + (goalOpts.provider ? ', provider ' + goalOpts.provider.name : '' ) + ')' : values['enable-writes'] ? '(consent writes ENABLED — every grant/revoke audit-chained)' : '(read-only scaffold)'} at ${bound.url}`);
    console.log(`observing: telemetry=${telemetryDir} audit=${auditDir}`);
    const shutdown = async () => { auditBind?.detach(); await studio.close(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return; // server keeps the loop alive — no exit call
  }

  const objective = positionals.join(' ').trim();
  if (!objective) { console.error('empty objective'); process.exit(2); }
  if (!values.workspace) { console.error('--workspace is required (honest destination, never implicit)'); process.exit(2); }

  const workspaceDir = path.resolve(values.workspace);
  const { config, warnings } = loadConfig(workspaceDir);
  for (const w of warnings) console.error(`config warning: ${w}`);

  const provider = values.profile
    ? (() => {
        try {
          const r = resolveProfile(values.profile, { baseUrl: values['provider-url'] || null, model: values.model || null });
          console.error(`provider: profile ${r.name} → ${r.baseUrl} model=${r.model}` + (r.keyHash ? ` key=${r.keyRef} sha256:${r.keyHash}` : ' (no key needed)'));
          return new OpenAICompatibleProvider({ name: r.name, baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, extraHeaders: r.extraHeaders });
        } catch (err) {
          console.error(`majin-v2: ${err.message}`);
          process.exit(2); // misconfiguration is misuse — honest exit 2, zero network traffic
        }
      })()
    : values['provider-url']
    ? new OpenAICompatibleProvider({
        name: 'cli-provider', baseUrl: values['provider-url'],
        apiKey: values['api-key'] || null, model: values.model || 'default',
      })
    : null;

  const telemetry = new TelemetryLedger(values['telemetry-dir'] ? path.resolve(values['telemetry-dir']) : path.join(workspaceDir, 'telemetry'));
  const opts = {
    workspaceDir, provider, telemetry,
    plannerWithModel: !!values['planner-model'] || config.model.plannerWithModel,
  };
  const summary = values.recovery
    ? await runWithRecovery(objective, { failureClass: values.recovery, ...opts })
    : await runObjective(objective, opts);

  const goal = summary.goal || { state: summary.finalState };
  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`goal:     ${goal.state}`);
    console.log(`compiler: ${summary.compiler?.source || '-'}${summary.compiler?.fallbackFrom ? ` (fallback: ${summary.compiler.fallbackFrom})` : ''}`);
    console.log(`planner:  ${summary.planner?.source || '-'}`);
    console.log(`produced: ${(summary.produced || []).join(', ') || '-'}`);
    console.log(`verified: ${(summary.verification || []).filter((v) => v.verified).length}/${(summary.verification || []).length} acceptance points`);
    if (summary.attempts) console.log(`attempts: ${summary.attempts} (recovered: ${summary.recovered})`);
    if (summary.reason) console.log(`reason:   ${summary.reason}`);
    console.log(`ledger:   ${telemetry.dir}`);
  }
  process.exit(goal.state === 'COMPLETED' ? 0 : 1);
}

main().catch((err) => { console.error(`majin-v2 fatal: ${err.message || err}`); process.exit(2); });
