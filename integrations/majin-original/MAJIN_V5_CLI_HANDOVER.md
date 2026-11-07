# MAJIN V5 CLI — HANDOVER: Ta V5 till 100% (ingen lobotomi)

**Till:** Dev som tar över MAJIN V5 / CLI-spåret
**Från:** Arena-agent (fullständig kodaudit mot repot, inte mot minne eller gamla statusfiler)
**Datum:** 2026-10-25
**Repo:** `rssen-debug/MAJINCLI` · **Commit som auditen gäller:** `f0089c51a994a0464c47386f58065225a37b3ded` (= `main` vid audit)
**Branch för denna handover:** `arena/3d7b620f-majincli`

---

## 0. TL;DR — läs detta först

Ägaren har rätt i sin kritik. Problemet är **inte** att verktygen saknas. Problemet är att
**V5:s live-väg aldrig kopplades in på dem.** Allt som byggts i V1–V4 finns kvar i repot —
men modellen i V5 ser nästan ingenting av det.

Uppmätt på commit `f0089c5` (kommandon för att reproducera: §9):

| Mått | Siffra |
|---|---|
| Distinkta verktygsnamn i repot (V1 `ALL_TOOLS` 149 + `browser.js`/`desktop-app.js` utanför registret) | **155** |
| Max antal av dessa som V5-modellen kan nå med **alla** behörigheter + Windows + browser | **30 (19%)** |
| Verktyg som är **onåbara i V5 oavsett inställningar** | **125** |
| …varav riskklass `read` (alltså ofarliga läsverktyg) | **64** |
| Verktyg modellen ser i en **färsk installation** (Electron, standard) | **14** driver-verktyg + 5 host-verktyg |
| Anledningen till 14 | Ingen produktionskod anropar någonsin grant-API:t — `grantedLanes` är `[]` för alltid i en färsk install |

Dessutom:

- **Blockerade webbåtgärder:** Form-submit och alla icke-GET-anrop blockeras av design i
  `src/core/tools/browser.js`, och enda sättet att tillåta en origin idag är en odokumenterad
  startflagga `--submit-origin` (finns inte ens i `--help`, ingen UI, inget API — API kommer i
  öppen PR #445). Electron-appen skickar aldrig flaggan. **I den levererade produkten kan MAJIN
  alltså aldrig skicka ett formulär.** Det är detta ägaren reagerar på.
- **Inget blir någonsin KLART:** UI:t skickar aldrig acceptanskriterier, och `ProviderAgent`
  kan bara sätta `COMPLETED` om *samtliga* kriterier är filkontroller. Varje lyckat UI-mål
  landar därför som `PARTIAL` ("delvis klart") för alltid, och XP/lärande nås aldrig från UI:t.
- **Ägaren ser ingenting av arbetet:** `POST /api/v5/goal` är ett enda blockerande anrop.
  Inga live-events, `tool_results` sparar bara verktygsnamn + argument*nycklar* (inga värden,
  inga resultat, inga tider), och UI:t visar bara modellens sluttext.
- **Det finns ingen V5-CLI för agentarbete:** `majin-v5` kan bara `serve/window/status/version`.
  Ingen `run`, `tools`, `doctor`, `grants`, `resume`, `logs`.

**Produkten står på 30/100 enligt scoreboardet i §2. 70% kvar.**
Definition av 100% (ägarens): *MAJIN kan lösa allt den har verktyg för, använder alla verktyg
rätt, och ägaren ser allt den gör.* §2 bryter ner det i mätbara poäng. **Inga poäng utan
test/evidens på slutcommit** — repots egen ärlighets-CAP gäller.

Den goda nyheten: **det mesta behöver inte byggas, det behöver kopplas in.**
V4 har redan en universell verktygsbrygga (`src/v4/tools/host.js`), verktygssökning/exponering
(`src/v4/tool-exposure.js`), en komplett owner-mode och 20 lanes. V5 byggde en parallell
handplockad allowlist (`src/v5/codex-tools.js`) istället. Arbetspaketen i §7 (WP0–WP9) är
ordnade så att varje PR tar poäng på scoreboardet. Följ ordningen.

---

## 1. Regler (bindande — från ägaren + repots egna principer)

### Ägarens direktiv
1. **Ingen lobotomi.** Inga dolda tak, inga stumma allowlistor, inga verktyg som "finns" men
   inte går att nå. Om ett verktyg inte kan användas ska `driver_status`/doctor säga exakt
   varför (lane ej given, runtime saknas, Windows krävs…).
2. **Ägaren ska se allt MAJIN gör** — live, verktyg för verktyg, med resultat och bevis.
3. **Efter varje körning/PR: rapportera hur många procent som är kvar till 100%**
   (scoreboardet i §2, med före/efter och evidenslänk per poäng).
4. **Fortsätt medan andra tester körs** — starta långa testbatterier i bakgrunden och arbeta
   parallellt. Stanna inte efter en liten fix.
5. **Den ska kunna hantera vad som helst** som den har verktyg för — inklusive webbåtgärder
   som idag blockeras. Se gränsen i punkt 8 nedan.

### Repots principer (får inte brytas för att nå 100%)
6. **Ingen fake-PASS.** `COMPLETED` kräver oberoende verifiering (host-sida), aldrig bara
   modellprosa. Mock ≠ live. `NOT TESTED` skrivs aldrig som `PASS`.
7. **Exactly-once för externa effekter.** Osäker operation = inspektera först, aldrig
   automatiskt repetera (jobbansökan får aldrig skickas två gånger). Behåll
   `CodexDriver`s operationId/fingeravtryck/diskrecord.
8. **Ärliga gränser som INTE är lobotomi:** CAPTCHA, MFA, inloggningsväggar och betalväggar
   ska inte *kringgås*. De ska *hanteras*: detektera → pausa som `WAITING_USER` → låt ägaren
   lösa det iMAJINs eget synliga browserfönster (samma beständiga profil) → återuppta samma
   mål. Alternativ väg (API, e-post, annan portal) ska föreslås automatiskt. Det är skillnad
   på en gräns hos omvärlden och en gräns MAJIN sätter på sig själv — det är den senare som
   ska bort, allihop.
9. **Säkerhetsgolv som stannar:** otrusted innehåll (webbsidor, filer, skills) kan aldrig ge
   behörigheter; hemligheter aldrig i loggar/commits/traces (skrubbning finns — behåll);
   realpath-kontroll på filsökvägar; destruktiva handlingar kräver ägarens mandat
   (mönstret i `jobs.send`: explicit preview + bevis efteråt). Behörigheter ges av ägaren i
   UI/CLI — aldrig av modellen, aldrig av sidinnehåll.
10. **Ingen lokal Qwen på ägarens CPU** (`ARENA.md`). Free-model-tester körs på GitHub
    Actions-hostade runners; OpenCode **Go** i molnet. Windows live-verifiering via CI /
    befintlig self-hosted interactive runner.
11. **Återanvänd, bygg inte om.** Layout/kontrakt från V1–V4 och upstream återanvänds;
    innehåll skrivs eget. En runtime i taget — stapla inte agentloopar.
12. **i18n:** levererad källkod (src/) får inte innehålla svenska strängar utanför
    lokaliseringsfiler — `npm run i18n` måste vara grön. Svensk UI-text via `strings.js`.
13. Små PR:er, en förmåga per PR, dedikerat test + full regression före merge.
    **Inga fler PR:er som kopplar in exakt ett verktyg** (se WP0 — det är fällan vi sitter i).

---

## 2. Scoreboard — definition av 100% och var vi står (30/100, 70 kvar)

Varje kategori poängsätts bara mot körbar evidens på den commit som bedöms.
Uppdatera tabellen i varje PR-beskrivning.

| # | Kategori | Max | Idag | Bevis / varför |
|---|---|---|---|---|
| 1 | **Verktygsräckvidd** — alla verktyg nåbara för modellen i V5-live (per lane/host) | 20 | **4** | 30/155 nåbara vid maxkonfig (§3.1); färsk install 14 driver-verktyg. Formel vid ommätning: `20 × nåbara/155`, avrundat nedåt |
| 2 | **Verktygsval & schema-korrekthet** — rätt verktyg, rätt argument, inga gissade scheman | 10 | **4** | Schema rekonstrueras med regex ur prosa + tal klipps till `0..4 000 000` (`codex-tools.js`); namnkollision `browser.*` ×2 implementationer; ingen `tools_search` i V5 (finns i V4, oanvänd) |
| 3 | **Webb/browser end-to-end** — läsa, fylla, skicka, bekräfta, ladda ner, login-handoff | 15 | **5** | Läsa/fylla + lokal submit bevisad i test (skip här: ingen Chromium); **i levererad produkt är submit omöjligt** (§3.2); form-verktygen (`browser.form*`, `verify`) onåbara; ingen download-hantering; ingen CAPTCHA/login-handoff |
| 4 | **Verifiering & ärligt KLART** — varje måltyp kan bevisas klar | 10 | **3** | Endast `file`-kriterier kan ge `COMPLETED`; UI skickar aldrig kriterier ⇒ allt blir `PARTIAL`; `http`/`dom`-verifierare finns men är inte inkopplade i V5-loopen |
| 5 | **Långa jobb, parallellitet, återhämtning** | 10 | **4** | Checkpoint/resume/idempotens finns och är testat; men 1 mål globalt, sekventiella verktygsanrop, hårt tak 32 rundor → `BLOCKED`, delegerade workers max 2–3 read-only, ingen kontextkomprimering |
| 6 | **Synlighet ("jag vill se allt den gör")** | 10 | **2** | Blockerande POST utan events; trace saknar argument/resultat/tid; UI visar bara sluttext. PR #446 (progress-endpoint) öppen = rund 1 |
| 7 | **CLI** — köra, inspektera, styra allt från terminalen | 10 | **2** | `majin-v5`: `serve/window/status/version`. Ingen `run/tools/doctor/grants/resume/logs`. V1-CLI (`src/cli/majin.js`, 850 rader) kör annan runtime |
| 8 | **Behörigheter utan lobotomi** — ägaren kan ge/ta tillbaka allt, i UI:t | 5 | **1** | `POST /api/v5/access` finns men har **noll anropare i produktionskod** (bara tester/scripts); `--submit-origin` saknas i `--help`; Electron skickar inga grants |
| 9 | **Providers/modeller live** | 5 | **3** | OpenCode Go inkopplad (`x-opencode-session` obligatorisk), historiska live-bevis (DeepSeek via Go); men `stream:false` hårdkodat trots streaming-flagg, ingen tokenbudget/komprimering, default-modellfix i öppen PR #444 |
| 10 | **Release-/Windows-verifiering på slutcommit** | 5 | **2** | `v5:test` röd (1 fail, §5); workflow *MAJIN V5 Windows Desktop & Setup.exe* **failure** på `main`/`f0089c5`; flera andra CI gröna; **62 öppna PR:er** otriagerade |
| | **TOTALT** | **100** | **30** | **70% kvar** |

**100% nås när:** alla kategorier är fulla på samma commit, dvs. parity-testet (WP1) visar
155/155 nåbara eller explicit undantagna med anledning, per-verktygs kontraktbatteri (WP2)
grönt, 25-uppgifts live-batteriet (WP9) ≥90% verifierat PASS, och samtliga gates
(`npm test`, `v4:test`, `v5:test`, `check`, `i18n`, Windows Desktop CI) gröna på den committen.

---

## 3. Rotorsakerna (det är detta som ska fixas — i den här ordningen)

### 3.1 R1 — V5 har en handplockad allowlist istället för V4:s universella brygga ⭐ huvudorsaken

Live-vägen när användaren skickar ett mål i V5-UI:t:

```
src/v5/ui/app.js ──POST /api/v5/goal {goalText, files}──▶ src/v5/server.js
  └─ useProviderAgent(body) ──▶ src/v5/provider-agent.js  (ProviderAgent.execute)
       └─ src/v5/codex-driver.js (CodexDriver, forkad worker)
            └─ src/v5/codex-tools.js  createDriverTools()   ◀── HÄR sker lobotomin
```

`createDriverTools` (`src/v5/codex-tools.js:37–52`) tar bara:

- `fs.list/read/write/patch/search/grep/stat/mkdir/find` (9 av 13; `copy/delete/move/tar` borta)
- `web.search`, `web.fetch` (och bara om lane `web`/`research` är given)
- `shell.run` (bara vid `processAccess`)
- `control.*` + `desktop-app` (2) + `screen.capture` (bara interaktiv Windows-session)
- `browserTools` 9 st från `src/core/tools/browser.js` (bara om Playwright + browser-binär hittas)
- Egna adaptrar: `documents_extract`, `jobs_search`, `jobs_match`, `skills_search/read`, `driver_status`

Plus 5 host-verktyg i `provider-agent.js`: `procedures_search/read`, `agent_plan`,
`agent_checkpoint`, `agent_delegate`.

**Onåbara i V5 under alla omständigheter (125 st):** `research.run`, alla `re.*` (23),
alla `majin.*` (21), `jobs.*` riktiga flödet (9 — `jobs.prepare`, `jobs.send`, CV-hantering),
`browser.form/form_fill/form_submit/read/verify/elements/shot/clear_marks` (8),
`sys.*` (7), `flows.*` (6), `exec.*` (5), `net.*` (5), `agent.*` (4), `marketing.*` (4),
`ma.*` learn (3), `power.*` (3), `github.*` (2), `media.*` (2), `team.*` (2), `trading.*` (2),
`reset.*` (2), `channel.send`, `computer.use`, `cursor.overlay`, `memory.sync`,
`mouse.move`, `screen.claim`, `tools.search`, `web.download`, m.fl.
64 av de 125 är riskklass `read`. Det är alltså inte en säkerhetsavvägning — de kopplades
aldrig in.

**Varför gjordes det troligen så:** V1-verktyg behöver en riktig `ctx`. I `codex-tools.js:45`
är ctx bantad till `{ session, browserWriteOrigins, cfg.get('workspace') }`. Men verktygen
använder bl.a. `ctx.cfg` (143 träffar), `ctx.session`, `ctx.signal`, `ctx.registry`
(nästlade anrop, t.ex. `research.run → web.search`), `ctx.emit`, `ctx.approvals`,
`ctx.memory`, `ctx.channels`, `ctx.scheduler`… Utan dem kraschar eller tystnar verktygen.

**Lösningen finns redan byggd och testad i V4 — återanvänd den, hitta inte på en tredje väg:**

- `src/v4/tools/host.js`
  - `V1_LANES` (rad 53) — 20 lanes som mappar varje V1-modul.
  - `hostCapabilities()` (rad 104) — frågar plattformen vad som faktiskt kan ladda/köras.
  - `v1Context()` (rad 342) — bygger äkta ctx inkl. registry-fasad med `exec` genom samma
    runner/approvals (nästlade anrop kan inte gå runt samtycke), `folders()` läst vid anrop.
  - `adaptV1Tool()` (rad 431) + `zodFromV1Params()` (rad 313) — riktiga scheman.
  - `registerHostTools()` (rad 500) — registrerar allt tillgängligt och returnerar
    `{ registered, skipped[] }` med anledning per överhoppat verktyg. **Exakt ärligheten
    ägaren kräver.**
- `src/v4/tool-exposure.js` — `createToolExposure` / `searchRegistry`: core alltid synliga,
  resten fyller budget (default 64), plus `tools_search`/`tools_activate` så **inget verktyg
  någonsin är onåbart** — modellen får veta att listan kan vara partiell och hur den utökas.
  Detta är det korrekta svaret på "skicka inte 155 scheman varje runda": kurering med
  upptäckbarhet, inte borttagning.
- `src/v4/owner-mode.js` — `GRANTABLE_LANES` (23), persisterade grants, revoke vinner alltid.

V5-specifikt som måste bevaras vid bryggningen: `CodexDriver`-lagret med
operationId/fingeravtryck/diskrecord/timeout per operation (`src/v5/codex-driver.js`) och
`ProviderAgent`s checkpoint/resume/steering. Samma `createDriverTools` används också av
Codex-styrenheten (`codex-worker.js`, `bin/majin-codex-mcp.mjs`) — en fix där lagar båda kontrollerna.

**Namnkollision att lösa i samma paket:** `browser.open/click/fill/upload/close` finns i
*både* `web.js` (äldre CDP-baserade, ingår i `ALL_TOOLS`) och `browser.js` (Playwright, den
V5 använder), med olika parametrar/semantik. Välj Playwright-implementationerna i V5-registret,
porta form-verktygen från web-lanen (`form`, `form_fill`, `form_submit`, `read`, `verify`,
`elements`, `shot`, `clear_marks` — inga namnkrockar) ovanpå samma Playwright-session, och
dokumentera valet. Observera även att `browserTools` (9) och `desktopAppTools` (2) idag inte
ens ingår i `ALL_TOOLS`/`buildRegistry` i `src/core/tools/index.js` — ena registret måste bli
sanningen (rekommendation: lägg dem i `V1_LANES` som lane `browser`/`desktop`, låt parity-testet
räkna mot den samlade listan).

`majin.*`-metaverktygen (21) behöver riktiga tjänster (memory, skills, provider-config,
dataset, scheduler…). Gå igenom dem ett och ett: koppla mot V5:s motsvarigheter där de finns
(`skillTree`, `learning`, `providers`, `files`, `ops`), annars explicit
`EXCLUDED_WITH_REASON` i parity-listan tills tjänsten finns. Tyst frånvaro är det enda
otillåtna utfallet.

### 3.2 R2 — Browser-skrivningar är i praktiken avstängda i den levererade produkten

Mekaniken (i sig korrekt säkerhetsdesign) i `src/core/tools/browser.js`:

- **Init-script** avbryter alla `submit`-events utom om *både* sidans och action-URL:ens
  origin finns i `ctx.browserWriteOrigins`.
- **Route-interceptor** aborterar alla anrop som inte är `GET/HEAD/OPTIONS` om inte request-
  *och* frame-origin är beviljade. Blockerade anrop sparas i `state.blockedRequests` (≤30).
- `browser.click` vägrar submit-kontroller utan grant.

Men granten kan bara sättas **vid processstart**: `majin-v5 serve --submit-origin https://…`
(`bin/majin-v5.mjs:83`, dokumenterad endast i `docs/v5/AUTHORIZED_FORMS.md` — **inte i
`--help`**). Electron (`desktop/main.cjs:103–105`) startar hosten med enbart `--port/--host`.
Det finns ingen UI och (på `main`) inget API för att bevilja. Konsekvens: i produkten som
skickas till användare är **alla formulär-submit och alla POST/PUT/DELETE blockerade, permanent**.

Ytterligare fel i kedjan:

- Driver-ctx saknar `emit`, så `browser:blocked-request`-events (`ctx.emit?.(...)`) försvinner
  spårlöst. Modellen ser bara att sidan "inget händer" → loopar eller ger upp.
- Modellen får aldrig det enda användbara svaret: *"origin X behöver ditt godkännande"* →
  `WAITING_USER` med en knapp. Istället generisk `BLOCKED` eller tyst fel.
- Browsern kör `headless: true` som default → ägaren kan inte ens se/logga in manuellt.

**Öppen PR #445** (`fix/v5-runtime-origin-approval-resume`) bygger API-halvan: persisterade
exakta HTTPS-origins via `POST /api/v5/access {action:'allow_browser_origin'}`, endast loopback,
aldrig under pågående operation, resume utan ombyggnad. Merga den (WP0) och bygg UI + `WAITING_USER`-
flödet ovanpå (WP3/WP4). Modellen/sidinnehåll får fortsatt **aldrig** bevilja själva.

### 3.3 R3 — Färsk installation har noll behörigheter, och inget sätt att få dem

`POST /api/v5/access` → `enableOwnerMode()` (`src/v5/files-access.js:305`, default *alla*
23 lanes) finns, men **ingen produktionskod anropar den** — enda anropare i repot är
`scripts/v5/accept.mjs`, `scripts/v5/provider-coding-live-check.mjs` och tester.
UI:t (`src/v5/ui/app.js`) innehåller inte ett enda anrop mot access-API:t och nämner inte
lanes alls. `OwnerMode` skapas utan `forceLanes`.

Resultatet vid färsk install: `grantedLanes = []` ⇒ i `createDriverTools` filtreras
`web.*` bort, `jobs_search` raderas, `browser=false`, `desktop=false`, `processAccess=false`
⇒ **14 verktyg** (mätt i §9): 9×`fs_*`, `documents_extract`, `jobs_match`, `skills_search/read`,
`driver_status`. Även `web_search` saknas alltså. Användaren upplever en lobotomerad agent
och får ingen ledtråd om varför. Fix = WP3 (first-run-val + inställningspanel mot befintligt API).

### 3.4 R4 — Verifieringen kan bara bevisa filer, så UI-mål kan aldrig bli klara

- `ProviderAgent` (`src/v5/provider-agent.js`, loopens slut) sätter `PARTIAL` som default och
  uppgraderar till `COMPLETED` **endast** om det finns kriterier och *samtliga* är
  `kind:'file'` med `contains`/`hash`. Då körs `runVerifier('file', …)`.
- UI:t skickar bara `{ goalText, files }` (`src/v5/ui/app.js:392`) — **aldrig kriterier**.
  Alltså: varje UI-mål = `PARTIAL`, ingen XP, inget lärande — oavsett hur bra arbetet gick.
- Samtidigt finns `verifierRegistry = { file, http, pixel, dom }` färdig i
  `src/v2/runtime/verifiers.js:138` — `http` och `dom` är bara inte inkopplade i V5-loopen.
  Saknade verifierartyper: `command` (kör test/kommando host-sida, exitkod + mönster),
  `browser` (bekräftelse-DOM/URL efter submit), `json` (parsar + schema), `research`
  (påståenden har hämtade källor från detta mål).
- Ren fråga/svar utan sidoeffekter behöver ett ärligt sluttillstånd som inte heter PARTIAL
  (t.ex. `COMPLETED` med kind `answer`, men utan XP — XP bara för verifierade effekter).
  Statusvokabulären finns redan i `architect.js` (`COMPLETED/PARTIAL/FAILED/BLOCKED/
  WAITING_USER/CANCELLED`); `ProviderAgent` ska använda samma semantik konsekvent.

### 3.5 R5 — Synligheten ("jag vill se allt den gör") saknas i V5-produkten

- `POST /api/v5/goal` (`src/v5/server.js:196`) väntar på *hela* målet och returnerar ett
  enda JSON-svar. Upp till 32 rundor × 120 s kan UI:t stå på "Working on your request…".
- Det finns **ingen** event-ström i `src/v5/server.js`. (Codex-hosten `src/v5/codex-host.js`
  har SSE — den är inte produkten.) **Öppen PR #446** lägger till en poll-bar
  `GET /api/v5/goal/progress` (räknare) = bra rund 1, otillräckligt som slutläge.
- `goal.tool_results` persisterar bara `{ tool, argKeys, ok, operationId, status, errorCode,
  blocker }` — varken argumentvärden (ens redigerade), resultat, eller varaktighet.
  Driver-operationerna finns på disk (`stateDir/*.json`) men exponeras inte via API/UI.
- Kravbild för WP6: SSE `GET /api/v5/goal/events`, persisterad JSONL-trace per mål
  (verktyg start/slut, redigerade argument, resultatsammandrag, ms, operationId,
  evidens/screenshot-sökvägar), live verktygsfeed i UI:t med expanderbar detalj,
  nedladdningsbar trace. Redigeringsregler: återanvänd befintlig skrubbning; aldrig nycklar.

### 3.6 R6 — Tak och flaskhalsar som dödar långa/verkliga jobb

Alla i `src/v5/provider-agent.js` om inget annat sägs:

| Tak | Värde idag | Effekt |
|---|---|---|
| `maxRounds` | **32** (konstruktor-default) | Därefter `BLOCKED` "Execution round limit reached" — äkta flerstegsjobb (500-jobbflödet!) dör |
| Provider-anrop timeout | 120 s, `maxRetries: 1` | OK som per-anrop, men ingen budget/resume-automatik ovanpå |
| Verktygsoperation timeout | 120 s (`CodexDriver timeoutMs`) | Långa legitima kommandon/testsviter avbryts som "uncertain" |
| Tool-calls per modellsvar | max 32, sedan **kastas fel** | Hårt fel istället för batch-kö |
| Identiskt misslyckat anrop | Signatur bannas för resten av målet; 3 upprepningar ⇒ hela målet kastas | Bra anti-loop, men banningen persisteras (`adaptive.failedActions`) även över resume — kan låsa legitima retry efter miljöfix |
| Verifieringsreparationer | max 2, sedan kastas | Rimligt som default, ska vara budget — inte öde |
| Verktygsresultat till modellen | trunkeras vid **16 000 tecken** (12 000 för delegater) | OK om det finns fokuserad omläsning; farligt för stora läsningar utan paginering |
| Samtidiga verktyg | `CodexDriver.busy` — **ett i taget**, och provideragenten kör anropen sekventiellt | Oberoende lässteg som modellen batched serialiseras; långsamt |
| Samtidiga mål | `ProviderAgent.active` ⇒ HTTP 409 "already running" | Ägaren kan inte köra två jobb parallellt ("fortsätt medans andra tester körs" är omöjligt i produkten) |
| Delegera | `agent_delegate`: 2–3 tasks, concurrency 2, **endast read-only**, max ~6 rundor/worker | Bra säker start; dokumenterat tak, inte parallell exekvering på riktigt |
| Kontext | Hela message-historiken behålls över resume, **ingen komprimering** | Långa mål dör på kontextgräns/providerfel till slut |
| Streaming | `stream:false` hårdkodat (`providers.js:669`) trots `capabilities.streaming` | Ingen token-streaming, sämre upplevd respons + timeout-risk |

Inget av dessa tak är fel som *budget*. Felet är att de är **dolda konstanter** som ägaren
varken ser eller kan ändra, och att flera av dem tar död på legitima jobb. WP8 gör dem till
en synlig, ägarstyrd budget per mål + automatisk fortsättning via checkpoints.

### 3.7 R7 — CLI:t existerar inte för V5

`bin/majin-v5.mjs` kommandon: `serve`, `window`, `status`/`url`, `version`, `help`.
(`--submit-origin` parsas vid serve men nämns inte i help.) Allt agentarbete kräver UI/HTTP.
Samtidigt finns tre andra binärer/runtimes i samma repo (`majin` = V4-väg, `majin legacy` =
V1 i `src/cli/majin.js` med ~20 kommandon, `majin-v2`) — begriplig historik, men för ägaren
är produkten = V5. WP7 specificerar CLI-paritet mot V5-servern (samma motor, ingen ny loop).

### 3.8 R8 — Två "sanningar" och versionsförvirring (städning, WP0)

- `server.js:88` routar till `ProviderAgent` om modell är vald och bodyn saknar
  `actions/jobAds/synthesizeMissingSkill/blocker/requireUserConfirmation`; annars till
  `GrandArchitect.executeGoal` (deterministisk/skriptad väg). Dokumentera i kod: provider-vägen
  är produkten; architect-vägen är skriptade flöden/test. Bygg inga nya features i fel väg.
- `package.json` säger `4.0.0-alpha.3`, V5 säger `5.0.0`, GitHub Latest release = `v5.0.0`.
  En versionssanning (rekommendation: `src/v5/ops.js` `getVersionInfo` matar allt).
- `.majin-matrix-ws-*` (4 kataloger) i repo-roten ser ut som testskräp — kontrollera och
  gitignore:a/rensa.
- **62 öppna PR:er.** Många är historiska V1-spår från 2026-10-22-serien. Triagera (WP0)
  innan nytt arbete: merga det levande V5-spåret (§6), stäng/märk om resten med kommentar.

---

## 4. Arkitekturkarta (vad som är vad — så du inte bygger i fel lager)

| Del | Fil(er) | Roll i produkten |
|---|---|---|
| V5-server + UI | `src/v5/server.js`, `src/v5/ui/*`, `bin/majin-v5.mjs`, `desktop/*` | Produkten ägaren kör (port 4555) |
| Provider-agent (live) | `src/v5/provider-agent.js`, `src/v5/providers.js` | Modelldriven loop: plan/delegera/checkpoint, styrning, resume |
| Verktygsdriver | `src/v5/codex-driver.js` + `codex-worker.js` | Forkad worker, operationId/idempotens, timeouts, diskrecord |
| **Verktygskatalog (fixa här)** | `src/v5/codex-tools.js` | **Dagens allowlist — ersätts av V4-brygga i WP1** |
| Codex-kontroll (alternativ) | `src/v5/codex-app-client.js`, `codex-host.js`, `bin/majin-codex-mcp.mjs` | Samma katalog via MCP/Codex AppServer — lagas automatiskt av WP1 |
| V5-domän | `architect.js`, `skill-tree.js`, `skill-builder.js`, `xp-engine.js`, `learning-engine.js`, `procedure-tools.js`, `adaptive-policy.js`, `adaptive-delegation.js`, `files-access.js`, `workflows/job-search.js`, `ops.js` | Skills/XP/lärande/grants/jobflöde |
| V4 universell brygga ⭐ | `src/v4/tools/host.js`, `src/v4/tool-exposure.js`, `src/v4/tools.js`, `src/v4/owner-mode.js`, `src/v4/path-access.js` | **Återanvänd för WP1/WP2** — redan byggd+testad |
| V2-runtime | `src/v2/runtime/{goal,dag,scheduler,verifiers,receipts}.js`, `src/v2/tools/{registry,runner}.js` | Mål/DAG/verifierare som V5 redan återanvänder |
| V1-verktyg (sanningen om förmåga) | `src/core/tools/*.js` (28 moduler), `src/core/tools/index.js` `ALL_TOOLS` = 149 | Implementeringarna. `browser.js` (9) + `desktop-app.js` (2) ligger utanför `ALL_TOOLS` idag |
| V1-motor övrigt | `src/core/{agent,loop,mission,swarm,teams,flows,research,...}.js`, `src/cli/majin.js` | Legacy-runtime; mönster får återanvändas, produkten byggs i V5-vägen |

Målflöde efter WP1–WP6:

```
UI/CLI ──▶ /api/v5/goal (202 + goalId, svarar direkt)
             │ events: SSE /api/v5/goal/events  ◀── ägaren ser varje verktyg live
ProviderAgent ── tools_search/activate (exposure ≤64 synliga, allt nåbart)
             └─▶ CodexDriver (operationId, idempotens) ──▶ V4-brygga (registerHostTools)
                    └─▶ V1-verktyg med äkta v1Context (cfg/registry/emit/signal/folders)
Verifiering host-sida: file|http|dom|command|browser|json|research ──▶ COMPLETED + kvitto
Blockering ägare kan lösa ──▶ WAITING_USER {vad som behövs} ── 1-klick/CLI ──▶ resume samma mål
```

---

## 5. Verifierad status på `f0089c5` (kört av mig, 2026-10-25, Linux-container Node v22.22.3)

```bash
npm ci --ignore-scripts        # 222 paket, OK
npm run check                  # PASS (exit 0) — alla JS/MJS parsear
npm run i18n                   # PASS (exit 0)
npm run v5:test                # 68 tester: 65 pass / 1 FAIL / 2 skip
npm test                       # test/*.test.js: 1467 tester: 1448 pass / 0 fail / 19 skip (~165 s)
npm run v4:test                # test/v4/*.test.js: 639 tester: 619 pass / 6 FAIL / 14 skip
```

- **V5-felet (1):** `test/v5/composer-model-picker.test.js:17` — *"Enter sends once; HTTP
  errors preserve input and restore send button"* — composern rensas omedelbart (HEAD-committen
  `style(v5): make composer compact…`) men inmatningen återställs inte vid HTTP-fel (`'' !== 'Hitta jobb'`).
  **Fix finns redan som öppen PR #448.** Merga den först (WP0) så är sviten grön.
- **V5-skip (2):** `browser-submit` real-Chromium-testet (ingen Chromium/Edge i denna miljö)
  och ett process-lane-avbrottstest. Browser-testet *måste* köras där Chromium finns (CI Windows).
- **V4-felen (6) — baseline att triagera i WP0 innan WP1 bygger på V4-bryggan:** två
  `history ui`-tester, två `inventory`-tester (varje V1-verktygsmodul/V2-V3-fil ska ha ett
  dokumenterat beslut + markdown-rendering), `recovery: a failure class with no executable
  retry…` och `model selector explains an unavailable active choice…`. Inget av felen pekar
  på `host.js` verktygsregistrering, men det ska *bevisas* (kör dem isolerat, avgör om det är
  drift i `f0089c5`-squashen), inte antas. WP1 får inte börja på röd V4-baseline utan notering.
- **OBS om testkommandon:** `npm test` globbar bara `test/*.test.js` — V4- och V5-sviterna
  körs **inte** av den. "npm test grön" säger alltså ingenting om V5. Gates för varje PR:
  `npm test` + `npm run v4:test` + `npm run v5:test` + `npm run check` + `npm run i18n`.
- **GitHub CI på `main` @ `f0089c5` (2026-10-25):** grönt: fast offline contracts,
  job-form browser acceptance, win-runner-acceptance, build-exe. **Rött: `MAJIN V5 Windows
  Desktop & Setup.exe`.** Undersök den runnen i WP0 — release-vägen är en del av 100%.
- Historiska gröna rayonger (V1–V4, `handover.md`, `docs/MAJIN_100_STATUS.md` m.fl.) gäller
  sina egna spår/commits. De bevisar att *motorerna* fungerar — de säger inget om V5:s
  inkoppling. Läs `docs/v5/UNIVERSAL_AGENT_AUDIT.md`; den är ärlig om A–J-gapet och stämmer
  med denna audit.

---

## 6. Pågående arbete — öppna PR:er (duplicera inte!)

62 PR:er är öppna totalt. Det levande V5-spåret just nu:

| PR | Titel (kort) | Status | Åtgärd i denna plan |
|---|---|---|---|
| #440 | Verified procedures discoverable for Go models | **CONFLICTING** | `procedure-tools.js` finns redan på `main` — verifiera om PR:n är överflödig; rebase:a eller stäng med kommentar (WP0) |
| #443 | UI: readable chat/links/composer | MERGEABLE | Merga efter CI (påverkar inte motor) |
| #444 | Prefer DeepSeek Flash default (OpenCode Go) | MERGEABLE | Merga efter CI; bommar kategori 9 |
| #445 | **Browser write grants persist + resume utan ombyggnad** | MERGEABLE | **Prioritet.** API-halvan av R2-fixet. Kräver Windows E2E före merge enligt PR-text |
| #446 | **Live tool progress** (`/api/v5/goal/progress` + UI-rad) | MERGEABLE | Rund 1 av R5. Merga; WP6 bygger vidare till SSE |
| #447 | Honest V1 lane inventory vs live catalog (`driver_status`) | MERGEABLE | Merga — den är mätverktyget WP1 behöver |
| #448 | **Composer: återställ inmatning vid fel** | MERGEABLE | **Merga först** — lagar det röda V5-testet (§5) |
| #449 | Koppla in `sys.ps` read-only | MERGEABLE | ⚠️ Mönstret "ett verktyg i taget" — merga **inte** som strategi. Ersätts av WP1. (Kan mergas som isolerat bevis, men planera inte 125 sådana PR:er.) |
| #450 | `sys.ps` bara när process-runtime funkar | MERGEABLE | Samma som ovan — WP1 gör den överflödig |

Resten av de 62 (mest `v1/*`, `fix/v1-*`, `improve/*` från 2026-10-22 + #404 v4/main,
#400, #398, #389…): triagera i WP0. Fråga per PR: (a) rör den V1/V4-motor som WP1 ska återanvända?
(b) är den ersatt av senare arbete? (c) fortfarande grön mot aktuell `main`? Standard: stäng
med hänvisning om ersatt, annars rebase + kör gates. **Force-pusha aldrig någon annans gren.**

---

## 7. Arbetsplan WP0–WP9 (i ordning — varje paket = egna PR:er med poängutdelning)

Uppskattningar är kalendertid för en dev som återanvänder befintlig kod. Rapportera % kvar
enligt §2 efter varje merges paket.

### WP0 — Stoppa blödningen & öppna mätningen *(½–1 dag, +0 poäng men låser upp allt)*

1. Merga i ordning (efter grön CI på respektive head): **#448 → #447 → #446 → #445 → #444 → #443**.
   #445 kräver sin Windows E2E enligt PR-texten — kör den, fuska inte förbi.
2. Avsluta #440 (verifiera mot `main`; stäng/rebase). Pausa #449/#450 med kommentar
   "superseded by WP1 universal bridge" — eller merga som bevis, men **inför förbud mot fler
   enverktygs-PR:er**.
3. Triagera övriga 50+ PR:er (label `v1-legacy` / `v5` / `superseded`, stäng ersatta).
4. Diagnostisera röda *V5 Windows Desktop & Setup.exe* på `main` — rotfix, inte rerun-tills-grön.
5. Lägg denna scoreboard-tabell i `docs/v5/` som `SCOREBOARD_100.md` och uppdatera den i varje PR.
6. Städa `.majin-matrix-ws-*`; bestäm versionssanning (R8).

**Gate:** `v5:test` 0 fail; de 6 V4-baseline-felen (§5) triagerade — fixade eller bevisat
förexisterande med issue per fel; övriga testkommandon från §5 gröna på merge-resultatet.

### WP1 — Universell verktygsbrygga ⭐ *(största paketet, ~3–5 dagar, kategori 1: 4 → ~18)*

Mål: V5-modellen når **alla** verktyg som hosten + ägarens lanes tillåter — via V4-bryggan,
genom befintliga `CodexDriver` (idempotens bevaras).

1. I driverns worker (`codex-worker.js`/`codex-tools.js`): bygg katalogen med
   `hostCapabilities()` + `registerHostTools(registry, caps, { workspaceDir, cfg, dataFile,
   approvals, session, emit, folders })`. `emit` kopplas till driver-events (fixar även R2:s
   försvinnande `browser:blocked-request`). `folders()` = workspace + ägarens mappgrants,
   lästa vid anrop (som `v1Context` redan gör).
2. Avstämning lanes: `GRANTABLE_LANES` (23, V4 owner-mode) vs `V1_LANES` (20, host).
   Lägg i `V1_LANES`: `browser` (`browser.js`, Playwright, `browserRuntime`-gate redan finns),
   `desktop` ska även inkludera `desktop-app.js`; mappa `agent`/`channels`/`mcp` mot deras
   moduler (`agent.js`, `channels.js`, MCP-verktyg via `src/v4/mcp-tools.js`) eller explicit
   undantag med anledning. Behåll `risk→tier→approval`-kedjan (`RISK_TO_TIER`).
3. Ersätt den handplockade listan + betrodda specialfall:
   - Behåll `checkedPath`-realpath-regeln för V5-specifika verktyg (`documents_extract` m.fl.).
     För V1-verktyg: använd `path-access`/`v1Context.folders` som V4 gör — två parallella
     sökvägssystem är en säkerhetsbugg i väntan. Dokumentera den enhetliga regeln.
   - Egna adapter-verktyg som duplicerar riktiga (`jobs_search`, `jobs_match`) ersätts av de
     riktiga `jobs.*` när de registreras; behåll lokala seen-dedupe-hjälpen om den tillför
     något `jobs.search` saknar — annars bort. `documents_extract`, `skills_search/read`,
     `driver_status` blir kvar som V5-verktyg.
4. Lös browser-namnkollisionen enligt §3.1 (Playwright vinner; form-verktyg portas i WP4,
   men registrera dem inte i två versioner under tiden).
5. `driver_status` utökas: per lane `{ registered: n, skipped: [{tool, reason}] }` från
   `registerHostTools` retur + grants-läge. (PR #447 är grunden.)
6. `src/v5/inventory.js`: uppdatera reuse-matrisen från påstådd till uppmätt (texten påstår
   idag "144 V1 tools … adapt" — efter WP1 blir det sant; låt den genereras från verkliga
   registret istället för hårdkodad prosa).

**Acceptans (nya tester):**
- `test/v5/tool-parity.test.js`: med alla lanes beviljade i testmiljö ska varje namn i
  `ALL_TOOLS` + `browserTools` + `desktopAppTools` antingen finnas i driverkatalogen eller i
  en kodad `EXCLUDED_WITH_REASON`-lista. Testet faller på varje oredovisat verktyg.
  **Detta test är definitionen av "ingen lobotomi" framåt.**
- `test/v5/tool-context.test.js`: minst ett verktyg per tidigare onåbar familj körs genom
  drivern med äkta ctx (`research.run` nästlat, `re.hash` på fixture, `sys.info`, `net.dns`
  mot fixture/lokal, `jobs.search` mockad JobTech-payload, `tools.search`-ersättaren i WP2).
- Befintliga `v5:test` + `v4:test` gröna (bryggan får inte bryta V4).

### WP2 — Rätt verktyg, rätt schema *(~2 dagar, kategori 2: 4 → ~9)*

1. Montera `createToolExposure({ registry, maxVisible: 64 })` i `provider-agent.js` (och
   delegaternas katalog i `adaptive-delegation.js`): core + aktiverade alltid med,
   `tools_search`/`tools_activate` som host-verktyg. Systemprompten säger att listan kan vara
   partiell och hur fler verktyg aktiveras (V4:s formulering finns i `src/v4/agent.js`).
2. Döda schema-rekonstruktionen i `codex-tools.js` (regex på prosa, tal-klipp
   `0..4000000` — den bryter legitima negativa/stora värden). Använd bryggans
   `zodFromV1Params`/`jsonSchemaFor`. Där en V1-paramsbeskrivning är tvetydig: fixa vid
   källan (`def({params, required})`), inte med nya gissningar.
3. **Kontraktbatteri per verktyg** — `test/v5/tool-contracts.test.js`: tabell med fixturargument
   per verktyg (read: fixturer; write: temp-workspace; net/browser: lokal server; destruktiva:
   dry-run/vägran utan mandat). Asserta returkontrakt (`ok`/strukturerat fel med kod), aldrig
   ohanterat kast. Generera täckningstabell till `docs/v5/TOOL_VERIFICATION.md` (mönster:
   `docs/v4/TOOL_VERIFICATION.md`).
4. Verktygsvalseval (offline): mock-provider som returnerar förväntade anrop för ~20
   kanoniska prompts och verifierar plumbing — samt mät att `tools_search`-flykthålet inte
   behövs för core-familjerna. (Live-modellvarianten körs i WP9.)

### WP3 — Behörigheter ägaren faktiskt kan ge *(~1–2 dagar, kategori 8: 1 → 5; låser upp kat 1 i praktiken)*

1. **First-run-val** i UI:t när `owner-mode.json` saknas: tre tydliga lägen —
   *Full ägaråtkomst (mina lanes, mina mappar)* / *Fråga vid känsliga åtgärder* / *Nedlåst*.
   Valet persisteras via befintliga `POST /api/v5/access`. Ingen förvald fullåtkomst utan
   klick; ingen omöjlig curl-akrobatik för att komma igång heller.
2. **Inställningspanel:** alla 23 lanes med toggles (svensk/engelsk text via `strings.js`),
   mappar (följ `normaliseFolder`-reglerna — drivrot vägras redan), browser-origins-lista
   (lägga till/ta bort, från #445-API:t), revoke + nödstopp synligt. Visa `describeAccessState()`
   inklusive `osAdminElevated`-separationen ordagrant så ingen tror att detta är UAC.
3. `majin-v5 --help` dokumenterar `--submit-origin` (headless-vägen blir kvar).
4. När ett mål blockeras av saknad lane/origin ska felet säga exakt vilken grant som saknas
   och UI:t erbjuda knappen (→ WP4:s `WAITING_USER`-flöde). Aldrig generiskt `BLOCKED`.

**Acceptans:** `test/v5/access-ui.test.js` (färsk data-dir → first-run → grant web/shell →
samma process ser verktygen nästa mål, utan restart av servern — observera att
`ProviderAgent` redan läser grants vid målets start och abortar vid grant-ändring mitt i;
behåll den semantiken och testa den).

### WP4 — Webb end-to-end på riktigt *(~2–3 dagar, kategori 3: 5 → ~13)*

1. Porta form-verktygen från web-lanen ovanpå Playwright-sessionen: `browser.form` (outline),
   `browser.form_fill` (med exakt preview), `browser.verify`, `browser.elements`,
   `browser.read`, `browser.shot`, `browser.clear_marks`, `browser.form_submit` (destruktiv —
   kräver origin-grant + mandat, samma mönster som idag). Återanvänd klassificeraren i
   `src/core/browser-form.js`/`jobs/formfill.js` istället för att skriva ny.
2. **Blockerade anrop ska synas:** ta med `state.blockedRequests` (metod/origin/path — aldrig
   body/query) i varje browser-verktygs resultat + emit-event till trace (WP6). När en
   skrivning blockeras av o-beviljad origin → målet går till `WAITING_USER
   { needed: 'browser_origin', origin }`. Ägaren beviljar (UI/CLI) → resume (WP3/#445) → arbetet
   fortsätter i **samma** beständiga profil/session (starta inte om från noll; browsern måste
   överleva grant-pausen — idag dör workern vid driver-close, så håll sessionen eller
   checkpointa formulärläget ärligt).
3. **Login/CAPTCHA-handoff:** detektera (URL/DOM-mönster, finns delvis i browser-recovery-
   modulerna i `src/core/browser-*.js`) → `WAITING_USER` + öppna **synligt** fönster
   (`headless:false`) på samma profil → ägaren loggar in/löser → "Fortsätt" → resume.
   Dokumentera: legitimationer skrivs aldrig av modellen om ägaren inte explicit ger dem som
   uppgift, och lagras aldrig i trace/repo.
4. **Nedladdningar:** `browser.download` (vänta på download-event → workspace under
   `checkedPath` → returnera sökväg + sha256 + storlek). `web.download` blir nåbart via WP1 —
   se till att browser-vägen täcker inloggade/session-bundna nedladdningar.
5. Osäker submit-regeln stärks: efter submit ska bekräftelse *observeras* (kvittens DOM/text/
   URL) innan framgång rapporteras; vid osäkerhet inspekteras först (driver-records finns),
   aldrig blind re-submit. Knyts till `browser`-verifieraren i WP5.

**Acceptans:** befintlig `scripts/v5/codex-autonomous-accept.mjs` (lokal portal: radio/select/
dynamiskt fält/CV-uppladdning/submit/MOTTAGEN+SHA256) körs via **provider-vägen** i CI med
Chromium; nytt test: obeviljad origin → `WAITING_USER` → grant → resume → exakt en submit;
nytt test: blockerad POST syns i verktygsresultatet.

### WP5 — Verifiera allt, inte bara filer *(~2 dagar, kategori 4: 3 → 10)*

1. Generalisera kriteriekörningen i `provider-agent.js` via `verifierRegistry`:
   aktivera `http` + `dom`, lägg till `command` (host kör via den registrerade shell-vägen med
   målets grants, exitkod + stdout-mönster), `browser` (urlMatch + domText på öppen sida),
   `json` (sökväg parses + enkel schema/dotpath-assertion), `research` (alla käll-URL:er i
   resultatet förekom i målets hämtningar). Varje verifierare får eget test i
   `test/v5/verifiers.test.js`.
2. **Standardkriterier när UI/CLI inte skickar några:** hosten härleder deterministiskt
   utifrån leveranstyp — producerad kodfil ⇒ `node --check`/testkommando om sådant finns;
   skapad fil ⇒ exists + (contains om ägaren angav exakt innehåll); web-submit ⇒
   bekräftelsekvitto; researchfråga ⇒ källkrav; ren fråga ⇒ `answer`. Härledningen loggas i
   trace så ägaren ser vad som kontrollerades. Ägare/CLI kan alltid överskriva med explicita
   kriterier (`--criteria fil.json`).
3. Slutsemantik: `COMPLETED` (verifierad effekt eller besvarad fråga utan effekter),
   `PARTIAL` (delar bevisade, resten namngett), `FAILED`, `BLOCKED` (konkret extern orsak),
   `WAITING_USER` (ägaren kan lösa det — med exakt åtgärd), `CANCELLED`. XP/lärande
   **endast** vid verifierad effekt (oförändrat golv). UI-texter via `strings.js`; sluta visa
   "delvis klart" för rena svar.
4. Reparationsloopen ("verifiering föll → laga → kontrollera igen") generaliseras till alla
   kriterietyper (budget från WP8, default 2 som idag).

### WP6 — Se allt, live *(~2 dagar, kategori 6: 2 → ~9)*

1. `GET /api/v5/goal/events?goalId=` (SSE; mönster från `codex-host.js`, inkl.
   `Last-Event-ID`-replay). `POST /api/v5/goal` svarar `202 {goalId}` omedelbart;
   UI:t abonnerar och kan koppla om. (Behåll ev. `#446`-pollningen som fallback för
   mobil-proxyer, eller ersätt den helt — bestäm och dokumentera.)
2. Eventtyper: `goal_started`, `plan_updated`, `tool_start`, `tool_end`
   (verktyg, redigerade argument, ok/felkod, ms, resultatsammandrag ≤280 tecken,
   operationId), `browser_blocked`, `verification` (per kriterium pass/fail + evidens),
   `waiting_user`, `goal_end` (status + kostnad + XP). Persisteras som
   `<dataDir>/goals/<goalId>/trace.jsonl` + evidensfiler härledda. Skrubba med befintliga
   sekretessmönster; tester assertar att API-nyckelmönster aldrig hamnar i trace.
3. UI: live verktygsfeed under det pågående målet (en rad per verktyg, expanderbar detalj,
   screenshots/kvitton som bilagor), elapsed + verktygsantal (uppmätt — aldrig påhittad ETA %),
   Stop/Pausa/Styr-knappar mot befintliga endpoints, "Ladda ner trace".
4. `goal.tool_results` får `argsRedacted`, `durationMs`, `resultSummary` (bryt inte gamla
   läsare — fälten är additiva).

### WP7 — En riktig CLI *(~2 dagar, kategori 7: 2 → ~9)*

Tunn klient mot samma server/motor (startar host vid behov, som `status` redan gör mot
`/api/health`). Ingen ny agentloop.

```
majin-v5 run "<mål>" [--criteria fil.json] [--budget rounds=200,minutes=60]
                       [--json]            # NDJSON-events; exitkod efter slutstatus
majin-v5 chat                             # REPL mot samma målhistorik
majin-v5 tools [search <ord>] [--json]    # hela katalogen: namn/lane/tier/status+anledning
majin-v5 doctor                           # node, chromium, provider+modell, lanes, profil,
                                          # workspace — PASS/FAIL per rad (återanvänd v4 host-doctor-mönster)
majin-v5 grants [set <lane>=on|off] [folders add <path>] [origins allow|revoke <origin>]
majin-v5 goal [status|pause|resume|stop|steer "<text>"]
majin-v5 trace <goalId> [--follow]        # samma events som UI:t
majin-v5 serve|window|status|version     # befintliga, oförändrade
```

Exitkoder: `0` COMPLETED, `2` PARTIAL, `3` WAITING_USER, `4` BLOCKED, `5` FAILED,
`130` CANCELLED. Dokumentera i `--help` (inkl. `--submit-origin`).
**Acceptans:** `test/v5/cli.test.js` — spawn-tester med serverns befintliga injektionsseams
(`completeImpl` i `createV5Server`) via env-seam för mock-provider i testläge; verifierar
NDJSON-form och exitkoder. `tools --json` ska mataren parity-testet (WP1) så att dokumenterad
räckvidd aldrig kan drifta från verklig.

### WP8 — Långt, parallellt, oavbrutet *(~3 dagar, kategori 5: 4 → ~9)*

1. **Flera mål samtidigt:** `ProviderAgent` → mål-kö med N workers (default 3). Per mål egen
   driver/`stateDir` (finns redan parametriserat). Delade resurser låses per resurs, inte
   globalt: browser-profil och desktop = seriella; fs/web/research = parallella mellan mål.
   Ett mål per browserkontext åt gången (session-nyckeln i `browser.js` är redan per session —
   ge varje mål egen session-nyckel).
2. **Parallella oberoende tool-calls** i samma modellsvar: read-tier körs parallellt (per-mål
   worker-pool), write/process seriellt i anropsordning. `CodexDriver.busy` ersätts med
   resursmutex; idempotens oförändrad.
3. **Budget istället för dolda tak** (synlig i UI/CLI/trace, ägaren kan sätta per mål):
   `maxRounds` default **200**, väggtid default 60 min, verktyg-timeout per verktyg
   (default 120 s; `shell.run`/testsviter upp till 30 min med heartbeat-events så det syns
   att den lever), kostnadstak valfritt. Vid budgetslut: checkpoint + `PARTIAL`/`BLOCKED` med
   "Fortsätt"-åtgärd — aldrig tyst död. Tool-calls >32/svar ⇒ köa extra istället för att kasta.
4. **Kontextkomprimering:** när historiken passerar tröskel (andel av modellens
   `contextWindow` från provider-katalogen) sammanfattas gamla verktygsresultat deterministiskt
   från operation-records (verktyg + status + resultatsammandrag + evidensreferenser) +
   bibehållna kriterier/plan/checkpoints. Råhistorik finns kvar på disk; ingen information
   hittar pås i sammanfattningen.
5. Identiskt-fel-banningen: häv bannad signatur när miljön ändrats (grant tillagd, fil ändrad,
   ny resume med ägaråtgärd) — behåll skyddet mot blind loop, men lås inte legitima försök.
6. Aktivera provider-**streaming** när capability-flaggan säger ja (token-events till trace/UI);
   fallback till `stream:false` vid providerspecifikt fel, loggat.

**Acceptans:** 3 mål parallellt (fs + web-fixture + kod) utan korskontaminering; syntetiskt
150-rundors mål når COMPLETED; kill -9 mitt i mål ⇒ start ⇒ resume ⇒ exactly-once för extern
effekt (lokal portal räknar submits); komprimeringstest med konstgjord historik.

### WP9 — Live-batteriet som bevisar 100% *(~2–3 dagar + CI-tid, kategori 9/10 + restpoäng)*

Definiera **25 uppgifter** (prompt + kriterier + verifierare) i `scripts/v5/battery-100.mjs`
+ `docs/v5/evidence/`. Minst:

- Kod: bygg CLI + tester från brief; laga trasig ESM/CJS-repo; kör projekts tester och rapportera.
- Filer/dokument: PDF/DOCX/CID-extraktion → sammanfattning i fil; stor fil via streaming-vägen.
- Webb (lokal portal): hela formulärvägen inkl. radio/select/dynamiskt fält/uppladdning/submit/kvitto.
- Webb (offentligt, läs): 3 riktiga sidor med dom/källkriterier; nedladdning med hashbevis.
- Jobb: Platsbanken-sök → dedupe → CV-match → *prepare* (aldrig riktig submit i CI) med previewbevis.
- Research: jämförelsefråga, `research`-kriterium (alla påståenden källsatta från målets hämtningar).
- System: `sys.*`, `net.*`, `exec.*` (start/logs/wait/cancel), `re.*` på binärfixture (hash/strings/sections).
- Desktop (Windows interaktiv runner): Notepad skriv/spara/bevisa filinnehåll; screenshot-kvitto.
- Återhämtning: felaktig argument → strategibyte; provider-timeout-injektion; avbryt/styr om mitt i.
- Paralellt: två mål samtidigt (WP8) + delegerad research med uppmätt tidsvinst annars ärlig NOT_BENEFICIAL.

Körs på GitHub-hostad Windows + självhostad interaktiv runner för desktop-punkterna;
OpenCode Go som provider (aldrig lokal Qwen). Varje uppgift: PASS kräver verifierarkvitto +
trace bifogad. **100% deklareras först när:** batteriet ≥90% PASS (och varje FAIL är ett
namngett externt hinder, inte MAJIN-lobotomi), parity + kontraktsbatteri gröna, alla fem
testkommandon (§5) gröna, Windows Desktop CI grön — **samma commit**. Publicera då release
enligt befintlig process med SHA256 på faktisk nedladdad installer (jfr `ARENA.md`-checklistan).

---

## 8. Definition of Done per PR (klistra in i varje PR-beskrivning)

```
Scoreboard före:  nn/100   Efter: nn/100   (−n procentenheter kvar)
Kategorier som ändras: #… (+x, evidens: <testnamn/run-länk>)
Körda gates (samma head): npm test ☐  v4:test ☐  v5:test ☐  check ☐  i18n ☐
Nya/ändrade tester: …
Fake-pass-kontroll: inga mockar presenterade som live ☐  inga hemligheter i diff/logg ☐
```

Regler: inga poäng för "kod finns" — bara för mätt beteende. Sänk aldrig en gate för att bli
grön. Merga aldrig med röd obligatorisk CI. Ändra en sak i taget; WP-ordningen rubbas bara
med motivering i PR:n.

---

## 9. Reproducera audit-siffrorna

```bash
npm ci --ignore-scripts

# Universumet: 155 verktyg
node --input-type=module -e "
import { ALL_TOOLS } from './src/core/tools/index.js';
import { browserTools } from './src/core/tools/browser.js';
import { desktopAppTools } from './src/core/tools/desktop-app.js';
const u = new Set([...ALL_TOOLS.map(t=>t.name), ...browserTools.map(t=>t.name), ...desktopAppTools.map(t=>t.name)]);
console.log('ALL_TOOLS', ALL_TOOLS.length, 'universe', u.size);"
# → ALL_TOOLS 149, universe 155 (5 namnkollisioner browser.* mellan web.js och browser.js)

# Vad V5-modellen faktiskt ser (färsk install vs alla lanes; Linux = ingen Windows/browser-binär)
node --input-type=module -e "
import { createDriverTools } from './src/v5/codex-tools.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const ws = fs.mkdtempSync(path.join(os.tmpdir(),'m-'));
for (const [label, lanes] of [['fresh',[]],['all-lanes',['files','shell','web','browser','desktop']]]) {
  const t = await createDriverTools({ workspace: ws, grantedLanes: lanes,
    processAccess: lanes.includes('shell'), browser: lanes.includes('browser'), desktop: lanes.includes('desktop') });
  console.log(label, t.size, [...t.keys()].sort().join(',')); }"
# → fresh 14 …  all-lanes(linux) 18 …  (+5 host-verktyg i provider-agent.js; Windows+Chromium max ≈ 36+5)
```

Onåbara-per-risk och per-prefix: jämför `ALL_TOOLS`-namnen mot filterlistorna i
`src/v5/codex-tools.js:46–52` (125 onåbara, 64 st `risk:'read'`). Efter WP1 körs samma
jämförelse av `test/v5/tool-parity.test.js` — då ska outputen vara 0 oredovisade.

Nyckelplatser i koden (radnummer på `f0089c5`):

| Vad | Var |
|---|---|
| Allowlisten som ska bort | `src/v5/codex-tools.js:46–52` |
| Bantad ctx | `src/v5/codex-tools.js:45` |
| Submit/icke-GET-blockering | `src/core/tools/browser.js:95–160` (init-script + route) |
| `--submit-origin` enda grant-vägen | `bin/majin-v5.mjs:83` (saknas i help) |
| Routing provider vs architect | `src/v5/server.js:88`, goal-route `:196` |
| `COMPLETED` kräver filkriterier | `src/v5/provider-agent.js` (loops `!calls.length`-gren) |
| UI skickar aldrig kriterier | `src/v5/ui/app.js:392–396` |
| 32 rundor / 120 s / 16 k-trunkering | `src/v5/provider-agent.js:17,85`, loopkroppen |
| Ett verktyg i taget | `src/v5/codex-driver.js` (`busy`) |
| Grants-API utan anropare | `src/v5/server.js:252–267`, `src/v5/files-access.js:305` |
| V4-bryggan att återanvända | `src/v4/tools/host.js:53,104,313,342,431,500`; `src/v4/tool-exposure.js` |
| Verifierare som redan finns | `src/v2/runtime/verifiers.js:138` (file/http/pixel/dom) |

---

## 10. Miljö & fallgropar (spar timer åt dig)

- **OpenCode Go:** endpoint `https://opencode.ai/zen/go/v1/chat/completions`; headern
  **`x-opencode-session` är obligatorisk** (annars `MissingSessionID`) + `User-Agent: majin-v5/…`.
  Nycklar bor i env/lokal konfig — **aldrig** i repo, PR-text eller trace. (`handover.md`
  har historik om zen/go-ytorna; V5 använder Go.)
- **Testa live ≠ mocka:** provider-live kräver riktig nyckel i CI-secrets; saknas den skrivs
  `BLOCKED: missing credential`, aldrig PASS. Samma för kanalbots (W8-historik).
- **Windows-evidens krävs för desktop/browser-påståenden.** Linux-containern kan inte bevisa
  UIA/Notepad/interaktiv session. Använd `windows-latest` + self-hosted interactive runner
  (`win-acceptance`-mönstren finns i `.github/workflows/`).
- **`npm install` före tester** i färsk checkout (snapshot kan sakna `node_modules` —
  `js-yaml/chokidar`-fel annars). Playwright-tester skippar tyst utan Chromium — kontrollera
  alltid *varför* en skip inträffade innan du räknar grönt.
- **git-identitet/remote kan vara rensade i sandlådor** (`empty ident name`,
  `'origin' does not appear…`) — sätt `user.name/email`, `git remote add origin …` först,
  felsök credentials sedan. (Historik i gamla `handover.md`.)
- Källkodssträngar på svenska ⇒ `i18n`-testet faller. Använd `strings.js`.
- Self-auditen flaggar claim-ord i levererad kod (`renderMarkdown` m.m.) — håll
  marknadsföringsspråk i docs, inte i `src/`.

---

## 11. Vad 100% *inte* betyder (så ingen säljer luft)

- Inte att MAJIN kringgår CAPTCHA/MFA/betalväggar eller bryter mot sajters villkor.
  100% = MAJIN saknar **egna** hinder: alla verktyg nåbara/använda rätt, blockerare hos
  omvärlden hanterade via handoff/alternativ väg med ägarens mandat.
- Inte att alla 155 verktyg är synliga samtidigt i varje prompt (det försämrar verktygsval,
  uppmätt i V4). 100% = allt **nåbart på begäran** (`tools_search`/`activate`) och redovisat.
- Inte att XP/level bevisar förmåga. XP delas bara ut på verifierade utfall — behåll det
  golvet exakt som det är; det är en feature, inte lobotomi.
- Inte "inga säkerhetsfrågor någonsin". Destruktivt (skicka ansökan, radera, betala, posta)
  kräver ägarens mandat/preview — men mandatet ska vara **ett klick i flödet**
  (`WAITING_USER`), aldrig en processomstart med hemlig flagga.

---

## 12. Överlämning — status för denna leverans

- [x] Fullständig audit mot koden på `f0089c5` (V1–V5, live-vägar, tak, grants, verifiering, UI, CLI)
- [x] Verktygsuniversum och V5-räckvidd **uppmätt programatiskt** (§9), inte uppskattat
- [x] Tester körda: `check`+`i18n` PASS · `npm test` 1448/0/19 · `v5:test` 65/1/2 med namngivet fel (§5)
- [x] Öppna PR:er #440–#450 inventerade med åtgärd per PR (§6); CI-läge på `main` kontrollerat
- [x] Scoreboard definierad med ägarens 100%-kriterium: **produkten 30/100 → 70% kvar** (§2)
- [x] Arbetsplan WP0–WP9 med exakta filer, återanvändningsvägar och acceptanstester (§7)
- [ ] Dev exekverar WP0 → WP9 och uppdaterar scoreboardet per PR (ägarens %-rapportering)
- [ ] 100% deklareras först vid WP9-gaten på en och samma commit

**Nästa konkreta handling (dev, dag 1):** WP0 punkt 1 — merga #448, kör de fem gatesen,
rapportera därefter % kvar (fortfarande 70 — #448 tar inga nya poäng, den gör sviten grön)
och fortsätt direkt med #447/#446/#445. Sedan WP1. Fråga inte ägaren om lov mellan stegen —
det här dokumentet är mandatet.

*— Arena-agent, 2026-10-25. Alla påståenden ovan är kontrollerade mot repot på commit
`f0089c5`; reproducerbara med kommandona i §9. Det jag inte kunde verifiera i Linux-miljön
(fysisk Windows-GUI, riktig Chromium-submit här, live provider-anrop) är markerat som exakt det.*
