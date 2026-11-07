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
- `npm test` ✅ 312 tester / 30 filer
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

## Pågående arbetsyta

Linux-fixarna är verifierade lokalt och förberedda för pull request. Se `TEST_RESULTS.md` för exakt omfattning och blockerare.
