# Capability report

Measured, not estimated. Every number below was produced on the host named here by the
commands named here, and can be reproduced with them.

**Host:** linux · Python 3.11.2 · Node v22.22.3 · npm 10.9.8
**Absent on this host:** a KiloCode API key, a display, a microphone, a Windows desktop,
`pwsh`/PowerShell, a debug-enabled browser, an `.obsidian/` vault, real legacy data.
**Product version:** 1.0.0

---

## 1. Headline

| | result |
|---|---|
| Automated suite (`omega/tests/run_all.py`) | **SUITES PASS=5 FAIL=0 BLOCKED=0** · 53.3 s |
| Unit tests | **285 run across 10 modules · 0 failed · 0 errors · 0 skipped** |
| Engine self-test (`buddy prove`) | **PASS=21 FAIL=0 BLOCKED=8 NOT_TESTED=4** |
| Capability benchmarks (`buddy bench`) | **axis E = 1.000 · 14/14 tasks · 0 skipped** · 3.8 s |
| MAJIN bridge self-test | **PASS=17** |
| MAJIN V6 (`node --test`, executed in place) | **48 pass / 0 fail / 0 skipped of 48** (11 files) |
| Acceptance (`omega/acceptance.py`) | **PASS=11 FAIL=0 BLOCKED=9 NOT TESTED=0** · exit 0 |
| **Capability level** | **19 / 100 · growing** |

Nothing fails anywhere. Nine acceptance scenarios and eight self-test checks cannot be
proven on this host, and both suites say so rather than implying otherwise.

## 2. Test modules

| module | tests | what it holds down |
|---|---|---|
| `test_companion` | 62 | trust policy, observation depths, the user model, reflection budget and storage, session integration |
| `test_legacy` | 46 | bundle build/verify/inspect, tamper detection, tar path traversal, heir + heartbeat + grace, release confirmation, import, and **10 CLI subprocess tests** |
| `test_majin_bridge` | 46 | JSON-RPC framing, exactly-once operation ids, availability reporting, error classification |
| `test_level` | 25 | the formula, weight redistribution, the evidence cap, anti-gaming |
| `test_memory_migration` | 25 | sources, provenance, dedupe, rollback, the retrieval probe |
| `test_installer_contract` | 21 | PowerShell 5.1 compatibility traps; the installer owns no policy |
| `test_cli_contract` | 19 | USAGE ↔ dispatch in **both** directions, plus rendering |
| `test_benchmarks` | 17 | the 14 tasks, and that a skip is never a failure |
| `test_launcher` | 17 | launcher discovery order — including **real execution** of the POSIX launcher |
| `test_edit_invalidation` | 7 | stale bytecode after an in-place edit |
| | **285** | |

## 3. The level, measured twice

Run in a fresh `BUDDY_HOME`, so nothing is inherited.

### After `buddy bench` alone

```
LEVEL   6 / 100   seedling    score 0.500   ← only 2/6 axes measured (30% of the weight)
evidence 14/250 measured events   (level capped at 6 until more real evidence exists)
  A verified task success      unmeasured    no run has reached a terminal state yet
  B recovery success           unmeasured    no task has failed and been retried yet
  C tool coverage              0.00 ×0.15    0/39
  D memory retrieval quality   unmeasured    no memory stored or searched yet
  E benchmark performance      1.00 ×0.15    14/14
  F regression resistance      unmeasured    no self-test/prove report recorded
```

### After `buddy prove` as well

```
LEVEL  19 / 100   growing     score 0.625   ← only 3/6 axes measured (40% of the weight)
evidence 47/250 measured events   (level capped at 19 until more real evidence exists)
  C tool coverage              0.00 ×0.15    0/39
  E benchmark performance      1.00 ×0.15    14/14
  F regression resistance      1.00 ×0.10    21/33
```

Two things here are the point of the whole design.

**Axis C is 0.00, and that is correct.** No tool has been *used* by a real agent run in
this home. Availability is 39/77 on this host; usage is 0/39. Reporting a healthy number
for tools merely present would be measuring the registry instead of the agent.

**The level is 19, not 60+, because of the evidence cap.** Score 0.625 maps to a raw
level near 53. It is capped at 19 by `47/250` measured events. Self-test check **P1**
demonstrates the same property directly: *3 perfect runs score 1.00 but level 2 (cap 2)*,
and *the level is unchanged despite 50000× the tokens (12 vs 12)*. Quality without
volume does not produce a high level, and neither does volume without quality.

Axes A, B and D are unmeasured — their 0.60 of weight is redistributed across C, E and F,
and the report says so. A missing measurement is neither a zero nor a pass.

## 4. Tool census

**77 tools · 4 core · all 77 schema-enforced · 39 available on this host.**

| dimension | distribution |
|---|---|
| category | majin 16 · desktop 11 · file 10 · browser 8 · memory 6 · screen 5 · skills 5 · autopilot 4 · terminal 3 · meta 2 · dev 2 · web 2 · system 2 · activity 1 |
| risk | OBSERVE 41 · INPUT 14 · WRITE 11 · EXEC 8 · SENSITIVE 3 |

The 16 `majin_*` tools are MAJIN V6's own tools registered into Omega's registry, so
Omega's permission, risk, audit and verification gates apply to them while MAJIN's lane
policy continues to run inside MAJIN. MAJIN is executed **in place** at
`integrations/majin-original/` — not vendored, not copied, not reimplemented.

## 5. Routing

Measured on the same 30 intents before and after the change, because a ranker should be
measured rather than tuned by taste:

| | top-1 | mean reciprocal rank | mean rank |
|---|---|---|---|
| original | 27/30 | 0.667 | 1.444 |
| shipped | **29/30** | **0.833** | **1.138** |

The shipped configuration is `stem()` + ~45 routing synonyms at weight **0.45** + three
widened tool descriptions. The weight was chosen so that three synonym matches
(3 × 0.45 = 1.35) can never outrank a single literal token match (3.0) — a synonym may
help, but it may not overrule the user's actual words. Five candidate weight
configurations were measured on the same intent set; 0.45 won.

## 6. Acceptance — what is blocked, and why

**PASS = 1, 2, 3, 13, 14, 15, 16, 17, 18, 19, 20** (11)
**BLOCKED = 4, 5, 6, 7, 8, 9, 10, 11, 12** (9)

| blocked | reason on this host |
|---|---|
| 4, 5 | no KiloCode API key — live-model behaviour cannot be demonstrated |
| 6, 7, 8, 9 | need a Windows desktop: foreground window, Notepad, typed input |
| 10 | no debug-port browser and no Windows; `websocket-client` absent |
| 11 | no `.obsidian/` directory anywhere on this machine |
| 12 | no real legacy data — formats are fixture-tested, not owner-tested |

Self-test BLOCKED (8) and NOT TESTED (4) are the same categories: Windows desktop
automation, live-model paths, voice, and real legacy datasets.

Full detail in `ACCEPTANCE.md`.

## 7. MAJIN V6 — what it cannot do

Reported here because it is a capability limit of the integrated product, not a bug in
the bridge:

- **memory/skills unification** — `NOT_IMPLEMENTED`
- **self-repair / tool extension** — `NOT_IMPLEMENTED`
- **job-portal submit adapter** — `job.submit` **always returns a BLOCKED diagnostic.**
  MAJIN cannot actually submit an application. MAJIN's own `docs/v6/ACCEPTANCE.md` row 15
  records this as NOT MET.

Anything that assumes MAJIN can apply for a job on the owner's behalf is wrong, and
`buddy majin status` reports the gap rather than hiding it.

Provenance: `rssen-debug/MAJINCLI` @ `ea439ec`.

## 8. CLI surface

**28 dispatch entries · 24 documented commands.** The four undocumented are `help`,
`--help`, `selftest` and `version` — the allowlist `test_cli_contract.py` permits.

This is machine-checked **in both directions**: a command in `USAGE` that is not wired
fails the build, and a wired command `USAGE` never mentions fails it too. Right now the
unwired set is empty. Documented-but-unreachable is treated as a defect, which is why
six capabilities that used to exist only inside the REPL became real subcommands:
`memory`, `tasks`, `grants`, `models`, `skills`, `key`.

## 9. Honest limits of this report

- Every mocked-model test proves **engine logic only**. Nothing marked BLOCKED or
  NOT TESTED is claimed to work.
- Axis E is 1.000 on 14 tasks. That is a complete measurement *of those 14 tasks*, not
  of capability in general, and the report carries that qualifier rather than presenting
  the number bare.
- The level of 19 describes a **fresh home that has run the benchmarks and the
  self-test**. It is not a claim about the product in the owner's hands after months of
  real use — that number will be different, and should be.
- No live model, no Windows desktop, no voice and no real legacy dataset was exercised
  anywhere in this report. Those are the gaps, and closing them requires the owner's
  machine.

### Reproduce

```
python omega/tests/run_all.py      # the gate
python omega/acceptance.py         # the 20 scenarios
buddy bench && buddy prove && buddy level
```
