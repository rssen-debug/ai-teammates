# W12 Windows-runner acceptance pack

The Definition-of-DONE for the pink-cursor/computer-use lane requires an
INTERACTIVE acceptance pass on a real Windows runner. This pack makes that
measurable instead of aspirational.

## Run it (on the Windows machine, real logged-in desktop)
```powershell
powershell -ExecutionPolicy Bypass -File qa\win-acceptance\run-all.ps1
```
Produces `qa/win-acceptance/out-win-acceptance.json` + `shots/*.png`.

## Validate the evidence (any machine, incl. this repo's tests)
```
node scripts/verify-win-acceptance.mjs qa/win-acceptance/out-win-acceptance.json --gate
```
Contract `win-acceptance/1`: every step PASS/FAIL/NOT TESTED; PASS requires an
artifact or measurable evidence; A1 (cursor) and A5 (computer.use smoke) are
DoD-required. A FAIL or NOT TESTED on required steps BLOCKS the gate honestly.

## Honest limitations
- A2/A3/A4 (model chip, single header, archive/delete flow) are codified in the
  steps table but probed in the non-interactive CI only as far as the desktop
  allows; the interactive run is the authoritative evidence.
- Non-interactive sessions (ssh/CI service) get an explicit `A0 NOT TESTED`
  instead of a guessed verdict — that is the point of the pack.
