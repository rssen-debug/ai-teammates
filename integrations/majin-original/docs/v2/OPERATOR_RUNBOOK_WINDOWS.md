# MAJIN V2 — Operator Runbook (Windows)

Mål: få hela V2-ytan igång på din maskin — runner, Studio med alla paneler,
voice, modellkörningar — med ärlig status per steg. Varje flagga i denna
runbook är testbevakad (`test/v2-runbook-consistency.test.js` — sviten faller
om dokumentet drar sig från koden).

Regelkort som gäller här också: inga hemligheter i repot, consent betalas av
namngiven människa, bevis = aftercondition, aldrig simulation.

---

## 0. Förutsättningar

- Windows 10/11, Node.js ≥ 20 LTS, Git for Windows.
- Repot klonat lokalt där du vill köra (exempel: `%USERPROFILE%\MAJINCLI`).
- Installera byten en gång:

```powershell
cd $env:USERPROFILE\MAJINCLI
npm ci
```

---

## 1. Starta runnern (MAJIN-INTERACTIVE-01)

Runnern måste vara **UPPE** för live-GUI-QA-lanen (f.n. blockerad — se ärlig
status i docs/v2/ACCEPTANCE_MATRIX.md).

```powershell
cd $env:USERPROFILE\majin-runner
.\run.cmd
```

Verifiera att den lyssnar innan du fortsätter (se run.cmd:s utskrift).

---

## 2. Modellnyckeln — env-var, aldrig args, aldrig repo

OpenCode Go-nyckeln sätts som miljövariabel. Aktuell session:

```powershell
$env:OPENCODE_API_KEY = "oc_sk_DIN_NYCKEL"
```

Permanent (ny terminal krävs):

```powershell
setx OPENCODE_API_KEY "oc_sk_DIN_NYCKEL"
```

Nyckeln läggs **aldrig** i kommandoargument (processlistor) eller i repot.
Bannern visar `keyRef` + `sha256:keyHash` — aldrig nyckeln själv.

---

## 3. Studio — operator-ytan (read-only-först)

```powershell
node bin/majin-v2.mjs --studio --port 4783 --telemetry-dir .\v2-telemetry --audit-dir .\v2-audit
```

Öppna http://127.0.0.1:4783 i webbläsaren. Standard: **read-only** — alla
skrivytor är avstängda tills du uttryckligen slår på dem.

Verifiera kedjan direkt:

```powershell
node bin/majin-v2.mjs --audit-verify .\v2-audit
```

### 3.1 Consent-skrivningar (operator grants)

```powershell
node bin/majin-v2.mjs --studio --port 4783 --telemetry-dir .\v2-telemetry --audit-dir .\v2-audit --enable-writes
```

Consent-panelen blir aktiv. Varje grant/revoke speglas i den tamper-evidenta
kedjan (`--audit-verify` visar dem).

### 3.2 Målkörningar från UI:t (1 grant = 1 körning)

```powershell
node bin/majin-v2.mjs --studio --port 4783 --telemetry-dir .\v2-telemetry --audit-dir .\v2-audit `
  --enable-writes --enable-goals --goal-workspace .\v2-run --profile opencode-go --model glm-5.3-flash
```

Flödet i UI:t: Goal runs-panelen säger *consent required* → Consent-panelen:
scope `studio:run-goals`, ditt namn, mode `once` → Run objective. En grant
konsumeras per körning; överlapp vägras ärligt (409) utan att bränna grant.

### 3.3 Voice

Offline-först (spelbar WAV utan nätverk, noll consent):

```powershell
node bin/majin-v2.mjs --studio --port 4783 --telemetry-dir .\v2-telemetry --audit-dir .\v2-audit `
  --enable-writes --enable-voice --voice-dir .\v2-voice
```

Extern TTS (Microsoft Edge-röster, bl.a. svenska `sv-SE-SofieNeural`) —
kräver `voice:external`-grant per syntes:

```powershell
node bin/majin-v2.mjs --studio --port 4783 --telemetry-dir .\v2-telemetry --audit-dir .\v2-audit `
  --enable-writes --enable-voice --voice-dir .\v2-voice --voice-tts edge
```

STT via whisper.cpp på din maskin (ladda hem binär + modell separat; t.ex.
`whisper-cli.exe` + `ggml-small.bin`):

```powershell
node bin/majin-v2.mjs --studio --port 4783 --telemetry-dir .\v2-telemetry --audit-dir .\v2-audit `
  --enable-writes --enable-voice --voice-dir .\v2-voice `
  --voice-stt-command "C:\bin\whisper-cli.exe -m C:\bin\ggml-small.bin -f {WAV} --output-txt --no-prints"
```

Utan `--voice-stt-command` svarar listen-ytan ärligt 403 — inget fabricerat
transcript någonsin.

---

## 3.4 Bevispärm (evidence dossier)

Exportera en bärbar verifieringspärm — publikt material endast, t.ex. att
skicka till en granskare som aldrig sett din maskin:

```powershell
node bin/majin-v2.mjs --audit-export .\v2-audit --out .\v2-dossier
node bin/majin-v2.mjs --bundle-verify .\v2-dossier
```

Studio-varianten: lägg till `--bundle-dir .\v2-dossier` i studio-kommandot →
"Evidence dossier"-panelen får Export/Verify-knappar (samma API:er, samma
vägransklasser, destinationen kan aldrig styras av klienten).

Doctor-panelen i Studio: lägg till `--enable-doctor-panel` (ev. med
`--runner-url http://127.0.0.1:PORT/health` och `--doctor-whisper-bin <sökväg>`)
→ samma preflight som CLI:n, körbar med knapp; nyckeln renderas bara som
fingeravtryck.

## 4. Audit-spår: verifiera, signera, bevittna

Kedjan bevisar intern konsistens; **anchors** stänger hålet "hel kedjan
omskriven". Engångs-setup:

```powershell
node bin/majin-v2.mjs --audit-keygen .\v2-audit
```

Privat nyckel: `0600`-skyddad i `.\v2-audit\keys\` — flytta/kopiera den gärna
offline. Verifieraren behöver bara den publika.

Signera ett checkpoint:

```powershell
node bin/majin-v2.mjs --audit-anchor .\v2-audit
```

Fullständig kontroll (kedja + signatur):

```powershell
node bin/majin-v2.mjs --audit-verify .\v2-audit --with-anchor
```

Honest svarskoder: `ANCHOR OK` / `ANCHOR NO_ANCHOR` (obevittnat —
inconclusive, inte falskt OK) / `ANCHOR ANCHOR_MISMATCH` (omskrivning
upptäckt) / `ANCHOR SIG_INVALID`.

---

## 5. Direkta körningar utan Studio

```powershell
# Enkelt mål, ärlig exit (0=COMPLETED, 1=FAILED, 2=missbruk):
node bin/majin-v2.mjs "build a modern portfolio website and show it" --workspace .\v2-run

# Med modellen (planner delar upp bygget):
node bin/majin-v2.mjs "build a modern portfolio website and show it" --workspace .\v2-run --profile opencode-go --planner-model

# Tjänstestatus:
node bin/majin-v2.mjs --telemetry-report .\v2-telemetry --days 7
node bin/majin-v2.mjs --gauntlet
```

Saknad `OPENCODE_API_KEY` ger exit 2 **innan** någon trafik skickas —
vägran är testbevisad (stub-servern såg exakt 0 anrop).

---

## 6. Ärlig statuskolumn för denna runbook

| Yta | Status här (sandbox) | Status på din maskin |
| --- | --- | --- |
| CLI/flaggor i runbooken | VERIFIED (doc-consistency-testet) | ska fungera som dokumenterat |
| Studio read-only + panels | VERIFIED offline | förväntat identiskt |
| Consent/goals/voice API | VERIFIED offline | förväntat identiskt |
| PowerShell-kommandon som skrivna | NOT_TESTED (ingen Windows i sandbox) | din första körning blir beviset |
| Live opencode-anrop | NOT_TESTED här (extern handling) | kräver din nyckel |
| Edge-TTS svensk syntes | VERIFIED live (#333, mp3 i deliverables) | förväntat identiskt |
| whisper.cpp STT | NOT_TESTED (ingen binär i sandbox) | kräver din binär |
| Live-GUI-QA | NOT_TESTED — runner offline än så länge | starta runnern (steg 1) |

Rapportera avvikelser rakt: `node bin/majin-v2.mjs --telemetry-report .\v2-telemetry --days 1` och kedjan säger sanningen om vad som hände.

Modellistan: `node bin/majin-v2.mjs --models-refresh` (kräver nyckeln i env) lagrar dagens sanningslista lokalt; `node bin/majin-v2.mjs --models` visar den med ärlig FRESH/STALE-märkning och drift mot den statiska profilen.
