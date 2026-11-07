# MAJIN V2 GODMODE — slutstatus (2026-10-22)

## Vad som levererats

| Lane | PR | Merge | Bevis |
|---|---|---|---|
| GUI-QA hardening | #370 | d282254e | v2/main |
| **GUI-QA Edge-REUSE** (msedge channel, noll browser-nedladdning) | #380 | 2d1d10e8 | headed run #39835850635: **17/17 GREEN, channel msedge** |
| **ExecutionPolicy-bypass** (job-lokal; maskinpolicy orörd) | #383 | — | root-cause i jobblogg |
| Per-steg-shell strippad | #384 | — | run #39835219631: **17/17 GREEN headless** |
| Claims-journal | #387 | — | ACCEPTANCE_MATRIX.md |
| Svit | — | — | 1195 test, 1176 pass, 0 fail, 19 pending — oförändrad |

Tagg: **v2.0.0-godmode** på 91be19d. Släppt via RELEASE-lane före runner-arbetet.

## Root cause (journalerad, bevisad i logg)

Tre runner-körningar stod ~20–55 min utan ett enda slutfört steg.
Jobbloggen visade: `running scripts is disabled on this system`
(PSSecurityException) — maskinens PowerShell-ExecutionPolicy (Restricted)
blockerade runnerns .ps1-steg innan första npm-raden.

**Fix:** job-default shell `powershell -NoProfile -ExecutionPolicy Bypass -File "{0}"`
+ alla per-steg-shells borttagna. Maskinens policy rördes ALDRIG.
npm ci läser utbildar sig 13,7s–16,6s på operationen.

## REUSE-redovisning (hjulet byggdes inte om)

- **Microsoft Edge** — installerad på operationeldatorn, driven via Playwright
  `channel:'msedge'`. 120 MB Chromium-nedladdning BORTTAGEN från lanen.
  Ärlig chromium-fallback (bar Linux-sandbox, loggas i results-JSON).
- **actions/setup-node**, **actions/cache**, **actions/upload-artifact** —
  befintliga GitHub-actions, inga egna.
- PowerShell bypass-format är GitHubs dokumenterade shell-syntax, inte
  eget hack.

## Vad LANET bevisat om Studio (live-test, ej mock)

Offline-by-construction (noll externa asset-req), consent-gate svarar
(never crash), grant via UI speglas i audit-chain, målkörning via UI
→ COMPLETED, BUNDLE_EXPORTED → BUNDLE_OK, doctor-verdict renderas,
screenshot + results-json som artifact.
En RIKTIG bugg hittades och fixades (#366): page-handler-syntaxbrott dödade
alla UI-handlers — bevis för lanets värde.

## Framåt (icke-blockerande)

- workflow_dispatch med headless=false kör visuell demo på begäran
- 19 pending-tester i viten är *pending by design* (aldrig skrivna)
