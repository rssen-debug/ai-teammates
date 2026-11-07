# Benchmarks

```bash
node scripts/bench.mjs                # table + verdict
node scripts/bench.mjs --turns=5      # percentiles over repeats
node scripts/bench.mjs --json         # machine-readable (CI-friendly, exit 1 on any failure)
node scripts/bench.mjs --scenario=re  # one scenario
MAJIN_BENCH_KEEP=1 node scripts/bench.mjs   # keep the temp home to inspect
```

## What it measures — and what it does not

The harness runs **real turns** through `Agent.turn()`: intent parse, job routing, the tool loop,
the guard, MOA references + aggregation, memory/usage bookkeeping, the whole chain. The model is
the built-in `demo` mock, and its answers are **scripted per scenario** — so a run measures
MAJIN's own plumbing, deterministically, without keys, tokens or network.

That makes it the right tool for:

* **regressions in the harness** — a refactor that adds a serial step, breaks the plan plumbing
  or accidentally double-runs MOA shows up here as seconds and as a failed `expect`
* **the approval path** — `guard-approval` asserts the tool never ran and the file survived, and
  the timing shows the timeout being honoured
* **self-config latency** — `self-config` must stay a single-digit millisecond no-model-call

It says nothing about model quality or provider latency. For actual model behavior, use the separate live evaluator below. Do not interpret the scripted mock benchmark as evidence that a configured model can reason or use tools correctly.

## Live configured-model evaluation

The mock benchmark above verifies MAJIN's plumbing only. To gather behavioral evidence from the model actually configured on this machine:

```bash
npm run eval:live -- --yes
```

This is deliberately opt-in: it runs two live scenarios, each allowing up to eight model steps, and can incur provider charges. It uses MAJIN's normal per-job routing, requires real keyed `tasks` and `final` routes, turns MOA and the classifier tiebreak off for this isolated check, allows only `fs.read`, `fs.write`, and `fs.list`, and confines writes to a temporary workspace that is deleted afterward. It does not change the user's config or workspace. It refuses configured routes matching OpenCode or Qwen and marks any unexpected mock-routed step as a failure. The JSON result reports the selected model routes, tool calls, usage, checks, and pass/fail; redirect stdout to keep the report, for example `npm run eval:live -- --yes > live-eval.json`.

The checks use random markers that the model cannot know without reading a file: (1) retrieve and report a marker, then (2) write a marker, read it back, and report only after verification. Passing is evidence of basic live tool-use and verification for that provider/model at that moment—not proof of general intelligence, Arena parity, or quality on arbitrary tasks. No live provider was exercised in CI; only the deterministic mock harness is suitable for routine CI runs.

## Scenarios

| scenario | what must be true |
|---|---|
| `fs.write` | the tool writes the file; content on disk matches, byte for byte |
| `fs.read+summarize` | read → evidence → answer that actually mentions what was read |
| `re.analyze` | a synthetic PE goes through the parser and produces a report + tool_result |
| `shell.run` | exec path runs (guard off), and the background variant is *not* chosen |
| `multi-step` | three tool steps chain in one turn without losing the plan |
| `self-config` | "run with 4 references" patches `moa.width` with **zero** tool calls |
| `guard-approval` | `guard.mode: strict` asks, the timeout denies, `victim.txt` still exists |

## Reference run

Node v22.22.3, linux/x64, container CPU, `--turns=3`, MOA `always` with width 2 (the defaults are
`always`/3):

```
scenario          pass   avg     p50     p95     tools  steps  events
fs.write          3/3    38ms    30ms    60ms    2      3      20
fs.read+summarize 3/3    50ms    50ms    50ms    2      3      24
re.analyze        3/3    47ms    42ms    59ms    2      3      22
shell.run         3/3    53ms    51ms    57ms    2      3      22
multi-step        3/3    128ms   127ms   130ms   4      5      34
self-config       3/3    12ms    12ms    13ms    0      1      7
guard-approval    3/3    4551ms  4535ms  4582ms  3      4      27

21/21 runs green · p50 50ms · p95 4535ms · 123 provider calls · 89003 tokens · $0
```

Read it as: **a turn of MAJIN's own machinery costs tens of milliseconds** — a tool round trip
with routing, events and MOA overhead lands at 30–130 ms. Everything above that in a real session
is the provider. `guard-approval` is not slow: 4.5 s is exactly 3 × the 1500 ms approval timeout
the harness configures (`tasks.approvalTimeoutMs`), which is the point — a timed-out approval
means *no*, and the refusal costs nothing but the wait you set.

The 89 k tokens are the mock's *estimate* of the prompt sizes (it counts what it was given); cost
is $0 because `demo` has no price entry, and MAJIN refuses to invent one — `pricing` in config is
where a real number comes from.

## Adding a scenario

Push an object into `SCENARIOS` in `scripts/bench.mjs`:

```js
{
  name: 'fs.delete-guarded',
  input: 'delete victim.txt permanently',
  job: 'tasks',
  guard: 'strict',                    // which guard mode this turn runs under
  seed: { 'victim.txt': 'do not delete me\n' },   // files placed in the workspace
  steps: [{ text: 'Deleting.', toolCalls: [{ name: 'fs.delete', args: { path: 'victim.txt', permanent: true } }] },
          { text: 'Refused.' }],      // scripted model turns, one per loop step
  expect: { tool: /^fs\.delete$/, fileAbsent: 'victim.txt', guardAsk: true, events: ['tool_result'] },
}
```

`steps` are scripted for every `main:<job>` key so the scenario passes whichever job the
classifier picks; MOA's reference and aggregator calls are scripted from the last step's text, so
`expect.answer` asserts on the answer the user would actually see. Available `expect` keys:
`tool`, `avoid`, `file` (`{path, contains}`), `fileAbsent`, `events`, `answer`, `config`
(`{path, value}`), `guardAsk`. The verdict is `pass` only if **every** check of **every** run
passes, and `--json` prints the same tree for a CI gate:

```bash
node scripts/bench.mjs --json | tee bench.json && python3 -c "import json;exit(0 if json.load(open('bench.json'))['ok'] else 1)"
```

## Del 3E — REAL parallel-vs-sequential (LIVE, 2026-10-19 12:1x UTC)

**Setup:** `scripts/live-bench.mjs` — N=4 independent briefs (no dependencies),
R=3 replicates interleaved S,P,S,P through `runSwarm`, provider
`opencode/longcat-2.5-preview-free` (free model, measured usage via zen gateway,
`x-opencode-session: majin`), same process, same machine, same minute.

| Mode | run1 | run2 | run3 | median | overlap-pairs (max 6) |
|---|---:|---:|---:|---:|---:|
| sequential (cap=1) | 74 325 ms | 47 499 ms | 36 998 ms | **47 499 ms** | 0 / 0 / 0 |
| parallel (cap=4) | 13 217 ms | 10 454 ms | 11 065 ms | **11 065 ms** | 6 / 6 / 6 |

**Speedup: 4.29× on the median.** Every call ok (24/24). Measured usage:
6 290 tokens total across all replicates (never estimated).

Test-level live corroboration (same key, `MAJIN_LIVE=1 node --test test/live-bench.test.js`):
N=3 — seq 24 522 ms (overlap 0) vs par 6 991 ms (overlap 3), tokens 660 = 660.

Reproduction command (requires opencode key in ~/.majin/config.json):
`node scripts/live-bench.mjs` and/or `MAJIN_LIVE=1 node --test test/live-bench.test.js`.
Without the key both degrade honestly: script exits at the first provider call,
and the live test skips with a typed reason (CI stays 370/0/7+1 mock always-on).

## Del 4D — contract domains (command / json / http) — live env (2026-10-19)

Mock: `test/domains.test.js` 5/5 (pass/fail/denied per domain + derivation + E2E repair).

| live check | evidence |
|---|---|
| real https fetch | `GET https://www.google.com/search?q=majin` → 200, needle "search" found (91 939 bytes) |
| real command exit | `node --version` → exited 0 (v20.20.2) |
| live mission (longcat-2.5-preview-free) | wrote `mission-live.json` `{answer:42, task:…}` — VERIFIED sha:c181499c; 72 511 tokens measured live (usage, not estimate) |

Reproduction: `MAJIN_LIVE=1 node --test test/domains-live.test.js` (opencode key).
Without the key the file skips with a typed reason; CI runs only the mock suite.

## Del 5A/5B/5E — browser domains live in exe-CI (2026-10-19, Windows runner Edge)

Evidence extracted from the CI gate step log (`build-exe.yml`, commit c066a34):

| row | server-side / engine proof |
|---|---|
| 5A forms & controls | posted form observed: `{"name":"Siri Testsson","mail":"siri@test.dev","stack":"node","level":"senior","consent":"on"}` + thanks-words on screen |
| 5B dynamic nav/tabs/iframes | new tab followed (`openedNewTab:true`), hash-rendered `#dyn` content proven, iframe host + frame URL verified the straight way |
| 5E multi-step webshop | cart POST `X900 qty 1` + order POST recorded server-side before final confirmation claim |

Step suite: 5/5 pass (browser.live 2 + jobs.live 1 + browser-domains 3).

Flake-class fixed this wave (engine, not test): Edge launch gets one bounded
retry with a fresh port — proven by runs 39265517682 (1 attempt → 2/3 red)
→ c066a34 (retry → 3/3 green). The retry IS the sabotage cycle: removing it
reopens the red state.

## Del 12A — independent real-model acceptance suite (2026-10-19, opencode live)

`test/acceptance-live.test.js` 3/3 (MAJIN_LIVE=1, gate-skipped in CI):

| test | verdict-by-code | usage (measured) |
|---|---|---|
| 12A.1 create json | file on disk, keys suite=12A status=green, VERIFIED marker | 43 379 tokens |
| 12A.2 append via fs.patch | original line preserved AND new line appended on disk | 281 891 tokens |
| 12A.3 lie-detector | missing file named "missing or empty"; exit 7 never a success | 0 (engine only) |

The suite never lets a model judge its own work.


## GODLIKE V4 §7 — rate-limit orchestrator (2026-10-19)

Deterministic simulator `test/ratelimit-sim.test.js` 8/8 (offline, tiny windows):
S1 naive 429-burst vs S2 zero-violation throughput (6 calls, wall 1046 ms,
queue-wait 2893 ms); S3 Retry-After floor; S4 queued-abort cleanliness;
S5 interactive-priority; S6 AIMD; S8 pass-through with no configured quota.
Not a live quota measurement — provider RPM/TPM values remain owner-configured.

<!-- SWARM-BASELINE:BEGIN (auto-generated by scripts/offline-swarm-bench.mjs — do not hand-edit) -->
## Swarm vs single-agent baseline — offline, deterministic (2026-10-22)

Same `runSwarm` executor, seeded artificial latency. Measures **executor
parallelism only** — model quality/latency live in `scripts/live-bench.mjs`.

| scenario | median wall | overlap pairs |
|---|---:|---:|
| single-agent baseline (cap=1), 8 tasks | 475 ms | 0/0/0 |
| MAJIN parallel (cap=8) | 71 ms | 28/28/28 |
| **speedup (median)** | **6.69×** | parity OK |
| dependency chain (3 deep, cap=3) | 193 ms (critical path 192 ms) | deps respected: YES |

Config: fan=8, reps=3, taskMs=60, jitter=15, seed=0x3e. Failures: 0.
<!-- SWARM-BASELINE:END -->
