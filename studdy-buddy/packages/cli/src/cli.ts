import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { StuddyRuntime, summarizeSnapshot, SpeechPlayer, proveLive, type RuntimeOptions } from '@studdy/core';
import { maskKey } from '@studdy/ai-router';
import { voiceSettingsSchema, type ProviderConfig } from '@studdy/shared';
import { box, dots, palette, statusLine, supportsColor } from './theme.js';

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
  color?: boolean;
  stdin?: NodeJS.ReadableStream;
}
export interface CliOptions extends RuntimeOptions { cwd?: string; version?: string; openUrl?: (url: string) => Promise<void>; }
const CLI_FLAGS = {
  json: { type: 'boolean' as const }, 'no-color': { type: 'boolean' as const },
  'key-stdin': { type: 'boolean' as const }, 'token-stdin': { type: 'boolean' as const },
  yes: { type: 'boolean' as const }, enable: { type: 'boolean' as const },
  port: { type: 'string' as const }, 'base-url': { type: 'string' as const },
  model: { type: 'string' as const }, 'vision-model': { type: 'string' as const },
  name: { type: 'string' as const }, duration: { type: 'string' as const },
  once: { type: 'boolean' as const }, stdin: { type: 'boolean' as const },
  app: { type: 'string' as const }, 'no-write': { type: 'boolean' as const },
  headed: { type: 'boolean' as const },
  version: { type: 'boolean' as const, short: 'v' }, help: { type: 'boolean' as const, short: 'h' },
};

const PRESETS: Record<string, { id: string; name: string; baseUrl: string; modelId: string }> = {
  kilo: { id: 'kilo', name: 'Kilo Gateway', baseUrl: 'https://ai-gateway.kilo.ai/api/v1', modelId: 'kilo-auto/free' },
  deepseek: { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-flash' },
  openrouter: { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelId: 'openrouter/auto' },
  opencode: { id: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', modelId: 'deepseek-v4-flash-free' },
};

export const HELP = `${dots(false)}  Studdy Buddy CLI

Användning:
  studdy                         Interaktiv chatt + live-status
  studdy ask "förklara varför…"  Engångsfråga till din AI
  studdy repl                    Kör chattsekvens från stdin (scriptbart)
  studdy setup                   Full åtkomst + guide för AI-nyckel
  studdy provider set <preset|custom> --key-stdin [--base-url URL --model ID]
  studdy provider test | probe   Live-test / uppmätta modellförmågor
  studdy status                  Kompakt dashboard
  studdy doctor                  Lokal hälsokontroll
  studdy prove [--app "App"]     Bevisa live: starta, läs, skriv, skärmbild
  studdy open "Google Chrome"    Starta valfri app, verifierat
  studdy apps | windows          Lista appar/fönster
  studdy snapshot <window-id>    Läs UI-träd med ref:er
  studdy screenshot <id> <fil>   Spara skärmbild (med permission)
  studdy see <id> "fråga"        Skärmbild + UIA + visionmodell
  studdy click <ref>             Klicka observerad UI-ref
  studdy type <ref> "text" [--headed]  Skriv i fält (Windows kräver --headed)
  studdy set-value <ref> "text"  Sätt värde semantiskt (headless)
  studdy press <combo> [id]      Tangenttryck, t.ex. ctrl+s
  studdy focus <window-id>       Fokusera fönster
  studdy watch [--once --duration S]  Live-dashboard, uppdateras på plats
  studdy bridge [--port N]       Starta webbläsar-brygga + skriv token
  studdy sites [allow <host>]    Tillåtna/väntande webbsidor
  studdy gmail connect <id>      Anslut Gmail med OAuth/PKCE
  studdy gmail list [sökfråga]   Läs inbox
  studdy github configure owner/repo --token-stdin --enable
  studdy github sync             Publicera redigerad debugjournal
  studdy memory                  Skriv/synka Obsidian-minne
  studdy progress | readiness    Lärande och readiness
  studdy history | logs          Historik / bounded logg
  studdy voice "text"            Lokal uppläsning (Windows/macOS/Linux)
  studdy models                  Providerprofil
  studdy reset --yes             Rensa lokal chatthistorik

Miljö:
  STUDDY_DATA_DIR                Lokal datakatalog
  STUDDY_AGENT_DESKTOP_BINARY    Override för native helper
  STUDDY_API_KEY                 Engångsnyckel (hellre --key-stdin)
  NO_COLOR                       Stäng av ANSI-färger

Nycklar tas aldrig som argument. Använd --key-stdin eller interactive prompt.
`;

export async function runCli(argv: string[], io: CliIO, options: CliOptions = {}): Promise<number> {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: CLI_FLAGS, allowPositionals: true, strict: true }); }
  catch (error) { io.err(error instanceof Error ? error.message : String(error)); return 2; }
  const flags = parsed.values;
  const positional = parsed.positionals;
  const option = (name: string): string | undefined => { const v = flags[name as keyof typeof flags]; return typeof v === 'string' ? v : undefined; };
  const json = flags.json === true;
  const color = flags['no-color'] ? false : (io.color ?? supportsColor());
  const command = flags.version ? 'version' : flags.help ? 'help' : positional[0] ?? 'help';
  const out = (value: unknown) => io.out(json ? JSON.stringify(value, null, 2) : typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  if (command === 'help') { io.out(HELP); return 0; }
  if (command === 'version') { out({ version: options.version ?? '0.2.0' }); return 0; }
  const runtime = new StuddyRuntime({ ...options, openUrl: options.openUrl ?? (async (url: string): Promise<void> => {
    if (new URL(url).hostname === 'accounts.google.com') io.out('Öppna denna inloggningslänk i din webbläsare:\n' + url);
    const { openExternal } = await import('@studdy/core');
    try { await openExternal(url); } catch { io.err('Kunde inte öppna webbläsaren automatiskt. Använd länken eller filen ovan.'); }
  }) });
  const p = palette(color);
  try {
    switch (command) {
      case 'help': io.out(HELP); return 0;
      case 'version': out({ version: options.version ?? '0.2.0' }); return 0;
      case 'setup': {
        const changed = runtime.configureFullAccess();
        const provider = runtime.services.activeProvider();
        const native = await runtime.nativeStatus();
        io.out(box('Setup', [
          statusLine('Full åtkomst', true, color, changed ? 'beviljad en gång' : 'redan konfigurerad, respekterar återkallelser'),
          statusLine('Native helper', native.available, color, native.detail),
          '', 'Lägg till AI-nyckel utan att lämna den i shell-historiken:',
          p.mint('  studdy provider set kilo --key-stdin'),
          p.dim('  eller: deepseek | openrouter | opencode'),
          '', `Provider: ${provider ? provider.name + (provider.hasApiKey ? ' · nyckel sparad' : ' · nyckel saknas') : 'ingen konfigurerad'}`,
        ], color));
        return 0;
      }
      case 'provider': {
        const sub = positional[1];
        if (sub === 'set') {
          const presetName = positional[2] ?? '';
          const preset = presetName === 'custom' ? { id: 'custom', name: option('name') ?? 'Egen provider', baseUrl: option('base-url') ?? '', modelId: option('model') ?? '' } : PRESETS[presetName];
          if (!preset) { io.err(`Okänd preset. Välj ${Object.keys(PRESETS).join(', ')}, custom.`); return 2; }
          const key = flags['key-stdin'] ? await readAll(io.stdin ?? process.stdin) : process.env.STUDDY_API_KEY;
          if (!key?.trim()) { io.err('Ingen nyckel. Skicka via --key-stdin eller STUDDY_API_KEY.'); return 2; }
          const saved = runtime.services.saveProvider({ ...preset, baseUrl: option('base-url') ?? preset.baseUrl, modelId: option('model') ?? preset.modelId, visionModelId: option('vision-model') ?? null, apiKey: key.trim() });
          if (!saved.ok) { io.err(saved.error.message); return 1; }
          out({ ok: true, provider: preset.id, key: maskKey(key.trim()) });
          return 0;
        }
        if (sub === 'test') {
          const result = await runtime.services.testProvider();
          out(result); return result.ok && result.data.ok ? 0 : 1;
        }
        if (sub === 'probe') {
          const result = await runtime.services.probeCapabilities();
          out(result); return result.ok ? 0 : 1;
        }
        if (sub === 'list') { out(runtime.services.activeProvider()); return 0; }
        io.err('Använd provider set|test|probe|list.'); return 2;
      }
      case 'status': {
        const live = await runtime.observer.tick();
        const provider = runtime.services.activeProvider();
        const native = await runtime.nativeStatus();
        const snapshot = runtime.services.learning.snapshot();
        const ledger = runtime.ledger().details();
        const bridge = await runtime.probeBridge();
        const data = { live, provider, native, learning: snapshot, ledger, bridge, dataDir: runtime.dataDir };
        if (json) { out(data); return 0; }
        io.out(box(`${dots(color)}  Studdy Buddy`, [
          statusLine('AI', Boolean(provider?.hasApiKey), color, provider ? `${provider.name} · ${provider.modelId}` : 'ingen provider · studdy setup'),
          statusLine('Live', live.observing, color, live.observing ? `${live.windowTitle} · ${live.elementCount} element` : live.activity),
          statusLine('Datorstyrning', native.available && runtime.services.permissions.isGranted('computer.actions'), color, native.detail),
          statusLine('Webbläsare', bridge.running, color, `${runtime.services.siteAllowList().length} tillåtna sidor`),
          statusLine('Minne', existsSync(join(runtime.dataDir, 'Obsidian-Vault')), color, runtime.dataDir),
          '', `${p.violet('Nivå ' + ledger.level)}  ${p.dim(ledger.verified + ' verifierade skills')}  ${p.dim(snapshot.concepts.length + ' begrepp')}`,
        ], color));
        return 0;
      }
      case 'doctor': {
        const native = await runtime.nativeStatus();
        const provider = runtime.services.activeProvider();
        const checks = [
          { name: 'Node', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version, blocked: false },
          { name: 'Databas', ok: true, detail: runtime.databasePath(), blocked: false },
          { name: 'Native helper', ok: native.available, detail: native.detail, blocked: !native.available },
          { name: 'AI-nyckel', ok: Boolean(provider?.hasApiKey), detail: provider?.hasApiKey ? 'sparad i lokalt valv' : 'saknas · studdy setup', blocked: false },
          { name: 'Full åtkomst', ok: runtime.services.permissions.isGranted('computer.actions'), detail: runtime.services.permissions.isGranted('computer.actions') ? 'beviljad lokalt; OS-behörigheter rapporteras separat' : 'kör studdy setup', blocked: false },
        ];
        if (json) { out({ checks }); return checks.some(c => !c.ok && !c.blocked) ? 1 : 0; }
        io.out(box('Doctor', checks.map(c => statusLine(c.name, c.ok, color, c.detail)), color));
        return checks.some(c => !c.ok && !c.blocked) ? 1 : 0;
      }
      case 'prove': {
        const proof = await proveLive(runtime, { app: option('app'), noWrite: flags['no-write'] === true });
        if (json) { out(proof); return proof.ok ? 0 : 1; }
        io.out(box('Live-bevis på din dator', [
          ...proof.steps.map(s => statusLine(s.name, s.status === 'pass', color, (s.status === 'blocked' ? 'BLOCKED · ' : s.status === 'skipped' ? 'SKIP · ' : s.status === 'fail' ? 'FEL · ' : '') + s.detail)),
          '', proof.ok ? p.mint('✓ Live verifierat med riktiga verktygssvar.') : p.amber('○ Inte fullt live ännu — se BLOCKED/FEL ovan.'),
        ], color));
        return proof.ok ? 0 : 1;
      }
      case 'open': case 'launch': {
        const name = positional.slice(1).join(' ').trim();
        if (!name) { io.err('Ange appnamn, t.ex. studdy open "Google Chrome".'); return 2; }
        const result = await runtime.launchApp(name);
        out(result); return result.ok ? 0 : 1;
      }
      case 'apps': { const r = await runtime.adapter.listApps(); out(r); return r.error ? 1 : 0; }
      case 'windows': { const r = await runtime.adapter.listWindows(); out(r); return r.error ? 1 : 0; }
      case 'snapshot': {
        if (!runtime.services.permissions.check('observe', ['application.observe']).allowed) { io.err('Observation är avstängd. Kör studdy setup.'); return 1; }
        const id = positional[1];
        if (!id) { io.err('Ange window-id från studdy windows.'); return 2; }
        const snap = await runtime.adapter.snapshot(id);
        out(json ? snap : summarizeSnapshot(snap)); return snap.accessible ? 0 : 1;
      }
      case 'screenshot': {
        const r = await runtime.screenshot(positional[1] ?? '', positional[2] ?? 'studdy-screen.png');
        out(r); return r.ok ? 0 : 1;
      }
      case 'see': {
        const r = await runtime.see(positional[1] ?? '', positional.slice(2).join(' ') || 'Vad ser du?');
        out(r); return r.ok ? 0 : 1;
      }
      case 'click': case 'type': case 'set-value': case 'press': case 'focus': {
        const r = await runtime.computerAction(command, positional.slice(1), { headed: flags.headed === true });
        out(r); return r.ok ? 0 : 1;
      }
      case 'repl': {
        const { runInteractive } = await import('./interactive.js');
        await runInteractive({ ...options, input: io.stdin, output: { write: (text: string) => io.out(text) } });
        return 0;
      }
      case 'ask': case 'chat': {
        const question = flags.stdin ? await readAll(io.stdin ?? process.stdin) : positional.slice(1).join(' ').trim();
        if (!question) { io.err('Skriv en fråga: studdy ask "varför…?"'); return 2; }
        const result = await runtime.chat(question);
        if (!result.ok) { io.err(result.error.message); return 1; }
        out(json ? result.data : result.data.message.text);
        return result.data.degraded ? 1 : 0;
      }
      case 'watch': {
        const seconds = flags.once ? 0 : option('duration') === undefined ? Infinity : Number(option('duration'));
        if (!Number.isFinite(seconds) || seconds < 0) { io.err('Ange --duration i sekunder (0 eller större).'); return 2; }
        runtime.observer.start();
        const render = () => {
          const s = runtime.liveStatus();
          if (json) out(s);
          else io.out(box(`${dots(color)}  Live`, [statusLine(s.observing ? 'Observerar' : 'Väntar', s.observing, color, s.windowTitle ?? s.activity), p.dim(`${s.elementCount} element · nivå ${s.level} · Ctrl+C avslutar`)], color));
        };
        await new Promise(resolve => setTimeout(resolve, 200));
        render();
        if (flags.once || seconds === 0) return runtime.liveStatus().observing ? 0 : 1;
        await new Promise<void>(resolve => {
          const stop = () => { clearInterval(timer); clearTimeout(limit); resolve(); };
          const timer = setInterval(render, 2500);
          const limit = setTimeout(stop, seconds * 1000);
          process.once('SIGINT', stop);
        });
        return 0;
      }
      case 'bridge': {
        const port = option('port') === undefined ? undefined : Number(option('port'));
        if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) { io.err('Ogiltig port (0–65535).'); return 2; }
        const { status, token } = await runtime.startBridge(port);
        if (!status.running) { io.err(status.detail); return 1; }
        if (json) out({ ...status, token });
        else io.out(box('Browser bridge', [
          statusLine('Loopback WebSocket', true, color, `ws://${status.host}:${status.port}`),
          '', 'Token (klistra in i Studdy-tillägget):', p.mint(token),
          '', p.dim('Endast tillåtna sidor läses. Ctrl+C avslutar.'),
        ], color));
        await new Promise<void>(resolve => process.once('SIGINT', () => resolve()));
        return 0;
      }
      case 'sites': {
        if (positional[1] === 'allow' && positional[2]) { out({ allowed: runtime.allowSite(positional[2]) }); return 0; }
        out({ allowed: runtime.services.siteAllowList(), pending: runtime.pendingSites(), bridge: await runtime.probeBridge() }); return 0;
      }
      case 'gmail': {
        const sub = positional[1];
        if (sub === 'connect') {
          const id = positional[2];
          if (!id) { io.err('Ange Google OAuth client-id.'); return 2; }
          const r = await runtime.gmail.connect(id); out(r); return r.connected ? 0 : 1;
        }
        if (sub === 'list') { const r = await runtime.inboxResult(positional.slice(2).join(' ') || undefined); out(r); return r.ok ? 0 : 1; }
        if (sub === 'disconnect') { await runtime.gmail.disconnect(); out({ ok: true }); return 0; }
        out(runtime.gmail.status()); return 0;
      }
      case 'github': {
        const sub = positional[1];
        if (sub === 'configure') {
          const token = flags['token-stdin'] ? (await readAll(io.stdin ?? process.stdin)).trim() : undefined;
          out(runtime.github.configure({ repository: positional[2] ?? '', token, enabled: flags.enable === true })); return 0;
        }
        if (sub === 'sync') { const r = await runtime.github.publish(); out(r); return r.ok ? 0 : 1; }
        if (sub === 'report') { io.out(runtime.github.report()); return 0; }
        out(runtime.github.status()); return 0;
      }
      case 'memory': { out({ path: runtime.syncMemory() }); return 0; }
      case 'progress': out({ learning: runtime.services.learning.snapshot(), skills: runtime.ledger().details() }); return 0;
      case 'readiness': out(runtime.services.readiness()); return 0;
      case 'history': out(runtime.services.history()); return 0;
      case 'logs': {
        const path = join(runtime.dataDir, 'studdy.log');
        io.out(existsSync(path) ? readFileSync(path, 'utf8') : 'Ingen logg ännu.'); return 0;
      }
      case 'voice': {
        const text = positional.slice(1).join(' ');
        const player = new SpeechPlayer();
        const r = await player.speak(text, voiceSettingsSchema.parse({ enabled: true, provider: 'windows-native' }));
        out(r); return r.ok ? 0 : 1;
      }
      case 'models': out(runtime.services.activeProvider()); return 0;
      case 'reset': {
        if (!flags.yes === true) { io.err('Detta rensar lokal chatthistorik. Kör studdy reset --yes.'); return 2; }
        runtime.services.resetChat(); out({ ok: true }); return 0;
      }
      case 'test': {
        const cwd = options.cwd ?? process.cwd();
        return await new Promise<number>(resolve => {
          const child = spawn(process.execPath, [join(cwd, 'node_modules', 'vitest', 'vitest.mjs'), 'run'], { cwd, stdio: 'inherit', shell: false });
          child.on('exit', c => resolve(c ?? 1));
        });
      }
      default: io.err(`Okänt kommando: ${command}\n\n${HELP}`); return 2;
    }
  } catch (error) {
    runtime.journal.record('cli.' + command, error);
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await runtime.close();
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

export type { ProviderConfig };
