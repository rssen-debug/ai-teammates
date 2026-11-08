# Acceptance

`omega/acceptance.py` runs the **20 mandated end-to-end scenarios** and writes evidence
to disk. It is not a unit-test suite: each scenario drives the real product through the
real CLI or the real tool layer and then checks the world, not the return value.

```
python omega/acceptance.py            # all 20
python omega/acceptance.py --only 13  # one scenario
buddy accept                          # same thing, in a child process
```

Evidence lands in `<workspace>/acceptance/<timestamp>/`.

## The four states, and what they mean

| state | meaning |
|---|---|
| **PASS** | the property was demonstrated on this machine, and evidence was written |
| **FAIL** | the property was testable here and did not hold |
| **BLOCKED** | this machine cannot prove it — a missing key, OS, display or dataset |
| **NOT TESTED** | the scenario did not run |

**BLOCKED is never upgraded to PASS.** Not in this suite, not in the level, not in CI,
not in prose. It is a statement about the host, and the suite says so out loud:

```
NOT COMPLETE: blocked or untested scenarios remain.
This is a statement about this host, and it is not upgraded to a pass anywhere.
```

The exit code is **0 when `FAIL == 0`**, even with scenarios blocked — a host limitation
is not a product defect. CI parses the `SUMMARY` line and fails the build only on
`FAIL > 0`, so blocked scenarios neither break the build nor count as passes.

## The 20 scenarios

| # | Scenario | Requires | Result here |
|---|---|---|---|
| 1 | Fresh installation | installer present | **PASS** |
| 2 | Upgrade from an existing Buddy | an existing database | **PASS** |
| 3 | Python detection | a supported CPython | **PASS** |
| 4 | KiloCode connectivity | an API key | BLOCKED |
| 5 | Real conversational response | an API key | BLOCKED |
| 6 | Read the active application window | Windows desktop | BLOCKED |
| 7 | Open Notepad | Windows desktop | BLOCKED |
| 8 | Write text in Notepad | Windows desktop | BLOCKED |
| 9 | Verify Notepad contents | Windows desktop + scenario 8 | BLOCKED |
| 10 | Interact with Chrome/Edge | a debug browser or Windows | BLOCKED |
| 11 | Read migrated Obsidian memory | a real vault on this machine | BLOCKED |
| 12 | Retrieve legacy project knowledge | real legacy data on this machine | BLOCKED |
| 13 | Invoke a MAJIN V6 tool from Omega | Node 22+, MAJIN deps | **PASS** |
| 14 | Execute a persistent background task | — | **PASS** |
| 15 | Recover from a worker crash | — | **PASS** |
| 16 | Restart without losing memory | — | **PASS** |
| 17 | Enforce permission boundaries | — | **PASS** |
| 18 | Stop an active task | — | **PASS** |
| 19 | Run a coding workflow | a real test runner | **PASS** |
| 20 | Verify a complete multi-step task | — | **PASS** |

## Current result

Measured on **linux, Python 3.11.2, Node v22.22.3**, with no API key, no display, no
microphone and no Windows desktop:

```
SUMMARY PASS=11  FAIL=0  BLOCKED=9  NOT TESTED=0
```

**Nothing fails.** Nine scenarios cannot be proven on this host, and the suite reports
that rather than implying otherwise.

### Why each one is blocked

- **4, 5** — no KiloCode API key. Live-model behaviour cannot be demonstrated without a
  model. Note that `buddy models show` returns rc=1 without a key, by design.
- **6, 7, 8, 9** — need a Windows desktop: a real foreground window, Notepad, and typed
  input. This host is Linux with no display.
- **10** — needs a browser started with a debug port, or Windows. Neither exists here,
  and `websocket-client` is not installed.
- **11** — no `.obsidian/` directory anywhere on this machine.
- **12** — no real legacy data. The migration formats are implemented and unit-tested
  against fixtures, but fixtures are not the owner's history. See `MIGRATION.md`.

These are the honest gaps. Running the suite on the owner's Windows machine with a key
set is what converts them, and nothing else will.

## What PASS actually checked

A few worth naming, because the difference between "ran" and "demonstrated" is the
whole point of the suite:

- **15 — worker crash recovery.** A worker process is killed mid-task; the partial file
  is read *between* the crash and the resume, so recovery is proven against real
  on-disk state rather than against an in-memory claim.
- **18 — stop an active task.** A separate worker was genuinely mid-task (the file had
  grown to 142 B); this process wrote the stop marker and the task ended `cancelled`
  with 790 B written instead of completing all 400 steps. Checkpoint and memory were
  kept. A cancellation is **not** recorded as a failure.
- **19 — coding workflow.** The repo was analysed, a bug patched, and the *real* test
  runner went from rc=1 to rc=0. The live-model variant is separately marked BLOCKED.
- **20 — verified multi-step.** A three-step task reached `done` and the file on disk is
  exactly `alpha\nbeta\n`. A run whose effects were never read back is flagged
  `unverified=True`.

## Process isolation is not an implementation detail

`cmd_accept` runs this suite in a **child process**. `acceptance.py` points `BUDDY_HOME`
at a scratch directory at import time, and by then a live process has already resolved
the owner's real home. Loading it in-process would quietly execute the acceptance suite
against real user data — which is the one failure mode worse than a wrong test result.

For the same reason, `buddy.HOME` and `DIRS` resolve at import (≈`buddy.py:80`), and
`unittest` imports every test module before running any. The test modules assert
`Path(buddy.HOME) != _REAL_HOME` and refuse to run rather than risk it.
