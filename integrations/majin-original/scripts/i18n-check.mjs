#!/usr/bin/env node
/**
 * Swedish detector used by test/i18n.test.js (and runnable by hand).
 * Rules: string literals in shipped code must be English. Regex literals are
 * exempt (they are input matchers), and so is anything after a comment marker.
 */
import fs from 'node:fs';
import path from 'node:path';

const WORDS = `trasig saknas finns kor starta hamta ner aktuell senaste updatera uppdatering din egen skrivbord genvag Notera notera Testa testar Testa Kvar kvarvarande ange svara svarar svarade svaret bort borta borttagen fil filer filsnack filnamn mapp mappar katalog sökväg sökvägar sida sidor rad rader
antal namn namnen beskrivning användare använd används använda välj visa göm skapa ta_bort lägga
uppdatera hämta skicka skickas kör köra körning körningar svar svaret fråga frågor fel försök
resultat sparade sparas spara verktyg inställning inställningar begränsa tillåten tillåtet
otillåtet godkänn godkänd godkänna neka avvisa bekräfta bekräftelse förfrågan väg innehåll inneholl
sammanfatta sammanfattning undersök undersok analys packad radera raderar raderade radering
flytt kopiera dop namnge döp nagot något inget olikt annat varre värre battre bättre mellan ovantat osäkerhet osakerhet säker saknad saknas
varnar varning tecken binär binärt sträng strängar sekvens avsnitt huvud huvudet början borjan mitten
lite mycket snabb snabbt långsamt stor stora litet små sma större storre mindre nuvarande redo redan
klart färdig fardig öppen oppen stängd stangd starta stoppa startar stoppar avstängning påslagning
gäller galler ovanlig oväntat ovantat saknar saknade onödigt onodigt misslyckades misslyckades
lyckades lyfte ladda laddar laddning skanna skanning skannar matcha matchar matchning ovrig
tillgänglig tillganglig otillgängligt valfritt godtycklig lämplig lamplig olämplig lämpligt
t.ex exempel visserligen däremot dar emot dessutom följande foljande tidigare tidigare nästa nasta
föregående foregaende efterföljande eeftersom eftersom fastän fastan ehuru alltså alltsa`
  .split(/\s+/)
  .filter(Boolean)
  .map((w) => w.replace(/_/g, '[\\s-]'));


function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      yield* walk(p);
    } else yield p;
  }
}

// Lines that must stay Swedish: they are how Swedish *input* keeps working.
const DIACRITIC = /[åäöÅÄÖ]/;
const ALLOW = [
  'words: [', 'JOBS_SV', 'använd anvand use', 'const stop = new Set(', 'match: \'/(',
  'could not parse', 'const map = { amp', 'Exempel', 'glöm',
  "resolveRef(ref ||",  // parser-fallback ordinal words are Swedish INPUT vocabulary
  'svlex(',               // job-matcher input vocabulary (CV/job ad words, never shown)
  'path.join(homedir, ',  // desktop folder names we look for, not messages (Skrivbord)
  'const STOPWORDS = new Set(',  // retrieval stopwords: input vocabulary, never rendered
  '// input vocabulary, never rendered',  // explicit per-line marker for language data
];

// Localization resources hold the product copy by design; they are data, not
// logic, and are reviewed as translations rather than scanned as literals.
const LOCALIZATION = [/src[\\/]v[45][\\/]ui[\\/]strings\.js$/];
// Benchmark scenarios are Swedish *input* text: they exist to prove the
// assistant understands the language users actually type.
// Acceptance checks send Swedish input text for the same reason benchmarks do:
// they prove the assistant handles what users actually type. The local job-form
// acceptance also keeps Swedish field labels as fixture input, not shipped UI.
const BENCHMARK_INPUT = /scripts[\\/]v[45][\\/](benchmark|accept|learn-accept|setup|approvals|job-form-accept)\.mjs$/;

const TARGETS = [];
for (const root of ['src', 'scripts']) if (fs.existsSync(root)) for (const f of walk(root)) if (/\.(js|mjs|cjs)$/.test(f)) TARGETS.push(f);
for (const f of ['install.ps1', 'start-majin.cmd']) if (fs.existsSync(f)) TARGETS.push(f);
const extra = fs.existsSync('bin') ? [...walk('bin')] : [];
TARGETS.push(...extra.filter((f) => /\.(js|cmd|ps1)$/.test(f)));

/** string literals on a line -> their contents */
function literals(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '/' && line[i + 1] === '/') break; // comment tail
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      let j = i + 1;
      let buf = '';
      while (j < line.length) {
        if (line[j] === '\\') { buf += line[j] + (line[j + 1] ?? ''); j += 2; continue; }
        if (line[j] === q) break;
        buf += line[j];
        j++;
      }
      out.push(buf);
      i = j + 1;
      continue;
    }
    if (c === '/' && /[=!(:,=]\s*$/.test(line.slice(0, i))) {
      // regex literal — skip to its closing slash so matchers never count
      let j = i + 1;
      let inClass = false;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '[') inClass = true;
        else if (line[j] === ']') inClass = false;
        else if (line[j] === '/' && !inClass) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

export function scan({ quiet = false } = {}) {
  const hits = [];
  for (const f of TARGETS) {
    if (f.includes('i18n-check')) continue;
    if (LOCALIZATION.some((re) => re.test(f))) continue;
    if (BENCHMARK_INPUT.test(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let inBlock = false;
    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n];
      const t = raw.trim();
      if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
      if (t.startsWith('/*') && !t.includes('*/')) { inBlock = true; continue; }
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (ALLOW.some((a) => raw.includes(a))) continue;
      for (const lit of literals(raw)) {
        const norm = lit.toLowerCase();
        const words = WORDS.filter((w) => new RegExp(`(^|[^a-z0-9_])${w}([^a-z0-9_]|$)`, 'i').test(norm));
        if (words.length) hits.push({ file: f, line: n + 1, words: [...new Set(words.map((w) => w.replace(/\\/g, ' ').replace(/[^a-z ]/g, '')))], text: t.slice(0, 160), kind: 'word' });
        else if (lit.length > 1 && DIACRITIC.test(lit) && !/[À-ÖØ-Þ]/.test(lit.replace(/[åäöÅÄÖ]/g, 'x'))) {
          hits.push({ file: f, line: n + 1, words: ['åäö'], text: t.slice(0, 160), kind: 'diacritic' });
        }
      }
    }
  }
  if (!quiet) {
    for (const h of hits) console.log(`${h.file}:${h.line}  [${h.words.join(',')}]  ${h.text}`);
    console.log(`\n${hits.length} Swedish string literal(s) in ${TARGETS.length} files`);
  }
  return hits;
}

/* same cross-platform trap as offline-swarm-bench (WAVE 8): on Windows the
   naive URL compare is false and the scan silently never runs. */
import { fileURLToPath } from 'node:url';
if (process.argv[1] && (await import('node:path')).resolve(process.argv[1]) === (await import('node:path')).resolve(fileURLToPath(import.meta.url))) scan();
