import * as readline from 'node:readline';
import { Readable } from 'node:stream';
import { StuddyRuntime, type RuntimeOptions } from '@studdy/core';
import { box, dots, palette, statusLine, supportsColor } from './theme.js';
import { SLASH_COMMANDS, slashMatches, slashCompletions, addGoal, completeGoal, goalSummary, modelChoices } from './slash-ui.js';
import { liveLines, compactLivePrompt } from './live-ui.js';
import { configureLoginAutostart } from './login-autostart.js';
import { runVoiceMode } from './voice-mode.js';
import { runContinuousVoice, listInstalledWindowsVoices } from './continuous-voice.js';
import { naturalDesktopGoal } from './natural-action.js';

export interface InteractiveOptions extends RuntimeOptions { version?: string; input?: NodeJS.ReadableStream; output?: { write(text: string): unknown }; }
export async function runInteractive(options: InteractiveOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = (text: string) => output.write(text + '\n');
  const terminal = Boolean((input as NodeJS.ReadStream).isTTY);
  const runtime = new StuddyRuntime(options);
  const color = supportsColor(process.env, { isTTY: terminal });
  const p = palette(color);
  const rl = readline.createInterface({ input, output: output as NodeJS.WritableStream, terminal, completer: slashCompletions });
  // Lightweight ANSI suggestion overlay: appears as soon as / is typed in a TTY.
  // Render below the readline input and restore the cursor, so typing stays natural.
  // Piped/CI mode never emits terminal control sequences.
  let closed = false;
  let previewVisible = false;
  let secretInputActive = false;
  const preview = () => {
    if (!terminal || closed || secretInputActive) return;
    const inputLine = rl.line.trim();
    const matches = /^\/[a-z]*$/i.test(inputLine) ? slashMatches(inputLine).slice(0, 6) : [];
    if (!matches.length && !previewVisible) return;
    output.write('\x1b7\x1b[0J');
    if (matches.length) {
      output.write('\n' + matches.map(item => p.mint(item.command.padEnd(12)) + p.dim(item.description)).join('\n'));
    }
    output.write('\x1b8');
    previewVisible = matches.length > 0;
  };
  const onKey = () => { if (terminal) setImmediate(preview); };
  if (terminal) input.on('keypress', onKey);
  // Install line handlers before the first await: a pipe can deliver its whole
  // script and EOF while nativeStatus() is still running.
  const lines: string[] = [];
  let waiting: ((line: string | null) => void) | null = null;
  rl.on('line', line => { if (previewVisible && terminal) { output.write('\x1b[0J'); previewVisible = false; } if (waiting) { const resolve = waiting; waiting = null; resolve(line); } else lines.push(line); });
  rl.on('close', () => { closed = true; if (waiting) { const resolve = waiting; waiting = null; resolve(null); } });
  const nextLine = (): Promise<string | null> => lines.length ? Promise.resolve(lines.shift()!) : closed ? Promise.resolve(null) : new Promise(resolve => { waiting = resolve; });
  const changed = runtime.configureFullAccess();
  // The user explicitly requested hands-off Windows login startup. Install a
  // per-user entry only for an actual interactive Windows session. Never do
  // this in CI/piped scripts, and persist an explicit /autostart off choice.
  if (terminal && process.platform === 'win32' &&
      runtime.services.db.checkpoints.get<boolean>('buddy.autostart.opted-out.v1') !== true) {
    configureLoginAutostart(true);
  }
  const provider = runtime.services.activeProvider();
  const native = await runtime.nativeStatus();
  log(box(`${dots(color, runtime.ledger().level(), runtime.liveStatus().observing)}  Studdy Buddy`, [
    statusLine('Full åtkomst', true, color, changed ? 'beviljad' : 'tidigare konfigurerad'),
    statusLine('AI', Boolean(provider?.hasApiKey), color, provider?.hasApiKey ? `${provider.name} · ${provider.modelId}` : 'Anslut med /api'),
    statusLine('Native helper', native.available, color, native.detail),
    '', p.dim('Skriv naturligt · / öppnar kommandomenyn · Tab kompletterar'),
  ], color));
  if (runtime.services.permissions.isGranted('application.observe')) runtime.observer.start();
  // The live indicator is part of the readline input prompt. Updating it
  // redraws the SAME screen row without appending one line per observation.
  // Redraws are suppressed during credential entry or command execution.
  let inCommand = false;
  let lastStatusLine = '';
  const currentPrompt = () => p.dim(compactLivePrompt(runtime.liveStatus(), runtime.ledger().level())) + '  ' + p.mint('du › ');
  const refreshPrompt = (force = false) => {
    if (!terminal || closed || secretInputActive || inCommand) return;
    const status = compactLivePrompt(runtime.liveStatus(), runtime.ledger().level());
    if (!force && status === lastStatusLine) return;
    lastStatusLine = status;
    rl.setPrompt(currentPrompt());
    rl.prompt(true);
  };
  rl.setPrompt(terminal ? currentPrompt() : p.mint('du › '));
  const timer = setInterval(() => {
    if (secretInputActive || inCommand) return;
    refreshPrompt();
    for (const hint of runtime.takeProactiveHints()) {
      // Notify only on real, deduplicated and non-sensitive context signals.
      log(p.mint('● Buddy · ') + hint.question);
      if (terminal) rl.prompt(true);
    }
  }, 1000);
  rl.prompt();
  // readline's async iterator pauses after each yield. Mixing it with nested
  // rl.question() and background prompts can leave a piped REPL permanently
  // paused. An explicit queue keeps input flowing across awaits and EOF.
  for (;;) {
    const line = await nextLine();
    if (line === null) break;
    let text = line.trim();
    if (!text) { rl.prompt(); continue; }
    if (text === '/') {
      log(box('Kommandon  ·  välj nummer', SLASH_COMMANDS.map((item, i) => String(i + 1).padStart(2) + '   ' + item.command.padEnd(12) + item.description), color));
      output.write('Välj › ');
      const choice = ((await nextLine()) ?? '').trim();
      const index = Number(choice);
      text = Number.isInteger(index) && index > 0 && index <= SLASH_COMMANDS.length
        ? SLASH_COMMANDS[index - 1]!.command
        : SLASH_COMMANDS.find(item => item.command === choice)?.command ?? '';
      if (!text) { log(p.dim('Stängt.')); rl.prompt(); continue; }
    }
    if (text === '/exit' || text === '/quit') break;
    inCommand = true;
    try {
      if (text === '/help') {
        log('Skriv / för en väljbar meny, Tab för komplettering, eller prata naturligt.\n' + SLASH_COMMANDS.map(item => item.command.padEnd(12) + item.description).join('\n'));
      } else if (text === '/status' || text === '/live' || text === '/activity') {
        await runtime.observer.tick();
        const s = runtime.liveStatus();
        const metrics = runtime.liveMetrics();
        const issues = runtime.journal.summary();
        const active = runtime.services.activeProvider();
        log(box(dots(color, metrics.level, s.observing) + '  BUDDY LIVE · mätt aktivitet', liveLines(s, metrics, {
          providerConnected: Boolean(active?.hasApiKey), issues: issues.count,
        }), color));
      } else if (text === '/context' || text === '/what') {
        await runtime.observer.tick();
        const context = runtime.voiceScreenContext();
        log(box('Vad Buddy kan använda i ditt samtal', [
          'Fönster: ' + context.label,
          'Bevis: ' + context.proof,
          context.text ? 'Observerad text: ' + context.text : 'Ingen skärmtext delas med Kilo i det här läget.',
          'Endast pågående samtal får den här kontexten; den läggs inte automatiskt i Obsidian.',
        ], color));
      } else if (text === '/voice' || text === '/voice live') {
        log(p.mint('Startar kontinuerlig röst · Kilo-molnmodell + Windows CPU-tal (inga extra API-nycklar).'));
        await runContinuousVoice(runtime, log);
      } else if (text === '/voice voices') {
        const names = await listInstalledWindowsVoices();
        log(names.length ? 'Installerade CPU-röster:\n' + names.map(name => '• ' + name).join('\n') :
          'Inga installerade Windows SAPI-röster kunde verifieras.');
      } else if (text.startsWith('/voice voice ')) {
        const name = text.slice('/voice voice '.length).trim();
        const names = await listInstalledWindowsVoices();
        if (!names.includes(name)) log(p.amber('Rösten finns inte i installerade Windows-röster. Visa med /voice voices.'));
        else {
          runtime.services.db.checkpoints.set('buddy.voice.voiceId.v1', name);
          log(p.mint('Vald CPU-röst: ' + name));
        }
      } else if (text === '/voice style documentary' || text === '/voice style normal') {
        const documentary = text.endsWith('documentary');
        runtime.services.db.checkpoints.set('buddy.voice.style.v1', documentary ? 'documentary' : 'normal');
        log(p.mint(documentary ? 'Dokumentärtempo valt (0,92×). Rösten beror på dina installerade Windows-röster.' :
          'Normalt taltempo valt.'));
      } else if (text === '/voice basic') {
        await runVoiceMode(runtime, log);
      } else if (text === '/do' || text.startsWith('/do ')) {
        const goal = text.slice(3).trim();
        if (!goal) log(p.amber('Beskriv uppgiften: /do öppna ett fönster och kontrollera ...'));
        else {
          log(p.dim('● Kilo-agent startad · högst 8 verifierade datorsteg'));
          const report = await runtime.runDesktopGoal(goal, event => {
            log((event.ok ? p.mint('● ') : p.amber('○ ')) +
              event.step + ' · ' + event.action + ' · ' + event.detail);
          });
          log((report.complete ? p.mint('Verifierat: ') : p.amber('Inte slutfört: ')) + report.summary);
        }
      } else if (text === '/autostart' || text.startsWith('/autostart ')) {
        const arg = text.slice('/autostart'.length).trim().toLowerCase();
        const mode = arg === 'on' ? true : arg === 'off' ? false : null;
        const result = configureLoginAutostart(mode);
        log(result.ok ? (result.enabled ? p.mint('● Autostart på · ') : p.dim('○ Autostart av · ')) + result.detail
          : p.amber(result.detail));
        if (!arg) log(p.dim('Välj /autostart on eller /autostart off. En vanlig CLI körs inte när datorn är avstängd.'));
      } else if (text === '/debug') {
        const info = runtime.journal.summary(6);
        log(box('Lokal debugger · ' + info.count + ' händelser',
          [...(info.recent.length ? info.recent : ['Inga registrerade fel.']),
            'Filen finns i Obsidian-valvet; ingen automatisk GitHub-uppladdning.',
            'Debuggning innebär inte automatisk kodreparation.'], color));
      } else if (text === '/memory' || text === '/obsidian') {
        const info = runtime.liveMetrics();
        log(box('Obsidian-minne', [
          'Valv: ' + (info.vaultPath ?? 'otillgängligt'),
          'Personliga minnen: ' + info.memoryFacts,
          'Observerade arbetsmönster: ' + (runtime.services.memory?.observedPatterns().map(row =>
            row.kind + ' ' + row.periods + ' observationsperioder') .join(' · ') || 'inga ännu'),
          'Dagliga samtalsanteckningar sparas efter lyckade AI-svar.',
          'Debugger: ' + info.debuggerPath,
          'Minnet är lokalt och kan granskas av dig.',
        ], color));
      } else if (/^(?:snacka|prata|svara|skriv) alltid engelska(?: med mig)?[.!]?$/i.test(text) ||
                 /^always (?:speak|reply|respond|write) (?:in )?english(?: to me)?[.!]?$/i.test(text)) {
        runtime.services.db.checkpoints.set('buddy.chat.language.v1', 'en-US');
        runtime.services.memory?.rememberProfile('Prefers English in all conversations');
        log(p.mint('English is now your saved default language.'));
      } else if (/^(?:snacka|prata|svara|skriv) alltid svenska(?: med mig)?[.!]?$/i.test(text) ||
                 /^always (?:speak|reply|respond|write) (?:in )?swedish(?: to me)?[.!]?$/i.test(text)) {
        runtime.services.db.checkpoints.set('buddy.chat.language.v1', 'sv-SE');
        log(p.mint('Svenska är nu ditt sparade standardspråk.'));
      } else if (text === '/profile') {
        const facts = runtime.services.memory?.profileFacts() ?? [];
        log(facts.length ? 'Dina sparade minnen:\n' + facts.map(fact => '• ' + fact).join('\n') : 'Inga personliga minnen ännu. Skriv /remember <fakta> eller ”kom ihåg att …”.');
        const patterns = runtime.services.memory?.observedPatterns() ?? [];
        if (patterns.length) log('Observerade mönster (inte arbetade timmar):\n' + patterns.map(p =>
          '• ' + p.kind + ': ' + p.periods + ' tidsperioder').join('\n'));
      } else if (text.startsWith('/remember ') || /^kom ihåg att /i.test(text)) {
        const fact = text.startsWith('/remember ') ? text.slice(10).trim() : text.replace(/^kom ihåg att /i, '').trim();
        log(runtime.services.memory?.rememberProfile(fact)
          ? p.mint('Sparat i ditt personliga minne. Det används som kontext i framtida samtal.')
          : p.amber('Kunde inte spara. Lägg inte API-nycklar eller lösenord i personliga minnen.'));
      } else if (text === '/goal' || text === '/goals') {
        log(box('Dina mål', [goalSummary(runtime.services.db.checkpoints), '', '1  Lägg till mål', '2  Markera mål som klart', '3  Stäng'], color));
        output.write('Välj › ');
        const choice = ((await nextLine()) ?? '').trim();
        if (choice === '1') {
          output.write('Vad vill du uppnå? › ');
          const title = (await nextLine()) ?? '';
          const goal = addGoal(runtime.services.db.checkpoints, title);
          log(goal ? p.mint('Sparat mål #' + goal.id + ': ' + goal.title) : p.amber('Inget mål sparades.'));
        } else if (choice === '2') {
          output.write('Nummer på klart mål › ');
          const id = ((await nextLine()) ?? '').replace(/^#/, '').trim();
          log(completeGoal(runtime.services.db.checkpoints, id) ? p.mint('Målet markerat som klart.') : p.amber('Målet hittades inte eller är redan klart.'));
        } else log(p.dim('Stängt.'));
      } else if (text.startsWith('/goal add ') || /^mitt mål är att /i.test(text)) {
        const title = text.startsWith('/goal add ') ? text.slice(10) : text.replace(/^mitt mål är att /i, '');
        const goal = addGoal(runtime.services.db.checkpoints, title);
        log(goal ? p.mint('Sparat mål #' + goal.id + ': ' + goal.title) : p.amber('Inget mål sparades.'));
      } else if (text.startsWith('/goal done ')) {
        const id = text.slice(11).replace(/^#/, '').trim();
        log(completeGoal(runtime.services.db.checkpoints, id) ? p.mint('Målet markerat som klart.') : p.amber('Målet hittades inte eller är redan klart.'));
      } else if (text === '/models') {
        const active = runtime.services.activeProvider();
        log(active ? `Aktiv: ${active.name} · ${active.modelId} · ${active.hasApiKey ? 'API-nyckel sparad' : 'saknar nyckel'}\nByt: /model <modell-id> · Byt tjänst/nyckel: /api` : 'Ingen AI ansluten. Skriv /api och välj en tjänst.');
      } else if (text === '/model') {
        const active = runtime.services.activeProvider();
        if (!active) log(p.amber('Anslut AI först med /api.'));
        else {
          const choices = modelChoices(active.id, active.modelId);
          log(box('Välj modell', [...choices.map((id, i) => String(i + 1) + '  ' + id + (id === active.modelId ? '  (aktiv)' : '')), '', 'Eller skriv ett modell-ID · Enter avbryter'], color));
          output.write('Modell › ');
          const chosen = ((await nextLine()) ?? '').trim();
          const index = Number(chosen);
          const modelId = Number.isInteger(index) && index > 0 && index <= choices.length ? choices[index - 1]! : chosen;
          if (!modelId) log(p.dim('Ingen ändring.'));
          else if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,179}$/.test(modelId)) log(p.amber('Ogiltigt modell-ID.'));
          else {
            const result = runtime.services.saveProvider({ id: active.id, modelId });
            log(result.ok ? p.mint('Aktiv modell: ' + modelId + '. Sparad till nästa start.') : p.red(result.error.message));
          }
        }
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
        const providers = ['kilo', 'deepseek', 'openrouter', 'opencode'];
        log(box('Anslut AI', providers.map((name, i) => String(i + 1) + '  ' + name), color));
        output.write('Välj tjänst (1–4) › ');
        const value = ((await nextLine()) ?? '').trim().toLowerCase();
        const index = Number(value);
        const preset = Number.isInteger(index) && index > 0 && index <= providers.length ? providers[index - 1]! : value;
        if (preset === 'avbryt' || !preset) { log('Avbrutet.'); }
        else if (!['kilo', 'deepseek', 'openrouter', 'opencode'].includes(preset)) log(p.amber('Okänd tjänst. Skriv /api och välj från listan.'));
        else {
          // Never mix rl.question() with the line queue. It steals keystrokes from
          // the same readline interface and can freeze the Windows terminal.
          secretInputActive = true;
          let key = '';
          try {
            key = await readApiKey(nextLine, 'Klistra in API-nyckel (synlig): ', output);
          } finally {
            secretInputActive = false;
          }
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
      } else if (text === '/windows' || text === '/apps') {
        await runtime.observer.tick();
        const live = runtime.liveStatus();
        log(box('Öppna fönster · ' + (live.openWindowCount ?? 0), [
          'Aktivt i Windows: ' + (live.foregroundWindow ?? 'okänt'),
          ...(live.openWindows?.length ? live.openWindows.map((name, i) => '  ' + (i + 1) + '. ' + name) : ['Inga andra programfönster identifierade.']),
          'Läser: ' + (live.observing ? (live.windowTitle ?? 'okänt') +
            (live.observationScope === 'background' ? ' (bakom terminalen)' : ' (förgrund)') : 'ingen UI-avläsning bekräftad'),
          'Tryck /live för verifierade detaljer. Listan visar fönster, inte alla processer.',
        ], color));
      } else if (text.startsWith('/snapshot ')) {
        const snap = await runtime.adapter.snapshot(text.slice(10).trim());
        log(snap.accessible ? snap.elements.filter(e => e.name || e.value).slice(0, 30).map(e => `${e.ref} ${e.role}: ${e.name || e.value}`).join('\n') : snap.note ?? 'Ingen tillgänglig snapshot.');
      } else if (text === '/sync-memory') log(runtime.syncMemory());
      else if (text === '/progress') log(JSON.stringify(runtime.services.progress(), null, 2));
      else if (text === '/bridge') {
        const h = await runtime.startBridge();
        log(h.status.running ? `ws://${h.status.host}:${h.status.port}\nToken: ${h.token}` : h.status.detail);
      } else if (text.startsWith('/')) log('Okänt kommando. /help');
      else {
        const goal = naturalDesktopGoal(text);
        if (goal) {
          log(p.dim('● Buddy · Kilo planerar ett verkligt datorsteg'));
          const report = await runtime.runDesktopGoal(goal, event =>
            log((event.ok ? p.mint('● ') : p.amber('○ ')) +
              event.step + ' · ' + event.action + ' · ' + event.detail));
          log((report.complete ? p.mint('Verifierat: ') : p.amber('Inte slutfört: ')) + report.summary);
        } else {
          log(p.dim('○ Buddy arbetar · tolkar förfrågan och inväntar verifierat svar...'));
          const result = await runtime.chatWithScreen(text);
          if (result.ok) log(p.violet('studdy › ') + result.data.message.text);
          else log(p.red(result.error.message));
          if (!result.ok || result.data.degraded) runtime.journal.record('cli.chat', result.ok ? result.data.error ?? 'provider failed' : result.error.message, 'warn');
        }
      }
    } catch (error) {
      runtime.journal.record('cli.interactive', error);
      log(p.red('Fel: ') + (error instanceof Error ? error.message : String(error)));
    }
    inCommand = false;
    if (terminal) { rl.setPrompt(currentPrompt()); lastStatusLine = compactLivePrompt(runtime.liveStatus(), runtime.ledger().level()); }
    rl.prompt();
  }
  clearInterval(timer);
  if (terminal) input.removeListener('keypress', onKey);
  await runtime.close();
  rl.close();
}

/** API keys are visible while pasted, by explicit user request. This is just
 * the existing readline queue: no rl.question, echo override, or raw-mode
 * toggles. Never log, persist or echo the key from application code.
 * The terminal itself will echo input, as it does for ordinary chat.
 */
async function readApiKey(
  nextLine: () => Promise<string | null>,
  prompt: string,
  output: { write(text: string): unknown },
): Promise<string> {
  output.write(prompt);
  return ((await nextLine()) ?? '').trim();
}

/** Recognise explicit natural-language model requests without hijacking ordinary chat.
 * Model ids must be a single token. Never guess a provider/model from a loose phrase.
 */
export function modelRequest(text: string): string | null {
  const value = text.trim();
  const match = /^(?:byt(?:\s+nu)?\s+modell(?:en)?\s+till|växla\s+modell(?:en)?\s+till|använd\s+modellen)\s+([a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,179})[.!]?$/i.exec(value);
  return match?.[1] ?? null;
}
