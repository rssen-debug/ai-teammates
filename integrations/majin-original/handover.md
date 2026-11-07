
# MAJIN handover — övertagandestatus 2026-10-21 (99/100, CAP gjäller)

> **Gamla handover (v0.9.1-audit, PR #59, 2026-10-19) är historiskt — se git-historik `git log --follow handover.md`.**
> Denna fil är nu SANNINGEN för takeover: den berättar exakt vart arbetet står, vad som är bevisat, vad som kräver din maskin, och varför inget nyckel får fastna i repot.

## Repo + branch
- **Repo:** https://github.com/rssen-debug/MAJINCLI · **aktiv branch:** fix/realworld-repairs
- **Latest push:** `8d58c39` (commit: STATUS-städning + förenat live-run-paket)
- **`npm test`: 875 pass / 0 fail / 17 skip** (user-verifen mot aktuell svit)
- **Percent: 99/100** — CAP-lagen: 100 nås INTE förrän W11-live + W12-interaktiv acceptance är verifierad på riktig Windows-maskin (ärligt, inte genom simulation). Se `docs/MAJIN_100_STATUS.md` för per-våg-matrisen.

## Så landar du (15 min)
```powershell
git clone https://github.com/rssen-debug/MAJINCLI.git
cd MAJINCLI
git checkout fix/realworld-repairs
npm ci
npm test    # vänta ≈2 min: EXPECT 875 pass / 0 fail / 17 skip
```

## Vad som är färdigt (inget att bygga om)
Alla W-vågor står **VERIFIED-CORE** eller bättre. Nyckelvakter i sandlådan:
- **W1** Absorb (riktigt GitHub-scan, capability-maps under `~/.majin/workspace/absorb/`)
- **W2** Research-motor — VERIFIED-CORE + **LIVE-ACCEPTANCE (github-lane)**: `scripts/research-live-acceptance.mjs`, receipts `docs/evidence/research-live-2026-10-21/`
- **W3** Execution-backends (lokal verified + hörljud docker/ssh-gate)
- **W4** Standing agent teams (teams.js, GREEN of absorb openai/swarm MIT)
- **W5** Event flows (file watch, webhook, gh-poll, manual/schedule)
- **W6** Power Transfer — REAL swarm-install lyckad (`planHash 3abbfa82573f5964`, docs/evidence/w6-power-transfer-2026-10-21.md)
- **W7** Mission loop + checkpoint-recovery
- **W8** Channel expansion — offline VERIFIED-CORE (send+receive); live bot-tokens PENDING (external gate)
- **W9/W10** Memory sync + Learning loop (anti-placebo-verify; tools registrerade)
- **W11** Windows desktop vision — VERIFIED-CORE (`src/core/desktop-vision.js` + `desktop-eval.js`, 13/13 tester); **live-körning PENDING-maskin**
- **W12** Pink AI cursor — IMPLEMENTED-ENGINE + VERIFIED-OFFLINE + WIN-CI-AUTOMATED; **interaktiv acceptance PENDING-maskin** (dublett raden `MISSING` bortäg synad i STATUS)
- **W13** Never-stuck — deterministic 100% recovery-matrix + **LIVE mot opencode zen/go** (`scripts/live-provider-chaos.mjs`, 7/7 rader vid 2 körningar)
- **W14** Release & benchmark — rollback (`update-rollback.js`), reproducible (`reproducible.js`), competitive bench (`competitive-bench.js`, 3 native tasks)

## Vad som pratar direkt till dig (din uppgift)
1. **Live-run (endast du kan göra det):**
   ```powershell
   powershell -File scripts/windows/live-acceptance-run.ps1
   ```
   Läs först `docs/LIVE-RUN-GUIDE.md`. Tre lanes:
   - **A** W11-live desktop-eval (manual-reference rename + verifier mäter riktigt `%TEMP%` + desktop-bench på win32)
   - **B** W2 ddg/bing researcher (`majin research` mot ditt verkliga nät)
   - **C** W12 INTERAKTIV — checklista + skärmdump `w12-pink-visual.png` nästa dig
2. **Commit + push receipts**, ping chatten / överlämnaren: percent → 100.
3. **Viktiga valfria gates:** W8 bot-tokens (discord/slack/matrix), GLM-QA 25→33-axel (ägs av parallell agent — kolla deras gren `qa/release-eleven-after-exact-write-20261021`).

## Färdiga fungerande hemligheter (krävs EJ timestamps, verifierade 2026-10-21)
- **opencode zen/go (`oc_sk_…`)**: OpenAI-kompatibel completion-endpoint `https://opencode.ai/zen/go/v1/chat/completions`. Headern **`x-opencode-session` är OBLIGATORISK** — utan svarar endpointen `MissingSessionID`. 37 modeller (glm-5.3-flash, kimi-k2.6, qwen3.8-max, deepseek-v4-pro, claude-haiku-5-5…). Nyckel = användarens, lever i miljövariabel, **skrivs aldrig in i filer/artifacts** (suite-auditerad I5).
- **GitHub-token (ghp_…)**: för pushes via remote-ritualen nedan.

## Pinnar du kommer stöta på (detta löser de)
| Symptom | Lösning |
|---|---|
| `fatal: 'origin' does not appear to be a git repository` | Snapshot-tyst reset av `.git/config`: `git remote add origin <url-med-token>` (eller `git remote set-url`). **Gör alltid detta innan du troubleshootar credentials.** |
| `js-yaml / chokidar cannot find module` | `npm install` före testsviten (snapshot räcker inte filtroot-endrä). |
| `empty ident name` vid commit | `git config user.name/ email "rssen-debug" <...>` — snapshot nukar även identity. |
| Test failar med svenska/teckenregler (i18n.test.js) | Delivery-kod får inte ha svenska strängar — översätt före push |
| self-audit flaggar claim-ord i renderMarkdown | Håll claim-språk ute ur shipped source — audit-skyddet är aktivt |
| Din branch divergerar efter `--force-with-lease` | `git fetch origin && git merge` i de flesta fall; använd INTE `reset --hard` förrän du städat bort din lokala arbete (stash först) |

## Ritualer som håller projektet sannt
1. **Reuse-princip:** för allt nytt arbete körs absorb av riktiga GitHub-repos FÖRST (laude-institute/terminal-bench layout, microsoft/UFO disciplin, openai/swarm patterns, chaostoolkit metod) — **layout/kontrakt återanvänds, innehåll skrivs eget.** Canary-märkt innehåll kopieras aldrig.
2. **Ärlighets-CAP:** percent-rapportering hävdas aldrig över sann sanning — 100 kräver receipts.
3. **Verifier-first:** varje ny modul behöver dedikerad testsvit + full regression innan push.
4. **Evidens:** live-körningar skickar INTE förpliktelser in i repo — receipts sparas (`docs/evidence/…`) med datum, exakta usage-tokens (från riktiga provider-anrop) och verkliga URLs.

## Filer du behöver direkt
- `docs/MAJIN_100_STATUS.md` — huvudmatrisen (vågar per våg)
- `docs/MAJIN_100_BACKLOG.json` — byte-to-day runda-logg (38 rundor loggade)
- `docs/LIVE-RUN-GUIDE.md` — vägen 99 → 100 (du behöver BARA denna)
- `scripts/windows/live-acceptance-run.ps1` — den enda kommandoraden för din maskin
- `docs/evidence/` — alla receipts (w2-live-acceptance, w6-power-transfer, w11-desktop-vision, w13-recovery-matrix + live-provider-chaos, w14-release + competitive-bench + reproducible, 2026-10-21 serie)

## Överlämnungs-status
- [x] Latest push verified (local==remote, clean tree)
- [x] Regression green (875/0/17)
- [x] Live ops verified vs riktiga ytor (opencode zen/go ×2, GitHub API, api.github.com research)
- [x] Documentation current (STATUS, BACKLOG roundLog 1-39, LIVE-RUN-GUIDE)
- [x] Anti-fabrication guards aktiva (W14 repo-audit, i18n-suite, evidential audits testers)
- [ ] **Användarens maskin-körning (DIN uppgift)** — vänts för CAP-stängningen

Signed: agenten som körde rundorna 33–39 i sandlådan (arena-agent-mod, sandlåda).
