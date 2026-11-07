
## W11 Windows desktop vision — VERIFIED-CORE (runda 36, 2026-10-21)

**Reuse-principen i praktiken:** `absorb microsoft/UFO` kördes i sandlådan först — 851 filer, MIT-licens, 304 test-filer. Det som återanvänds är **arkitektur + disciplin, aldrig innehåll**: HostAgent→AppAgent uppgifts-upplägget, och framför allt UFOs conditional-import-pattern (deras `grounding/basic.py` vägrar ladda pywinauto på icke-Windows istället för att krascha — samma princip som MAJINs `platformGate` + deferred-markering). Kompositionen är MAJINs egen: `vision.js`-analysören + `computer-use.js observe`-sömmarna.

### Levererat (core-verifierbart — allt mätbart i sandlådan)

1. **`src/core/desktop-vision.js`** (`majin-desktop-vision/1`)
   - `captureFn` är **injicerad** — saknas den, refuseras observationen (`DesktopVisionError`). En "visionsanalys" av en skärm vi aldrig sett är en lögn.
   - `captureEvidence` skriver screenshot-bytes + **sha256** till disk **före** analys.
   - `groundTargets` accepterar **bara** den strikta koordinat-kontrakten `[{label,x,y}]`; prosa-svar ("klicka ungefär i mitten") → refusal. Gissade klickkoordinater är exakt felet som bränner desktop-agenter.
   - `verifyOnScreen` kräver callers `accept(answer)` — aldrig "modellen sa ja" som bevis. Oavsett outcome skrivs en verdicts.jsonl-rad (misslycket är också evidence).
   - `platformGate`: live lane finns **bara** på `win32`; `linux` → `deferred-hardware-required`.

2. **`src/core/desktop-eval.js`** (`majin-desktop-eval/1`)
   - Diskrimineringskontrakt (samma disciplin som competitive-bench): simulerade verifierare **MÅSTE** passa good-end-state **och** faila bad-end-state, annars **FLAGGED** med cheat-vs-broken-distinktion i why.
   - `windows-real` på icke-Windows-host → **DEFERRED: hardware-required** — aldrig pass, aldrig fail, aldrig fabrikerad.
   - `aggregateDesktop`: deferred räknas separat; `healthy` kräver flagged=0; `agentLanesLive: pending-hardware — declared, never fabricated`.

3. **Tre egna desktop-tasks** (`benchmark/desktop-tasks/`, eget innehåll)
   - `notepad-write-save`: sanningen ligger i spec.json; note.txt-bytes mäts (samma mått som live-lanens "läs de sparade bytena").
   - `window-title-observe`: ground truth i state.json vs agentens claim i answer.txt — observationsskillnaden som måste bevisas före aktion.
   - `rename-file-dialog-win` (**WINDOWS REAL LANE**): verifier mäter **%TEMP%-filsystemet** (process.env.TEMP, läst byte-level) — aldrig en talad claim. `scripts/windows/desktop-eval-setup.ps1` seedar + *läser tillbaka* (read-back discipline) och rensar stale renamed-filer för ren mätning. Icke-Windows-host → exit 3 = deferred.

### Mätvärden

- `test/desktop-vision.test.js` **7/7**, `test/desktop-eval.test.js` **6/6** (13/13)
- `node scripts/desktop-bench.mjs --save`: **2/3 verified, 1 deferred, flagged=0, healthy ✓** → `docs/evidence/desktop-bench-2026-10-21.{json,md}`
- Full regression: **846 → 859/0/17**
- Hygien: self-audit (W1-4 claim-language guard) fångade en "100/100"-formulering i renderMarkdown under rundan — neutraliserad före push. Audit som aktivt skydd, inte pappersövning.

### Ärlig rest (CAP oförändrad)
W11:s **live** screenshot-/visions/UFO-eval-körning kräver Windows-hårdvara (screenshot-to-ground-to-act med wincontrol-bryggan på användarens maskin). Core-maskin sanning är nu verifierad; spårstaven ligger kvar på **99** tills W11-live + W12 interaktiv acceptance körts på riktig hårdvara. Nästa steg mot 100: kör `scripts/windows/desktop-eval-setup.ps1` + live-lanen på användarens Windows-maskin, spara mätningen i docs/evidence, därefter stängs CAP.
