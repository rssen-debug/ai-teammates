# Capability levels

`buddy level` reports a number from 1 to 100. This document explains exactly how it is
computed, and — more importantly — what it is prevented from doing.

A level that can be raised by running the test suite, by spending tokens, or by doing
a lot of easy work is not a measurement. It is a scoreboard you can play. Most of the
design here exists to close those routes.

## The formula

```
score = Σ (weightᵢ × valueᵢ)  over MEASURED axes only
        ─────────────────────
        Σ  weightᵢ           over MEASURED axes only

raw   = 1 + 99 · score^1.35                        concave: early progress is earned,
                                                   top levels are hard
cap   = 1 + 99 · min(1, measured_events / 250)     evidence volume
level = clamp(floor(min(raw, cap)), 1, 100)
```

An **unmeasured** axis is excluded from both numerator and denominator, and its weight
is redistributed across the axes that did produce evidence. The report says so
explicitly — "(0.30 of weight redistributed)" — rather than treating a missing
measurement as a zero or as a pass.

The cap is the part that matters. **Three successful runs cannot produce level 80 no
matter how good they were.** `measured_events` is:

```
runs_decided + tasks_total + tool_calls + memory_searches
             + effects_recorded + benchmark_tasks + suite_runs
```

250 of them are needed to unlock level 100. Level reflects quality *and* quantity of
verified evidence, and cannot be one without the other.

## The six axes

| axis | name | weight | measured from |
|---|---|---|---|
| **A** | verified task success | 0.30 | verified ÷ decided runs. A run whose effects were never read back is `unverified`, not `complete`. |
| **B** | recovery success | 0.15 | recovered ÷ (recovered + abandoned) tasks |
| **C** | tool coverage | 0.15 | tools actually used ÷ `tools_available` on this host |
| **D** | memory retrieval quality | 0.15 | `0.6 · hit_rate + 0.4 · use_rate` |
| **E** | benchmark performance | 0.15 | passed ÷ run over the 14 benchmark tasks |
| **F** | regression resistance | 0.10 | the self-test / prove report |

Axis C's denominator is `tools_available` — **39 of 77** on a Linux host with no
display, key or Windows desktop — not 77. Measuring coverage against tools this machine
cannot run would make the number meaningless in both directions.

Axis F is deliberately binary at the top: **any** failing test gives `0.0`. All pass
gives `1.0`. Nothing passed and nothing failed — everything blocked — gives `0.5`,
because an untestable host is not a healthy one, but it is not a regression either.

### Tiers

| range | tier |
|---|---|
| 75–100 | elite |
| 50–74 | strong |
| 25–49 | capable |
| 10–24 | growing |
| 0–9 | seedling |

The displayed level is the latest measurement; `level_history` keeps every previous one,
so a drop is visible rather than smoothed away.

## What the level cannot do

These are properties, not aspirations. Each one is pinned by a test.

**Running the tests cannot raise it.** Axis D is computed from `memory_searches` and
`memory_hits`, which only `touch=True` increments — and only the `memory_search` *tool*
does that. `context_for()`, the system-prompt build, the self-test, the acceptance
suite, the benchmarks and `buddy memory search` all pass `touch=False`. Two real
inflation bugs were found and fixed here: `Memory.search` incremented counters
unconditionally, and `memory_hits` counted *rows returned* rather than searches that
hit.

**Spending tokens cannot raise it.** No axis reads token volume. Benchmark **B11**
exists specifically to prove the level cannot be gamed with tokens, wall-clock time or
sheer call volume.

**Claiming success cannot raise it.** Axis A counts *verified* runs. A run that finished
without its effects being read back lands as `unverified`. Benchmark **B09** proves a
completion claim with no evidence is rejected.

**A cancellation is not a failure.** A user-requested cancellation was once recorded as
a task FAILURE, which punished the agent for obeying. `cancelled` is not in `TRANSIENT`
and does not count against axis A.

**A host limitation is not a pass.** Axis E excludes skipped benchmarks from *both*
numerator and denominator. This matters concretely: `MajinBridge.__init__` defaults to
`autostart=True`, so any caller constructing it outside a `try` turned a missing
`npm install` into a FAIL and dropped axis E from 1.000 to 0.929 for a host
precondition. Constructing with `autostart=False` and starting inside the guard makes
B13 report `skip`, and the axis stays honest. `TestSkipIsNeverAFailure` pins it.

**BLOCKED is never upgraded to PASS.** Nowhere. Not in the level, not in the acceptance
suite, not in CI. CI exits 1 only when `FAIL > 0`; a blocked scenario neither fails the
build nor counts as a pass.

## Reading the output

```
buddy level
```

prints each axis with its value, weight and the raw counts behind it
(`14/14`, `0/39`), the total evidence against the 250 cap, the redistributed weight of
any unmeasured axis, and the formula version. Counts are always shown beside the value,
because a bare `0.00` does not distinguish "measured and bad" from "nothing to measure"
— and that distinction is the whole point.

A fresh installation on this host, with nothing but the benchmarks run, measures:

```
D  unmeasured
E  1.00 ×0.15   14/14
C  0.00 ×0.15    0/39
evidence 14/250
LEVEL 6/100  seedling
```

That is the honest answer for a machine that has done nothing yet, and it is the number
the product reports about itself.
