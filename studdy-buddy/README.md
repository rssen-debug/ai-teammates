# Studdy Buddy CLI

Studdy Buddy är nu en **CLI först**. Ingen Electron-installator, ingen exe som produkt.
Samma studie-, minnes-, webbläsar- och datorstyrningslogik körs i Node.js och exponeras
som ett snyggt, scriptbart terminalgränssnitt.

## Installera

Kräver **Node >= 22.13** (för `node:sqlite`).

```bash
npm install -g ./studdy-buddy-0.2.0.tgz
studdy
```

Eller från repo:

```bash
npm ci
npm run studdy          # interaktiv chatt
npm run doctor          # hälsokontroll
npm run build           # bygger dist/cli/studdy.mjs
npm run package:cli     # skapar dist/studdy-buddy-*.tgz
npm run test:e2e        # byggd CLI i riktiga processer + lokal HTTP/WebSocket
```

## Kom igång

```bash
studdy setup
# Lägg nyckeln via stdin så den inte hamnar i shell-historiken:
echo "$KILO_KEY" | studdy provider set kilo --key-stdin
studdy provider test
studdy ask "förklara subnetting som om jag vore nybörjare"
```

Presets: `kilo`, `deepseek`, `openrouter`, `opencode`, samt `custom` för valfri
OpenAI-kompatibel endpoint (`--base-url`, `--model`, `--vision-model`). Nycklar sparas i ett lokalt
AES-256-GCM-valv (`secrets.vault`), aldrig i klartext i databasen och aldrig som argument.

## Kommandon

| Kommando | Vad det gör |
| --- | --- |
| `studdy` | Interaktiv chatt + live-status, skriver bara vid faktisk statusväxling |
| `studdy ask "…"` | Engångsfråga till din AI |
| `studdy repl` | Scriptbar interaktiv chatt från stdin, avslutar vid EOF |
| `studdy status` | Kompakt dashboard |
| `studdy doctor` | Ärlig lokal hälsokontroll; BLOCKED ≠ FAIL |
| `studdy open "Google Chrome"` | Generisk appstart via native helper, verifierad |
| `studdy apps` / `windows` | Lista appar/fönster |
| `studdy snapshot <id>` | Läs UI-träd med `ref:`er |
| `studdy see <id> "fråga"` | Skärmbild + native UI-träd + uttryckligen konfigurerad visionmodell |
| `studdy screenshot <id> <fil>` | Spara skärmbild |
| `studdy click <ref>` / `type <ref> "text"` | Styra observerade UI-element |
| `studdy press ctrl+s [id]` / `focus <id>` | Tangenter/fokus |
| `studdy watch` | Live-dashboard som uppdateras på plats |
| `studdy bridge` | Loopback-WebSocket för webbläsartillägget + token |
| `studdy sites allow example.com` | Explicit site-allowlist |
| `studdy gmail connect <client-id>` | OAuth/PKCE, read-only |
| `studdy github configure owner/repo --token-stdin --enable` | Debugjournal till GitHub |
| `studdy memory` | Synka Obsidian-minne |
| `studdy progress` / `readiness` | Lärande, nivå och readiness |
| `studdy voice "text"` | Lokal TTS: SAPI på Windows, `say` på macOS, `espeak-ng`/`espeak` på Linux |

Alla kommandon stödjer `--json` där det är meningsfullt och `--no-color`.

## Full åtkomst — vad det betyder

`studdy setup` beviljar en gång appens egna scopes: observation, skärmbild,
webbläsarläsning, datorhandlingar och provider-delning. Senare återkallelser respekteras.
Det betyder **inte** att vi kringgår Windows UAC, konton, lösenord eller privata fönster.
Privata fönster (bank, login, Gmail-chatt m.fl.) blockeras från observation.

Datorstyrningen använder den lilla native hjälparen `agent-desktop` (Apache-2.0)
via npm-paketet, på Windows, Linux och macOS. Den är inte Electron-appen.
Windows använder UI Automation, Linux AT-SPI/X11 och macOS accessibility-API:er.
OS-behörighet och en tillgänglig desktop-session krävs. En headless Linux-sandbox
utan D-Bus/AT-SPI ger BLOCKED, inte en låtsad grön status. `watch --once` kör en
faktisk observationsrunda och ger exitkod 1 när ingen live-observation lyckas.

## Webbläsartillägg

`apps/browser-extension` är oförändrat och kopplar till `studdy bridge` på
`ws://127.0.0.1:8765` med token. Bryggan är loopback-only, token-autentiserad,
2 MB-cap och läser bara sidor du uttryckligen tillåtit.

## Arkiv

Den gamla Electron-appen, dess UI-paket och installer-scripts ligger i
`archive/electron-desktop` **endast som referens**. De installeras inte, byggs inte,
packas inte och publiceras inte. CI bygger och bevisar CLI:t.

## Testning

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

`cli-linux-e2e.test.ts` kör den byggda CLI:n i riktiga processer mot lokal HTTP,
loopback-WebSocket och den installerade native-binären. Linux-headless-blockers
 kontrolleras uttryckligen; extern Kilo/Gmail-trafik ersätts inte med påstådd live-verifiering.

Windows CI kör dessutom ett riktigt native-bevis: `doctor` → `open "Notepad"` →
`windows` → `snapshot` och failar om något steg inte faktiskt lyckas.
