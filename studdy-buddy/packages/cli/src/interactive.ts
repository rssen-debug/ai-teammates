import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import { StuddyRuntime, type RuntimeOptions } from '@studdy/core';
import { box, dots, palette, statusLine, supportsColor } from './theme.js';

export async function runInteractive(options: RuntimeOptions = {}): Promise<void> {
  const runtime = new StuddyRuntime(options);
  const color = supportsColor();
  const p = palette(color);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const changed = runtime.configureFullAccess();
  const provider = runtime.services.activeProvider();
  const native = await runtime.nativeStatus();
  console.log(box(`${dots(color)}  Studdy Buddy`, [
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
      console.log(p.dim(`● live: ${s.observing ? s.windowTitle : s.activity}`));
      rl.prompt(true);
    }
  }, 1000);
  rl.setPrompt(p.mint('du › '));
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === '/exit' || text === '/quit') break;
    try {
      if (text === '/help') {
        console.log('/status /setup /open <app> /windows /snapshot <id> /memory /progress /bridge /exit');
      } else if (text === '/status') {
        const s = runtime.liveStatus();
        const ledger = runtime.ledger().details();
        console.log(box('Status', [
          statusLine('Live', s.observing, color, s.windowTitle ?? s.activity),
          statusLine('AI', Boolean(runtime.services.activeProvider()?.hasApiKey), color),
          `Nivå ${ledger.level} · ${ledger.verified} verifierade skills`,
        ], color));
      } else if (text === '/setup') {
        const preset = (await question(rl, 'Provider (kilo/deepseek/openrouter/opencode): ')).trim().toLowerCase();
        const key = await secret(rl, 'API-nyckel (dold): ');
        const { runCli } = await import('./cli.js');
        await runCli(['provider', 'set', preset, '--key-stdin', '--no-color'], { out: console.log, err: console.error, color: false, stdin: Readable.from([key]) }, options);
      } else if (text.startsWith('/open ')) {
        const r = await runtime.launchApp(text.slice(6));
        console.log(r.ok ? p.mint('✓ ' + r.detail) : p.amber('○ ' + r.detail));
      } else if (text === '/windows') {
        const r = await runtime.adapter.listWindows();
        console.log(r.error ?? r.windows.map(w => `${w.id}  ${w.title}`).join('\n'));
      } else if (text.startsWith('/snapshot ')) {
        const snap = await runtime.adapter.snapshot(text.slice(10).trim());
        console.log(snap.accessible ? snap.elements.filter(e => e.name || e.value).slice(0, 30).map(e => `${e.ref} ${e.role}: ${e.name || e.value}`).join('\n') : snap.note);
      } else if (text === '/memory') console.log(runtime.syncMemory());
      else if (text === '/progress') console.log(JSON.stringify(runtime.services.progress(), null, 2));
      else if (text === '/bridge') {
        const h = await runtime.startBridge();
        console.log(h.status.running ? `ws://${h.status.host}:${h.status.port}\nToken: ${h.token}` : h.status.detail);
      } else if (text.startsWith('/')) console.log('Okänt kommando. /help');
      else {
        const result = await runtime.chat(text);
        if (result.ok) console.log(p.violet('studdy › ') + result.data.message.text);
        else console.log(p.red(result.error.message));
        if (!result.ok || result.data.degraded) runtime.journal.record('cli.chat', result.ok ? result.data.error ?? 'provider failed' : result.error.message, 'warn');
      }
    } catch (error) {
      runtime.journal.record('cli.interactive', error);
      console.log(p.red('Fel: ') + (error instanceof Error ? error.message : String(error)));
    }
    rl.prompt();
  }
  clearInterval(timer);
  await runtime.close();
  rl.close();
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, resolve));
}
function secret(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const mutable = rl as unknown as { _writeToOutput?: (s: string) => void };
    const old = mutable._writeToOutput;
    mutable._writeToOutput = () => {};
    rl.question('', answer => {
      if (old) mutable._writeToOutput = old;
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}
