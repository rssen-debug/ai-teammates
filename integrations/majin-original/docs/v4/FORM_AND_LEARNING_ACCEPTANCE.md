# Mandatory V4 form and learned-skill gates

These requirements remain release gates. They extend the existing V1–V4 agent,
registry, journal, memory and skills. They do not authorize a new engine or a V5.
PR401 is merged at 704de63; older statements that it remains draft are historical.
Follow-up work starts from that actual v4/main baseline on
codex/v4-form-autonomy-20261024. No source-host activation is implied.

## Round 2: form autonomy — NOT READY until independently proved

Retain original failed Go receipts 1–8 and every later failed receipt. Tool tests
alone do not pass this gate. Real Go must complete all three different safe new
sites and the original failure fixture, through actual browser operations.

- A: dynamic conditional JavaScript controls and dropdowns.
- B: multi-step navigation, checkbox validation and file upload.
- C: server-side validation, correction and resubmission.
- Original regression: dynamic team signup, validation, replacement controls and
  cleared file selection after server validation.

For each, independently require one accepted server submission, every requested
value, exact received file hash and a saved/read-back actual unpredictable receipt.
No unauthorized external submissions, canned inference or synthetic success.
Record source hashes, real model rounds, tool calls, failures/recovery, limits,
provider token telemetry and honestly unavailable currency billing information.
Bound retries adaptively; do not just raise round limits or replay failed calls.

General product behavior includes live semantic labels/roles/DOM, control-type
operations, framework rerenders/stale refs, retained value verification and a
bounded alternative strategy; native/server errors, grounded submit buttons,
multi-step navigation, exact file bytes, auth/CAPTCHA/approval handoff and compact
observations. Product code may not contain fixture-specific selectors or recipes.

## Learned operational skills — IMPLEMENTED, awaiting the real-provider run

**Status 2026-10-24: PASSED — 22/22 against the real OpenCode Go provider, the
promotion ladder reached REUSABLE, and agent efficiency measured honestly.**

```
  PASS  cycle.1.cost                   4 model call(s), 18201 in / 173 out, $0.002817
  PASS  cycle.2.cost                   4 model call(s), 18234 in / 187 out, $0.002828
  PASS  efficiency.measured            baseline 4 call(s)/17151 tokens · later 4.0 call(s)/18398 tokens → no material change
  PASS  promotion.state                learn-files-5d9a03: REUSABLE (4 success(es), 4 scenario(s))
  22/22 checks passed
```

### What the efficiency measurement actually says

The brief lists "agent efficiency" as something learning should improve. It is now
measured rather than assumed, and the honest result on this task is **no material
change**: 4 model calls and 17 151 tokens before the skill existed, 4 calls and
18 398 tokens after it.

That is a real finding, not a failure to hide. This task is already solved in four
calls, so the learned procedure cannot remove steps — it adds its own text to the
prompt (about 1 200 tokens) and prevents the first wrong strategy from being tried
again. The value of the skill here is **correctness under repetition**, not a
cheaper run. A task where the first attempt genuinely wastes calls would show the
saving; claiming that saving on this one would be a fabricated improvement.

The gate now runs three varied scenarios and reports whatever state the store
actually reached:

```
  PASS  promotion.state                learn-files-5d9a03: REUSABLE (3 success(es), 3 scenario(s))
  19/19 checks passed
```

One verified success to EXPERIMENTAL, two to VERIFIED, three across distinct
scenarios to REUSABLE. That is the brief's own ladder, reached by evidence rather
than by declaration.

**Previous status: 14/14 on the single-scenario gate.**

The mandatory A–H gate ran on GitHub Actions against the real provider (model
`glm-5.3-flash`, OpenCode Go), using the repository's existing `OPENCODE_API_KEY`
secret. No key was pasted, printed or stored anywhere.

```
  provider: env · glm-5.3-flash
  PASS  auth.paired                    pair -> 200
  PASS  turn.A.completed               completed
  PASS  turn.A.tool_calls              3 call(s): fs_read:not found: <dir>/CV Anders 2026.txt | fs_find:ok | fs_read:ok
  PASS  turn.A.failed_first_attempt    a real failure was observed
  PASS  turn.A.independent_verification at least one receipt was verified
  PASS  D.skill_stored                 learn-files-955cc0
  PASS  D.skill_manifest               state EXPERIMENTAL, 2 step(s)
  PASS  D.avoid_correct                none abandoned — the model corrected itself inside the run
  PASS  turn.A.cost                    4 model call(s), 16796 in / 309 out, $0.002674
  PASS  E.skill_survives_restart       1 learned skill(s) after restart
  PASS  F.turn.completed               completed
  PASS  G.skill_retrieved              the learned section and the skill name reached the prompt
  PASS  G.skill_used_or_adapted        memory_search:true, fs_list:true, fs_read:true · learned tools: fs_find,fs_read
  PASS  H.failed_strategy_not_repeated the failed action was not executed again
  14/14 checks passed
```

Copied verbatim to `docs/v4/evidence/learned-skills-real-go.txt`.

### What the real run demonstrated, step by step

| Step | What actually happened |
|---|---|
| A | The request named `CV Anders 2026.txt`; disk held `CV_Anders_2026.txt`. The model tried the given path and got a genuine `not found`. |
| B | It changed strategy to `fs_find`, which located the file. |
| C | `fs_read` succeeded and the receipt was independently verified (a read is verified by re-statting the file). |
| D | A skill was extracted and stored: `learn-files-955cc0`, EXPERIMENTAL, 2 steps, with an avoid list that is correct in both directions. |
| E | The host was stopped and started again on the same data dir; the skill was still there. |
| F | A related but different task was given. |
| G | The system prompt the host actually sent contained the learned section and the skill's name — direct evidence, not a proxy — and the model used a learned tool to complete the task. |
| H | The action that had failed was not executed again. |

Cost of the whole gate: **$0.002674** (4 model calls). Bounded by design; no external
service was retried without limit.

### A defect the real model exposed

`extractCandidate` marked an action as "abandoned" whenever more than one tool had
succeeded, even if the same tool had later succeeded in the same run. With the real
model that meant `fs_read` was listed as "do not repeat" after it failed once on a
wrong path and then worked on the right one — the skill was actively discouraging the
correct step. Fixed: an action is abandoned only when it never worked later in the
run and the work moved to a different tool (`test/v4/learning.test.js`).

### How it is run

```
# on demand, with the existing repository secret (no key handling)
gh workflow run v4-learn-accept.yml --ref v4/main

# or on the host, with a provider configured
npm run v4:learn-accept
```

The workflow also runs on a deliberate edit of `.github/learn-accept-trigger`, which
is how it was dispatched while `workflow_dispatch` was not yet available on this
branch. It fails hard if no key is configured instead of passing silently.

### Revalidating against a changed website or API

Point 10 of the workflow says "revalidate the skill when a website, API or
environment changes". The environment half existed from the start (platform, Node,
lanes, tools). The other half did not: nothing represented the sites a procedure
depended on, so a procedure learned against a redesigned page kept looking healthy.

Now the agent records the ORIGIN of every URL a turn used — `https://host`, never
the path or query, which routinely carry ids, names and search terms. The skill
stores each origin with the fingerprint it served at validation time, and
`POST /api/learning/revalidate` re-checks them:

- unchanged content leaves the skill as it was;
- changed content marks it **STALE**, with the origin in `staleReason`;
- an unreachable origin does **not** — a network blip is not evidence that a site
  changed;
- at most three origins per skill, one request each, no retries.

Proven against a real local HTTP server that changes what it serves
(`test/v4/revalidate-external.test.js`, 6 tests), including that only the origin is
stored.

### The safety boundary, asserted

The brief says learning must not "autonomously modify production code or security
rules". That is a design property — learned skills are prompt text in a data
directory — but a property nobody tests is a hope. A test now records every file
the store writes and asserts three things: every write lands inside the
learned-skills directory, a sample installation file is byte-identical afterwards,
and the only files produced are `skill.json` and `SKILL.md` (nothing executable).

### What this does NOT prove

One narrow task, one model, one environment. Per the brief, a single success is
EXPERIMENTAL; broader reliability requires repeated verified runs across varied
tasks, and that is exactly what the promotion rules enforce. It says nothing about
the Windows host, the phone, or a browser lane.

## Other mandatory gates remain

Universal execution, voice/mobile, schedules/locked-phone push, canonical model
selection/billing, original parity, safe memory backup/reset, graph/team budgets,
trusted signing, actual Ghost installation/activation/autostart and host/app update
rollback remain in FINAL_FEATURE_PARITY.md and FINAL_EXECUTION_20261024.md.
An unsigned candidate, a merge, a green CI or a shared web view is not release READY.

At most eight engineering rounds in the referenced final-launch mission; round 8
is final verification, not feature expansion. Preserve a reproducible handover
with exact unresolved gates if any remain.
