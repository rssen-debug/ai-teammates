# Architecture

Studdy Buddy Omega is **one product with one command and two runtimes**. This
document describes what shipped, not what was intended.

```
buddy  ──►  omega/buddy.py            the product: CLI, agent engine, tool registry,
              │                       memory, permissions, verification, level
              ├── omega/companion.py  the always-on layer: trust, observation,
              │                       the model of you, budgeted 24/7 thinking
              ├── omega/legacy.py     encapsulation and hand-over after death
              ├── omega/majin_bridge.py ──► integrations/majin-original/  (Node, executed in place)
              ├── omega/memory_migration.py   legacy data import
              ├── omega/level.py      capability measurement
              ├── omega/benchmarks/   axis E, 14 measured tasks
              ├── omega/acceptance.py the 20 mandated end-to-end scenarios
              └── omega/install.ps1   Windows installer
```

## 1. One product, one command

Everything is reachable through `buddy`. There are **28 dispatch entries** covering
**24 documented commands**; the four extras are `help`, `--help`, `selftest` and
`version`. This is machine-checked in both directions by
`omega/tests/test_cli_contract.py`: a command in `USAGE` that is not wired fails the
build, and a wired command that `USAGE` never mentions fails it too. Documented but
unreachable is treated as a defect, because a capability the owner cannot invoke is
not a capability.

Capabilities that used to exist only inside the REPL were promoted to real
subcommands for exactly this reason: `memory`, `tasks`, `grants`, `models`, `skills`,
`key`.

## 2. Two runtimes, one authority

Python owns the product. Node owns MAJIN V6.

MAJIN is **executed in place** at `integrations/majin-original/` — never copied,
never vendored, never reimplemented. `omega/majin_bridge.py` spawns
`node bin/majin-v6.mjs mcp` and speaks newline-delimited JSON-RPC 2.0 to it, then
registers MAJIN's tools into Omega's own `Registry`.

That registration is the important part. Because MAJIN's tools become Omega tools,
Omega's permission gates, risk classification, audit log and read-back verification
apply to them, while MAJIN's internal lane policy continues to run inside MAJIN. One
authority over what may happen, two engines doing the work.

Discovery is lazy: `majin_search`, `majin_schema` and `majin_call` mean the catalog is
read from MAJIN at runtime rather than duplicated in Python where it would drift.

`MajinBridge.availability()` is deliberately never optimistic. Missing Node, missing
dependencies, or a missing V5 data directory produces **BLOCKED with the real
reason** rather than a silent no-op. MAJIN's own server refuses to start without an
existing V5 data dir (`V5_DATA_MISSING`), and Omega surfaces that instead of
inventing a profile — `init_profile()` is owner-explicit only.

Effectful MAJIN calls (`majin_tool_call`, `v6_queue_add`, `v6_task_cancel`,
`v6_work_start`, `v6_work_stop`) carry an `operation_id` derived from
`sha256(tool, args, scope)`, which makes them exactly-once across retries. That is
what benchmark B13 measures.

## 3. The tool layer

**77 tools**, all 77 schema-enforced, **4 core**. On a Linux host without a display,
key or Windows desktop, **39** report themselves available — and the rest report why
they are not, which is what keeps axis C honest.

| dimension | distribution |
|---|---|
| category | majin 16, desktop 11, file 10, browser 8, memory 6, screen 5, skills 5, autopilot 4, terminal 3, meta 2, dev 2, web 2, system 2, activity 1 |
| risk | OBSERVE 41, INPUT 14, WRITE 11, EXEC 8, SENSITIVE 3 |

Risk is not advisory. `Permissions` decides, the decision is written to the `audit`
table, and `is_protected_path` refuses any path under the owner's home except the
workspace, export and skills directories — plus `.ssh`, credential stores, `buddy.db`
and (on Windows) `SystemRoot` and `ProgramFiles`. It has not been weakened to make a
test pass, and it should not be.

`Executor.execute` treats **any** returned value as success, so `check_record()`
converts failed or uncertain records into a `ToolError`. A tool that returned an error
payload is not a tool that worked.

## 4. Memory

Hybrid retrieval over SQLite, with a hard separation between *recording* evidence and
*reading* it.

`Memory.search(touch=True)` bumps the row's `uses` and the `memory_searches` /
`memory_hits` counters that axis D and the level's evidence cap are computed from.
That is what the `memory_search` **tool** does, so a real agent run is measured.

Every internal and harness path passes `touch=False` — `context_for()`, system-prompt
build, the self-test, the acceptance suite, the benchmarks and `buddy memory search`.
It has to: if running the test suite incremented those counters, running the test
suite would raise the level, which is the one thing the level must not be able to do.

Two bugs found here are worth keeping visible, because both inflated a number the
product reports about itself:

- `Memory.search` incremented counters unconditionally, so harness reads counted as
  retrieval evidence.
- `memory_hits` counted **rows returned**, not searches that hit.

`Memory.save()` upserts on `(kind, lower(title))`. A minute-granular title collapsed a
whole minute of companion reflections into one row — observed live as 8 thoughts
producing 1 memory. Titles are now second-granular with a store cooldown.

`SELECT tags, COUNT(*) …` with no `GROUP BY` is valid SQL that returns **one** row
whose count spans every match. That bug fabricated "recurring topics" in the user
model. All aggregates are audited and tests assert exact counts.

## 5. The always-on layer

`omega/companion.py` is standalone; every collaborator is injected, so it is testable
without the product and cannot import it.

**Trust.** `TrustPolicy` has exactly two modes, `normal` and `full`. Full trust is
activated by typing `I take responsibility` — never accepted as an argv flag, because
a flag lands in shell history, the process list and any supervisor's logs, which turns
a deliberate decision into a string that can be replayed by whoever can read them.

Twelve actions are **third-party** (`send_message`, `send_email`, `reply_as_owner`,
`post_public`, `comment_public`, `submit_application`, `payment`, `transfer`,
`purchase`, `subscribe`, `chat_as_owner`, `contact_person`) and confirm in *every*
mode. Autonomy over your own machine does not extend to other people or their money,
and that is not a setting.

Destructive actions are redirected rather than refused where a redirect preserves the
intent: `delete_permanent`/`wipe`/`shred` → trash, `drop_database` → backup-then-drop.
`format` still confirms.

**Observation.** `ObservationPolicy` has four depths — `off`, `titles`, `capture`,
`continuous` — defaulting to `titles`. `may_capture` checks depth, then private mode,
then protected windows, then exclusions, then whether a backend exists at all. Capture
requires a visible recording indicator and will not run without one. Pixels are never
stored: the backend calls the real `screen_describe` tool through `exec_tool`, so it
inherits permission, risk and audit, and only the model's text description survives.

**The model of you.** `UserModel.build(days)` separates `observed` from `inferred` and
attaches evidence to every claim. Its verdicts are graded by evidence volume:
`no evidence yet`, `thin` (<25), `usable` (<250), `substantial`, or **`UNRELIABLE`**
when errors were encountered. A thin history is reported as thin rather than as a
personality.

**Thinking.** `CompanionLoop` ticks on idle, consults another model through the
**gateway** (deliberately not a browser — scraping claude.ai or chatgpt.com is out of
scope on principle), and is bounded by `ReflectionBudget`, a hard daily token ceiling
persisted in `stats` under `reflect_tokens_YYYYMMDD`. Enforced, not advisory.

Reflections are stored as `episodic` memories with `status="unverified"`, so a
thought the agent had about you never silently becomes a fact about you. `"nothing
new"` is not stored.

The loop catches per-tick exceptions, records them and continues; only cancellation
propagates. A 24/7 process that dies on one bad tick is not a 24/7 process.

## 6. Legacy — what survives you

`omega/legacy.py` encapsulates an installation into a transferable bundle and governs
hand-over. It has **no network path at all**.

The bundle is `memories.jsonl`, `profile.json`, `skills.jsonl`,
`level_history.jsonl`, `settings.json`, `README.txt` and a `manifest.json` carrying
per-file SHA-256, schema, identity and the heir record. Its identity is
`memorial_record`, and it carries a notice stating it is a record of a person, not
that person — any consumer must display it.

Credentials are excluded **by construction**: settings are exported from a 14-key
allowlist, never a denylist, because a denylist fails on the day someone adds a key.
`is_secret_key()` runs behind that as a second line. The vault is never opened.

**The bundle is plaintext, and that is the correct design.** Python's standard library
has no AES, and a home-grown cipher is worse than an honestly plaintext file because
it looks like protection. Windows DPAPI is wrong for a *different* reason: it binds
ciphertext to the account that created it, so a bundle sealed that way could never be
opened by the heir. It would be perfectly safe and permanently useless. So the bundle
records `sealed: false`, and the owner is told to seal it with `gpg --symmetric` or
`age -p` and escrow the passphrase with the heir or a lawyer. Protection here has to
survive the person it protects, and only a secret somebody else also holds can do that.

`release` is a third-party action — the recipient gets a model of someone not in the
room to object — so it requires the phrase `release to my heir` typed in, is not
covered by `buddy trust on`, verifies the bundle first, and transmits nothing.
`check` reports whether the grace period (default 90 days since the last heartbeat)
has elapsed; absence of a heartbeat concludes *nothing*, because missing evidence must
not become evidence of death.

Import runs the other way: `buddy legacy import` refuses a bundle that does not
verify, preserves **original** timestamps (a memory dated today would rewrite the
history it carries), tags rows `legacy` with provenance back to the bundle, and is
idempotent. Unpacking is guarded against `../` and absolute tar members, because a
bundle is imported by someone who trusts it.

## 7. Installer and launcher

`omega/install.ps1` owns **no policy**. The dependency list and the supported
interpreter range come from `buddy deps --json`, so the installer cannot disagree with
the product about what the product needs. It never hardcodes one Python version or a
machine-specific path.

`omega/launcher/` holds `buddy.cmd` (pure batch — no PowerShell at all, because
locked-down machines are exactly the machines that need a launcher) and `buddy`
(POSIX `sh`). Both discover an interpreter in the same order: `BUDDY_PYTHON`, then the
`python` field of `install-manifest.json`, then `py -3` on Windows, then PATH
most-specific-first. The only floor enforced is `sys.version_info >= (3, 10)`, asked of
each candidate rather than assumed. Exit codes: pass-through from `buddy.py`, **2**
when `buddy.py` is not beside the launcher, **127** when no usable CPython exists.

`omega/tests/test_launcher.py` does not only read these scripts — it executes them,
including a fake Python 3.8 that must be refused with 127 naming 3.10.

## 8. Data layout

Everything lives under one home: `%APPDATA%\StuddyBuddy` on Windows, `~/.studdybuddy`
elsewhere, overridable with `BUDDY_HOME`. Inside it: `buddy.db`, `vault`, `workspace`,
`export`, `skills`, `logs` and `reports`.

`buddy.HOME` and `DIRS` resolve **at import time** (≈`buddy.py:80`). `unittest` imports
every test module before running any, so the alphabetically-first importer decides
where all of them write. `test_companion.py`, `test_edit_invalidation.py` and
`test_legacy.py` therefore assert `Path(buddy.HOME) != _REAL_HOME` and refuse to run
rather than risk touching real user data. For the same reason `cmd_accept` and
`cmd_bench` spawn **child processes**: `acceptance.py` and `benchmarks/runner.py` point
`BUDDY_HOME` at scratch directories at import, and by then a live process has already
resolved the owner's real home.

## 9. Verification

Three layers, deliberately distinct:

- `omega/tests/run_all.py` — the gate. Unit tests, the engine self-test, capability
  benchmarks, the MAJIN bridge self-test and MAJIN's own `node --test` suite.
- `omega/acceptance.py` — the 20 mandated end-to-end scenarios, with evidence written
  to disk.
- `.github/workflows/omega.yml` — both of the above, on ubuntu + windows × Python 3.11
  + 3.13, plus a check that `package-lock.json` stayed byte-identical after
  `npm install`.

The status word in `print_report` stays first in the line, because `run_all.py` parses
it. A leading glyph silently costs the summary its failure details. `USAGE` likewise
stays plain text; colour is applied by `render_usage()` on the way out, never in the
source, because the contract test parses it.

**BLOCKED is never upgraded to PASS.** It means this machine cannot prove the property.
That is a statement about the host, and it is reported as one.

See `ACCEPTANCE.md` for the current honest result, `LEVELS.md` for how capability is
computed, `MIGRATION.md` for legacy data and hand-over, and `CAPABILITY_REPORT.md` for
what is measured right now.
