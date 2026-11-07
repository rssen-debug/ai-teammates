# Test results — Linux agent/E2E pass

## Faktiskt kört i Linux-sandboxen

- `npm run lint` ✅
- `npm run typecheck` ✅
- `npm test` ✅ **319 tester / 31 filer**
- `npm run build` ✅
- `npm run package:cli` ✅
- Tarball installerad i temporär npm-prefix; `studdy --version` och `studdy status` ✅
- `tests/integration/cli-linux-e2e.test.ts`: **7 riktiga processtester** ✅
  - Byggd CLI, inte bara importerade funktioner.
  - `--version`, `-v`, `--help`, okänd flagga och ren stderr.
  - Setup → krypterad stdin-nyckel → provider-test → chatt → minne → historik mellan processer.
  - Lokal HTTP-server via riktig `fetch`: text, SSE-streaming, JSON, vision och tool-call-probe.
  - Scriptbar REPL som tar emot alla rader och avslutar vid EOF.
  - Riktig pseudoterminal (PTY): interaktiv setup och nyckel utan echo/läckage.
  - Riktig `agent-desktop-linux-x64` 1.2.0: version/status och ärliga headless-fel.
  - Riktig loopback-WebSocket: autentisering, tillåten kurspagina, avvisad främmande sida och status från annan process.
- `tests/integration/external-connectors.test.ts`: 2 protokolltester ✅
  - Gmail OAuth/PKCE med riktig lokal callback, syntetisk Google-transport, valv och revoke.
  - GitHub-diagnostik med syntetisk transport: ingen riktig repo-skrivning, PAT läcker inte till rapport/config.

## Fixar som hittades av faktisk körning

- `--version`/`-v` visade tidigare hela hjälpen.
- SQLite-varningen spamade stderr trots Node >= 22.13.
- Linux/macOS var hårt avstängda trots att native-hjälparen stöder dem.
- Native-binären löstes inte korrekt från installerad CLI på Linux.
- `type` skickade text i argv i stället för helperns `--stdin` (max 10 000 UTF-8-byte).
- Skärmbild kunde rapporteras lyckad utan verifierad fil.
- `see` föll tillbaka till textmodell som om den vore vision; nu krävs uttrycklig visionmodell.
- Obsidian-minnet fick dubbelt sökvägsnamn (`Obsidian-Vault/Obsidian-Vault`).
- Pipad interaktiv chatt kunde fastna; snabb EOF kunde tappas; observation kunde använda stängd databas.
- Interaktiv nyckel kunde echas av terminalen; rått PTY-läge används nu under inmatningen.
- Status visade initialt `Startar` i stället för att göra en faktisk observationsrunda.
- Bryggstatus kunde inte se en brygga i en annan CLI-process; autentiserad probe används nu.
- Gmail OAuth lämnade en timeout-timer levande; headless CLI skriver nu ut kopierbar auth-länk.

## Nytt: `studdy prove` — live-bevis på användarens egen dator

`studdy prove` kör hela kedjan och rapporterar `pass`/`fail`/`blocked`/`skipped` per steg:
native helper → behörighet → appstart → **fönster hittat i riktig fönsterlista** →
UI-träd läst → **slumpad text skriven och tillbakaläst** → skärmbild verifierad på disk.

- 7 enhetstester verifierar själva bevislogiken, inklusive att ett lyckat startanrop
  ensamt aldrig räknas som observerat fönster, och att skrivtest utan tillbakaläsning
  blir `fail`, inte `pass`.
- Kärs headless i sandboxen: `prove` ger exitkod 1 och `BLOCKED` på native helper. ✅
- Windows-CI kör nu `studdy prove --app "Notepad"` som ett hårt grindsteg.
- Guide: `docs/TESTA_LIVE.md`.

## CI-fix

Den nya E2E-suiten påstod tidigare att observation alltid måste vara blockerad.
Det stämmer i headless Linux men inte på en riktig Windows-desktop, vilket gav
rött i Windows-CI (run 42354947354). Påståendet är nu plattformsmedvetet:
headless Linux kräver BLOCKED, riktig desktop kräver konsekvent bevis
(elementantal > 0 och fönstertitel) om den rapporterar sig live.

## Ärliga blockerare — inte gröna

- **Linux GUI/AT-SPI:** sandboxen är Debian headless utan grafisk session/D-Bus/AT-SPI.
  Riktiga `windows`/`apps`/`watch`/`see` ger därför blockerade/felaktiga resultat, inte tomma listor som påstås vara bevis.
- **Lokal Linux-TTS:** stöd för `espeak-ng`/`espeak` finns, men ingen röstmotor eller ljudsession är installerad här.
- **Kilo/Gmail/GitHub live:** sandboxens egress tillåter inte dessa API:er. Lokal HTTP och syntetiska connector-transporter är protokollbevis, inte live-bevis mot externa konton.
- **Windows native:** tidigare verkligt CI-bevis (Notepad launch → window → snapshot) finns i run 42313457560. Denna Linux-runda kördes inte på Windows.

Ingen nyckel från användaren har sparats i repo eller testdata.
