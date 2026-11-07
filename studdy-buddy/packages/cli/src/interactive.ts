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
    statusLine('AI', Boolean(provider?.hasApiKey), color, provider?.hasApiKey ? provider.name : '/setup för att lägga nyckel'),
    statusLine('Native helper', native.available, color, native.detail),
    '', p.dim('Skriv naturligt. /help visar kommandon. Live-status skrivs bara vid faktisk växling.'),
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
        log('/status /setup /open <app> /windows /snapshot <id> /memory /progress /bridge /exit');
      } else if (text === '/status') {
        const s = runtime.liveStatus();
        const ledger = runtime.ledger().details();
        log(box('Status', [
          statusLine('Live', s.observing, color, s.windowTitle ?? s.activity),
          statusLine('AI', Boolean(runtime.services.activeProvider()?.hasApiKey), color),
          `Nivå ${ledger.level} · ${ledger.verified} verifierade skills`,
        ], color));
      } else if (text === '/setup') {
        output.write('Provider (kilo/deepseek/openrouter/opencode): ');
        const preset = ((await nextLine()) ?? '').trim().toLowerCase();
        const key = await secret(rl, nextLine, 'API-nyckel (dold): ', output, terminal);
        const { runCli } = await import('./cli.js');
        await runCli(['provider', 'set', preset, '--key-stdin', '--no-color'], { out: log, err: log, color: false, stdin: Readable.from([key]) }, options);
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
