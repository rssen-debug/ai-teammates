# Build status — CLI pivot

**Produkten är nu CLI.** Electron-installatorn är arkiverad under `archive/electron-desktop`
och ingår inte i aktiva scripts, beroenden, CI eller release.

## Aktiva komponenter
- `packages/core`: Electron-fri runtime (services, native adapter, live-observer, bridge, Gmail, GitHub, minne, röst).
- `packages/cli`: interaktiv TUI + scriptbara kommandon, ANSI-dashboard, `--json`, `--no-color`.
- `apps/browser-extension`: oförändrad MV3-extension till `studdy bridge`.
- `agent-desktop@1.2.0`: native helper för Windows/Linux/macOS; OS-behörigheter krävs.

## Verifierat lokalt
- `npm run lint` ✅
- `npm run typecheck` ✅
- `npm test` ✅ 326 tester / 31 filer
- `npm run build` ✅ `dist/cli/studdy.mjs`
- `npm run package:cli` ✅ `dist/studdy-buddy-0.2.0.tgz`
- Installerad tarball i temporär prefix: `studdy --version`, `studdy status` ✅
- Byggd CLI i riktiga Linux-processer mot lokal HTTP/WebSocket/PTY ✅
- Riktig Linux native helper startar; headless desktop rapporteras BLOCKED ✅
- Live-observer: grön endast efter riktig tillgänglig snapshot, stale efter 35 s ✅

## Verifierat i GitHub Actions
- Windows native proof ✅: doctor → open "Notepad" → windows → snapshot (run 42313457560).

## Ej verifierat här
- Live Kilo: sandbox-egress tillåter inte Kilo API; ingen nyckel persistad eller live-testad.

## Unified agent — MAJIN V6 + Omega + Buddy i ett CLI

Tre tidigare separata loopar är nu en kärna med en kö och en ärlighetsregel.

| Lager | Ursprung | Vad som faktiskt återanvänds |
| --- | --- | --- |
| `packages/agent-core/src/kernel` | MAJIN V6 `src/v6` | durable queue, leases, dependency-gating, effect-ledger, supervisor med watchdog, heartbeat-hälsa, redigering, lane-policy, rapport |
| `packages/agent-core/src/kernel/verify.ts` | Omega `buddy.py` (test K) | påstående utan bevis blir aldrig `verified`; saknad fil motsäger påståendet; BLOCKED ≠ PASS |
| `packages/core/src/kernel-runtime.ts` | Buddy | riktiga verktyg (native helper, behörighetsgrind, minne) bakom kön |
| `packages/core/src/agent-kernel.ts` | ny limning | planera → kö → supervisor → verifiera, utan obegränsad modell-loop |
| `packages/core/src/omega-bridge.ts` | Omega | kör Omegas riktiga svit och importerar dess domar som bevis |

Nya kommandon:

```bash
studdy agent "mål"                 # autonomt: plan → kö → kör → verifiera
studdy agent "run time.now"        # direkt instruktion, ingen modell behövs
studdy kernel status               # status enbart från sparad state
studdy kernel enqueue --kind tool --tool windows.list
studdy kernel run --max-tasks 5    # worker; riktig kö, riktiga behörigheter
studdy kernel verify --statement "…" --kind file --path rapport.md
studdy omega selftest              # Omegas riktiga acceptanssvit
studdy tools                       # verktyg workern faktiskt kan köra
```

Kontrakt som testas (inte bara dokumenteras):
- en påhittad verktygssöm körs aldrig; planen säger vilka steg som förkastades
- ett steg vars påstående inte kan bevisas rapporteras som `VERIFICATION_*`, inte som klart
- en saknad behörighet ger `PERMISSION_DENIED` i uppgiftens historik
- en osäker irreversibel effekt körs aldrig om; den kräver ägarbeslut med bevis
- en worker som tystnar fälls av watchdogen i stället för att hänga för evigt
- BLOCKED och NOT TESTED i Omegas svit förblir det; de blir aldrig PASS

### Verifierat lokalt (denna runda)

- `npm run lint` ✅
- `npm run typecheck` ✅
- `npm test` ✅ **467 tester / 51 filer**
- `npm run build` ✅ `dist/cli/studdy.mjs`
- `npm run package:cli` ✅ `dist/studdy-buddy-0.2.0.tgz`
- Byggd CLI: `studdy agent "run time.now"` → PASS med operations-id ✅
- Byggd CLI: `studdy omega selftest` → PASS=11, FAIL=0, BLOCKED=8, NOT TESTED=4 ✅
- 7 riktiga processtester för kerneln: köa i en process, köra i en annan, läsa i en tredje ✅

### Ärliga blockerare (oförändrade)

- Native desktop (fönster, UI-träd, skriv/läs tillbaka, skärmbild) kräver en riktig
  session; i denna headless-sandbox blir det BLOCKED/`FAILED_FINAL` med riktig orsak.
- Live Kilo/Gmail/GitHub: sandboxens egress når inte dessa API:er.

## Pågående arbetsyta

Kärnan och CLI-integrationen är verifierade lokalt och ligger i denna branch för granskning.
Se `TEST_RESULTS.md` för exakt omfattning och blockerare.
