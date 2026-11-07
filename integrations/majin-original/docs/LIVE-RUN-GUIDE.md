# MAJIN LIVE-RUN GUIDE — vägen från 99 till 100 (2026-10-21)

Allt som inte kan bevisas från sandlådan är **hårdvaru-deferred av principskäl**:
screenshots och en synlig pink cursor kräver en riktig Windows-desktop-session, och
full research-egress kräver ett nät som inte är sandbox. Denna guide gör din
maskinkörning till **en enda kommandorad + fem minuter interaktiv koll**.

## 1. Prep (en gång)

```powershell
git clone https://github.com/rssen-debug/MAJINCLI.git
cd MAJINCLI
git checkout fix/realworld-repairs
npm ci
```

## 2. Det automatiska paketet (en kommandorad)

```powershell
powershell -File scripts/windows/live-acceptance-run.ps1
```

Den gör tre saker och **skriver alla bevis till `docs/evidence/live-run-<datum>/`**:

| Lane | Vad körs | Vad räknas som bevis |
|---|---|---|
| **A. W11-live desktop eval** | `desktop-eval-setup.ps1` seedar + läser tillbaka → en *manual-reference rename* sker med RIKTIGA filoperationer → verifiern `benchmark/desktop-tasks/rename-file-dialog-win/verify.mjs` **mäter det riktiga %TEMP%** → `desktop-bench.mjs --save` verifierar diskrimineringskontrakten på win32 | Verifierns exit 0 på riktig filsystem. (Märkt manual-reference — agent-kredit kräver den interaktiva agent-lanen nedan.) |
| **B. W2 DDG/Bing research** | `node src/cli/majin.js research "<fråga>" --json` — web.search/web.fetch lanes: ddg + bing **slår mot ditt nät** (inte sandlådans block) | `ok:true` med riktiga sources i laneB-research-ddgbing.json |
| **C. W12-scaffold** | Checklistan (`w12-interactive-checklist.md`) genereras förifylld med datum/värdnamn — **interaktiv observation återstår BY DESIGN** | Checklist + skärmdump `w12-pink-visual.png` (se steg 3) |

## 3. W12-interaktiv acceptance (≈5 min, mänsklig observation)

Pink cursor har inget påstående om att vara automatiserbart — acceptanskriteriet är
att *du ser den*. Engine är redan bevisad offline (7/7) + Windows-CI dry-plan.
Det interaktiva beviset = dina rutor i checklistan + skärmdumpen.

1. Starta en agentsession med computer-\*-tools:
   ```powershell
   $env:OPENCODE_KEY = 'oc_sk_...'   # aldrig i filer, aldrig i chat
   node src/cli/majin.js
   ```
2. Be agenten: *"använd cursor.overlay och flytta den rosa markören till 640,400 med label 'W12-TEST'"*.
3. Kolla rutor i checklistan enbart för sådant du såg med egna ögon.
4. `Win+Shift+S` → spara som `w12-pink-visual.png` bredvid checklistan.

### Fabrication-regel (skriv den i ryggmärgen)
En bockad ruta utan observerad verklighet = CAP stannar på 99 **by design**.
Poängen är att visa att systemet ARBETAR på hårdvara — inte att komma ifrån att
justera. Skärmdumpen är en del av beviset (metadatan visar datum).

## 4. Stäng CAP (commit + push)

```powershell
git add docs/evidence/live-run-## (ett datum) docs/evidence/desktop-bench-## .*
git commit -m "live-run acceptance on real hardware (W11-live + W12-interactive + W2-ddgbing): receipts committed"
git push origin fix/realworld-repairs
```

Skicka sedan mappen här i chatten (eller pusha) — jag verifierar receipts mot
sviten, markerar W11-live + W12-interactive, och STATUS går till **100/100**:
först när bevisfilerna finns committade, aldrig tidigare.

## 5. Valfria extra-spår
- **W8 live:** skapa en discord/slack/matrix-bot-token, sätt i miljö, kör inbound-lanen (den är byggd, offline-verifierad 7/7).
- **Live-agent-lane för W6/W4:** REPL + OPENCODE_KEY — samma princip som W12 men en längre konversation; alla step-loggar hamnar under `~/.majin/workspace/`.

*Paketets delar är riktiga receipts — inga 'kommer snart'-promenader. Skriptet
avfärdar sig självt högljutt om något lane inte kan produceras på din maskin.*
