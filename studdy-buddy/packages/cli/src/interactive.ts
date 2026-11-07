import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import { StuddyRuntime, type RuntimeOptions } from '@studdy/core';
import { box, dots, palette, statusLine, supportsColor } from './theme.js';

export interface InteractiveOptions extends RuntimeOptions { version?: string; input?: NodeJS.ReadableStream; output?: { write(text: string): unknown }; }
export async function runInteractive(options: InteractiveOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = (text: string) => output.write(text + '\n');
  const terminal = Boolean((input as NodeJS.ReadStream).isTTY);
  const runtime = new StuddyRuntime(options);
  const color = supportsColor(process.env, { isTTY: terminal });
  const p = palette(color);
  const rl = readline.createInterface({ input, output: output as NodeJS.WritableStream, terminal });
  // Install line handlers before the first await: a pipe can deliver its whole
  // script and EOF while nativeStatus() is still running.
  const lines: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  let closed = false;
  rl.on('line', line => { if (waiting) { const resolve = waiting; waiting = null; resolve(line); } else lines.push(line); });
  rl.on('close', () => { closed = true; if (waiting) { const resolve = waiting; waiting = null; resolve(null); } });
  const nextLine = (): Promise<string | null> => lines.length ? Promise.resolve(lines.shift()!) : closed ? Promise.resolve(null) : new Promise(resolve => { waiting = resolve; });
  const changed = runtime.configureFullAccess();
  const provider = runtime.services.activeProvider();
  const native = await runtime.nativeStatus();
  log(box(`${dots(color)}  Studdy Buddy`, [
    statusLine('Full åtkomst', true, color, changed ? 'beviljad' : 'tidigare konfigurerad'),
    statusLine('AI', Boolean(provider?.hasApiKey), color, provider?.hasApiKey ? `${provider.name} · ${provider.modelId}` : 'Anslut med /api'),
    statusLine('Native helper', native.available, color, native.detail),
    '', p.dim('Skriv ett meddelande eller /api · /models · /status · /help'),
  ], color));
  if (runtime.services.permissions.isGranted('application.observe')) runtime.observer.start();
  let lastState = runtime.liveStatus().state;
  const timer = setInterval(() => {
    const s = runtime.liveStatus();
    if (s.state !== lastState) {
      lastState = s.state;
      log(p.dim(`● live: ${s.observing ? s.windowTitle : s.activity}`));
      rl.prompt(true);
    }
  }, 1000);
  rl.setPrompt(p.mint('du › '));
  rl.prompt();
  // readline's async iterator pauses after each yield. Mixing it with nested
  // rl.question() and background prompts can leave a piped REPL permanently
  // paused. An explicit queue keeps input flowing across awaits and EOF.
  for (;;) {
    const line = await nextLine();
    if (line === null) break;
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === '/exit' || text === '/quit') break;
    try {
      if (text === '/help') {
        log('Chatt: skriv som vanligt.\n/api  Anslut AI-nyckel\n/models  Se provider och modell\n/model <modell-id>  Byt modell utan att skriva in nyckeln igen\n/status  Live-status\n/prove  Testa datorstyrning i Anteckningar\n/open <app>  Öppna program\n/windows  Lista fönster\n/snapshot <id>  Läs fönster\n/progress  Skills\n/memory  Minne\n/bridge  Webbläsarkoppling\n/exit  Avsluta');
      } else if (text === '/status') {
        await runtime.observer.tick();
        const s = runtime.liveStatus();
        const ledger = runtime.ledger().details();
        log(box('Status', [
          statusLine('Live', s.observing, color, s.windowTitle ?? s.activity),
          statusLine('AI', Boolean(runtime.services.activeProvider()?.hasApiKey), color),
          `Nivå ${ledger.level} · ${ledger.verified} verifierade skills`,
        ], color));
      } else if (text === '/models') {
        const active = runtime.services.activeProvider();
        log(active ? `Aktiv: ${active.name} · ${active.modelId} · ${active.hasApiKey ? 'API-nyckel sparad' : 'saknar nyckel'}\nByt: /model <modell-id> · Byt tjänst/nyckel: /api` : 'Ingen AI ansluten. Skriv /api och välj en tjänst.');
      } else if (text.startsWith('/model ')) {
        const modelId = text.slice(7).trim();
        if (!modelId || /[\\r\\n]/.test(modelId) || modelId.length > 180) { log(p.amber('Ange ett giltigt modell-id.')); }
        else {
          const active = runtime.services.activeProvider();
          if (!active) log(p.amber('Anslut AI först med /api.'));
          else {
            const updated = runtime.services.saveProvider({ id: active.id, modelId });
            log(updated.ok ? p.mint(`Modell vald: ${modelId}. Använd /api om du behöver byta nyckel.`) : p.red(updated.error.message));
          }
        }
      } else if (text === '/api' || text === '/setup') {
        log('Välj tjänst: kilo / deepseek / openrouter / opencode (eller skriv avbryt)');
        output.write('Tjänst › ');
        const preset = ((await nextLine()) ?? '').trim().toLowerCase();
        if (preset === 'avbryt' || !preset) { log('Avbrutet.'); }
        else if (!['kilo', 'deepseek', 'openrouter', 'opencode'].includes(preset)) log(p.amber('Okänd tjänst. Skriv /api och välj från listan.'));
        else {
          const key = await secret(rl, nextLine, 'API-nyckel (dold): ', output, terminal);
          if (!key.trim()) log('Ingen nyckel sparades.');
          else {
            const { runCli } = await import('./cli.js');
            const code = await runCli(['provider', 'set', preset, '--key-stdin', '--no-color'], { out: log, err: log, color: false, stdin: Readable.from([key]) }, options);
            if (code === 0) log(p.mint('AI-anslutning sparad. Testa den genom att skriva ett meddelande.'));
          }
        }
      } else if (text === '/prove') {
        const proof = await (await import('@studdy/core')).proveLive(runtime, { app: process.platform === 'win32' ? 'Notepad' : undefined });
        log(box('Datorstyrning', [...proof.steps.map(step => `${step.status === 'pass' ? '●' : '○'} ${step.name}: ${step.detail}`), proof.ok ? p.mint('Verifierad') : p.amber('Inte verifierad – se status ovan')], color));
      } else if (modelRequest(text)) {
        const modelId = modelRequest(text)!;
        const active = runtime.services.activeProvider();
        if (!active) log(p.amber('Anslut en AI-tjänst med /api först.'));
        else {
          const updated = runtime.services.saveProvider({ id: active.id, modelId });
          log(updated.ok
            ? p.mint(`Bytte till ${modelId}. Valet är sparat och används nästa meddelande.`)
            : p.red(updated.error.message));
        }
      } else if (text.startsWith('/open ')) {
        const r = await runtime.launchApp(text.slice(6));
        log(r.ok ? p.mint('✓ ' + r.detail) : p.amber('○ ' + r.detail));
      } else if (text === '/windows') {
        const r = await runtime.adapter.listWindows();
        log(r.error ?? r.windows.map(w => `${w.id}  ${w.title}`).join('\n'));
      } else if (text.startsWith('/snapshot ')) {
        const snap = await runtime.adapter.snapshot(text.slice(10).trim());
        log(snap.accessible ? snap.elements.filter(e => e.name || e.value).slice(0, 30).map(e => `${e.ref} ${e.role}: ${e.name || e.value}`).join('\n') : snap.note ?? 'Ingen tillgänglig snapshot.');
      } else if (text === '/memory') log(runtime.syncMemory());
      else if (text === '/progress') log(JSON.stringify(runtime.services.progress(), null, 2));
      else if (text === '/bridge') {
        const h = await runtime.startBridge();
        log(h.status.running ? `ws://${h.status.host}:${h.status.port}\nToken: ${h.token}` : h.status.detail);
      } else if (text.startsWith('/')) log('Okänt kommando. /help');
      else {
        const result = await runtime.chat(text);
        if (result.ok) log(p.violet('studdy › ') + result.data.message.text);
        else log(p.red(result.error.message));
        if (!result.ok || result.data.degraded) runtime.journal.record('cli.chat', result.ok ? result.data.error ?? 'provider failed' : result.error.message, 'warn');
      }
    } catch (error) {
      runtime.journal.record('cli.interactive', error);
      log(p.red('Fel: ') + (error instanceof Error ? error.message : String(error)));
    }
    rl.prompt();
  }
  clearInterval(timer);
  await runtime.close();
  rl.close();
}

function secret(rl: readline.Interface, nextLine: () => Promise<string | null>, prompt: string, output: { write(text: string): unknown }, terminal: boolean): Promise<string> {
  return new Promise(resolve => {
    output.write(prompt);
    const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
    const rawBefore = Boolean((stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);
    if (terminal && stdin.setRawMode) stdin.setRawMode(true);
    if (!terminal) { void nextLine().then(answer => resolve((answer ?? '').trim())); return; }
    const mutable = rl as unknown as { _writeToOutput?: (s: string) => void };
    const old = mutable._writeToOutput;
    mutable._writeToOutput = () => {};
    rl.question('', answer => {
      if (terminal && stdin.setRawMode) stdin.setRawMode(rawBefore);
      if (old) mutable._writeToOutput = old;
      output.write('\n');
      resolve(answer);
    });
  });
}

/** Recognise explicit natural-language model requests without hijacking ordinary chat.
 * Model ids must be a single token. Never guess a provider/model from a loose phrase.
 */
export function modelRequest(text: string): string | null {
  const value = text.trim();
  const match = /^(?:byt(?:\\s+nu)?\\s+modell(?:en)?\\s+till|växla\\s+modell(?:en)?\\s+till|använd\\s+modellen)\\s+([a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,179})[.!]?$/i.exec(value);
  return match?.[1] ?? null;
}
