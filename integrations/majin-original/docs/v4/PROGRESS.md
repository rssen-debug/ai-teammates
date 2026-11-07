# MAJIN V4 — verified progress

**As of:** 2026-10-23 (Europe/Stockholm) · see the universal-agent section at the end
**Branch:** `v4/main` · **Base:** V3 `df678b2`
**Release status:** **NOT READY** — private vertical slice works, no verified public URL.
**Score source of truth:** `npm run v4:progress` (recomputed from `ACCEPTANCE_MATRIX.json`, never hand-written)

## Score

- **Verified:** **78.5/100** points (**78.5%**)
- **Criteria:** 75 → 62 VERIFIED · 1 PARTIAL · 9 NOT_STARTED · 3 BLOCKED

| Area | Earned | Weight | What is actually proven |
|---|---:|---:|---|
| BASELINE | 4 | 4 | refs recorded, protected branches untouched, no secrets, matrix validated by code |
| MOBILE | 9.5 | 12 | manifest + icons, safe areas, responsive, reduced motion, 42px targets, SW shell-only, model picker |
| SECURITY | 13 | 14 | pairing, sessions, revocation, CSRF, origin/host, rate limits, CSP, traversal, no keys to client |
| CONVERSATION | 9 | 9 | streaming, persistence, idempotent retry, cancellation, scoping, deletion, honest errors, corrections linked as revisions, cross-device read |
| GOALS | 12 | 14 | V2 state machine, SHA-256 verification, receipts, crash→BLOCKED, resume re-verifies against recorded hashes, tool failures classified |
| MODELS | 12 | 14 | V1 config reuse, V1 live catalog discovery (TTL cache + refresh), no secrets, id scoping, demo degradation |
| VOICE | 7 | 9 | honest capability model, language, error copy, auto-send rules, speech text |
| PLATFORM | 12 | 12 | versioned kernel, manifest validation, rollback, opt-in + allowlist + flags |
| HOST | 0 | 12 | nothing verified — no Windows host and no tunnel in this environment |

## What works right now (evidence-backed)

1. A phone-sized browser can pair with a code, receive a session and hold a conversation.
2. A real turn streams over SSE, executes typed tools and verifies file writes on disk (SHA-256).
3. Conversation history, goals and receipts persist to disk and survive a restart.
4. A repeated `requestId` is replayed instead of executing twice (safe reconnects).
5. Cancellation aborts the active turn and records `CANCELLED`.
6. `GET /api/models` lists the models from the existing Windows MAJIN config, with no key material, and
   `?refresh=1` runs V1's live provider catalog (pagination, auth, origin pinning) behind a 6 h cache.
7. Model choice is scoped to one conversation and validated server-side.
8. Without a configured provider the app runs a labelled demo brain — it cannot pretend to be an LLM.
9. PWA shell is installable (manifest + 192/512/maskable icons) and never caches API data.
10. Plugin kernel validates manifests, enforces declared permissions, rolls back failed activations,
    quarantines a broken plugin with a written reason, and runs plugins in a supervised child
    process with a stripped environment and per-call timeouts.
11. Resume of a BLOCKED goal re-verifies every artifact against the hash recorded when it was
    written; a deleted or tampered file keeps the goal BLOCKED instead of "completing".
12. A correction ("nej, ändra X") is recorded as a revision of the previous goal, not an orphan task.
13. A second paired device sees the same conversation and the same goal state.
14. A prompt-injection corpus (path escapes, role tags, huge payloads, reserved names) cannot
    leave the workspace, break a schema or skip approvals.
15. `npm run v4:bench` measures pass rate, p50/p95 latency, tool calls and receipt coverage,
    and detects duplicate-request replay.
16. The browser client keeps the conversation across turns. This was **broken**: the UI dropped
    the conversation id the server returned, so every message started a new thread. The client
    state is now a pure, tested module (`src/v4/ui/session.js`) driven by the same SSE bytes the
    server emits, including CRLF, split chunks and malformed JSON.
17. A BLOCKED goal can be resumed from the phone. The button never promises success: the server
    re-verifies against recorded hashes and can answer "still blocked" with the exact items.
18. Server-side speech is wired through the V2 voice lane. Three lanes are proven: the deterministic
    `buffer` provider (silent WAV, labelled synthetic), a **real local binary** spawned argv-only
    with a scrubbed environment (`command`), and refusal of a shell pipeline in the template.
    STT goes through the same lane and reports an empty transcript as `inconclusive`, never as a
    sentence nobody said. A cloud engine (`edge-tts`) needs network and is not claimed.

## Remaining by area (9 NOT_STARTED + 2 PARTIAL + 3 BLOCKED)

| Area | Points left | What it needs |
|---|---:|---|
| HOST | 12 | the Windows machine, the tunnel and a phone |
| VOICE | 2 | a real device: measured TTS latency and barge-in (V6) |
| MOBILE | 2.5 | physical-device walkthrough, real-browser visual regression, spirit polish |
| GOALS | 2 | multi-step browser goal on the host |
| MODELS | 2 | real inference (blocked: no provider key here) |
| SECURITY | 1 | external penetration test |

## Open blockers

- **H3/H4 (8 points):** no private HTTPS URL and no physical iPhone/Android run. Needs the owner to
  run the tunnel on their Windows PC (`docs/v4/DEPLOYMENT.md`) — credentials/DNS are the owner's.
- **A7 (4 points):** real inference through a configured provider is blocked here: no provider key
  and no outbound network to a model endpoint in this sandbox.
- **H1/H2/H5/H6:** Windows-specific automation (logon task, desktop session limits, restart
  persistence on the real box) is written as scripts but unexecuted on Windows.
- **Voice V6/V7:** no measured TTS latency, no barge-in measurement, no server-side STT/TTS wiring.

## Honest limitations of the demo brain

The demo brain understands a narrow set of file intents (write / list) and otherwise explains that
no model is connected. It is a transport-and-execution harness for real model wiring, not an
assistant. Any progress point that depends on model quality is not claimed.

## Connection survival (new, evidence-backed)

A dropped connection used to abort the turn. On a phone that meant asking again and
losing the work. The turn now runs independently of the HTTP response and is recorded in a
bounded journal (`src/v4/turns.js`): every event carries a sequence id, a client can reattach
with `GET /api/chat/stream?turnId=…&from=<lastSeq>`, and the UI retries with backoff.

Proven by `test/v4/turns.test.js` and `test/v4/client.test.js`: the file is written even when the
client hangs up mid-stream, and the reattached client receives the verified tool result and
the terminal status without duplicates.

## The client is now executed, not just inspected

Every earlier UI test read files. `test/v4/client-dom.test.js` loads the shipped `index.html`
into jsdom, points `fetch` at a real MAJIN host, evaluates the same `app.js` that goes to the
phone, and drives it: boot → gate → pairing → type → send → verified tool card → answer, and
two messages that must stay in **one** conversation.

That test would have caught the dropped-conversation-id bug the day it was written. Canvas,
speech and service workers are stubbed (jsdom has none); the application code is not.

The three ways a phone actually fails are covered too:

| Scenario | What the test proves |
|---|---|
| Host unreachable | an honest error appears and the composer works again — no stuck "streaming" state |
| Session expired mid-turn | the pairing gate re-opens with a reason instead of failing silently |
| Connection lost **after** `open` | the client reattaches to the same turn and shows the host's real answer, not a host-failure message, and the work exists exactly once on disk |

jsdom is a devDependency, so this runs in CI instead of being a local curiosity.

## What a real browser would add (and why it is still unearned)

`npm run v4:e2e` contains the acceptance run: five viewports (iPhone 13/SE, Pixel 7, iPad,
desktop), horizontal-overflow checks, 42px touch targets, composer above the fold, pairing,
a real message, a **verified** tool card, console-error check, and screenshots into
`docs/v4/evidence/`. It skips loudly when no browser binary exists.

No browser binary can be obtained in this environment: Playwright's CDN, Google's storage and
`objects.githubusercontent.com` are all unreachable, and the npm-shipped Chromium needs NSS
≥ 3.30 which the image does not have. So M11 stays unearned rather than being replaced by a
claim. On the Windows host: `npx playwright install chromium && npm run v4:e2e`.

## One command that proves (or refuses) the release

`npm run v4:accept` exercises a real host on this machine and prints PASS/FAIL for every
automated gate: health, anonymous access refused, pairing works, cookie is HttpOnly +
SameSite=Strict, CSRF required, cross-origin refused, chat streams, the tool result is
**verified**, the file is on disk with the right bytes, the conversation reloads, and a
**second host process on the same data dir still sees the finished goal**.

Add `-- --url https://your-tunnel` and it also checks the public URL is HTTPS and refuses
anonymous reads. `--write` stores the run under `docs/v4/evidence/`.

The runner cannot flatter the project: it exits non-zero when any check fails, and it reports
`model.configured: FAIL` while no provider is configured — a demo brain is not a model.
Acceptance points are still written by hand, from that output.

`npm run v4:serve:supervised` runs the host under `src/v4/supervisor.js`: health probing every
15 s, restart with exponential backoff, a hard cap so a crash loop fails loudly instead of
spinning, and one JSON line per lifecycle event in
`v4/logs/supervisor-<date>.jsonl`. Tested with real child processes that are killed.

## Keeping the data when the disk dies

`npm run v4:backup -- backup` writes a plain directory bundle with a `MANIFEST.json` and a
SHA-256 per file — the same discipline as V2's audit bundle, and memory is exported through
`MemoryStore.exportAll()`, not a second serializer.

Refusals are the point:

- keys, pairing records and session records are **never** copied; a backup that carried the
  HMAC key would let anyone holding it forge sessions, so a restore means pairing again;
- `verify` re-proves manifest ≡ files and rejects tampering, missing files and unlisted extras;
- `restore` refuses an unknown `schema` instead of guessing — that is the migration check;
- `restore` refuses to overwrite live data without `--force`, and `--dry-run` validates without
  writing a byte.

## Upgrading a release without breaking the running one

`npm run v4:upgrade` fetches, checks out `origin/v4/main`, then runs install → doctor → tests →
matrix. If any gate fails it returns the checkout to the previous commit and reinstalls. A failed
rollback is reported as `ESCALATE`, not swallowed. `-- --dry` shows the plan and touches nothing.

The decision logic is tested with an injected runner, including the rollback path and the
escalation path, so the dangerous branch is exercised before it is ever needed.

## Hardening pass: six defects found by testing the system against itself

No new features in this pass. The target was the failure modes of a host that runs for months.

| Defect | Consequence if shipped | Fix |
|---|---|---|
| Rate limiter never evicted buckets | one permanent entry per client address, for the process lifetime | sweep per window + hard cap |
| Conversation cache never evicted | every conversation stayed in memory | LRU, 200 entries |
| `list()` returned every conversation file | the drawer got slower as history grew | bounded to 100 |
| First message of two devices shared the abort key `'new'` | one device silently cancelled the other | one key per turn |
| Stop no longer stopped the turn | the journal made turns outlive the socket; stop only detached | stop sends the turn id to the server |
| Repeated request after truncation replayed an empty answer | user sees a blank reply labelled "replayed" | explicit `already_handled`, tools never re-run |
| Goal store retained every goal object forever | memory grew with every task ever run | bounded cache; only non-executing goals are evicted |
| Conversation history had no token budget | a long chat on a small model failed the whole turn with "context length exceeded" | budget-aware packing reusing V2's token estimator; newest message + system prompt always survive |

Each one has a test that failed before the fix. That is the only reason to trust the list.

## Windows autostart: a defect V1 had already solved

My installer registered the logon task without two settings V1 has used for a long time:

- **battery**: Task Scheduler stops a task when the charger is unplugged unless told otherwise
- **72-hour limit**: the default `ExecutionTimeLimit` is 72 hours, after which Windows kills it

Both are now copied from `install.ps1`, V4's restart-on-failure is kept, and
`test/v4/windows-installer.test.js` fails if either disappears. This is the honest
answer to "is there something on GitHub to reuse": yes, and ignoring it cost a bug.

## The commands are tested as commands

Every earlier test called a library function. `test/v4/cli.test.js` spawns the scripts the
owner actually types, with a real environment, and asserts on **exit code** as well as output —
because a scheduled job and a human both depend on the exit code:

- `host-doctor` (text and `--json`), exit 0 on a usable host
- `progress --json`, and exit 1 on a broken matrix
- `backup → verify → restore` round trip across two data directories
- `restore` without `--force` exits **1** and says `REFUSED (ALREADY_EXISTS)`
- a single tampered byte makes `verify` exit **1**
- `plugin list` / `plugin quarantine` on an empty host
- `upgrade --dry` changes nothing (HEAD asserted before and after)
- `benchmark` exits 0 only when all seven scenarios pass

The upgrade output also now explains the detached checkout and how to return to the branch,
which was the one place a user could get stuck without knowing why.

## Bounded tool recovery, reusing V2's advisor

A failed tool call used to end the turn immediately. V2 already ships a pure recovery
advisor (`src/v2/recover/advisor.js`): failure class → ordered, bounded plan. V4 now consults it.

The rule that makes this safe:

- **read tools** may be retried (`retry_simple` / `retry_backoff`), bounded by the advisor's
  budget — `TIMEOUT` gets 1 retry, `NETWORK_FAILURE` gets 2, never more;
- **write tools are never retried.** An error can surface *after* the effect landed, and a retry
  would duplicate it. The test asserts a write is attempted exactly once.
- failure classes whose plan needs a human (`PERMISSION_DENIED` → `escalate`) execute nothing and
  surface the advice instead of inventing a step.

Both attempts stay in the goal's receipts, so the evidence shows what happened.
The UI shows "Försöker igen (1) efter TIMEOUT" instead of appearing frozen.

**This does not move the score.** "Bounded tool recovery" was not one of the 75 criteria when the
matrix was written, and adding a criterion now — then marking it verified — would be scoring my
own homework. It is recorded here as delivered capability with evidence
(`test/v4/recovery.test.js`), and the matrix stays at 78.5/100.

## Conversation context now fits the model

`historyFor()` sent the last 30 messages whatever their size. Forty turns of long answers is
normal on a phone, and on a small-context model that turns every message into a provider error
the user cannot act on.

V4 now packs history against a token budget (`MAJIN_V4_MAX_CONTEXT_TOKENS`, default 8000),
reusing V2's `estimateTokens` so the whole product measures tokens the same way. V2's `pack()`
is deliberately not used: it flattens prioritised sections into one string and destroys the
role structure a chat model needs.

The rules, each with a test that failed first:

1. the newest message always reaches the model, truncated from the tail with a visible marker
   if it alone exceeds the budget — the marker is counted inside the budget;
2. older turns are dropped oldest-first until it fits;
3. the system prompt is never trimmed;
4. when anything was dropped the client shows a quiet note, not an error.

## Observability: the host can now be debugged

An always-on Windows box with no logs is undebuggable — when something is slow or fails at
03:00 there is nothing to read. V4 had no telemetry at all.

V2's `src/v2/telemetry/ledger.js` is now wired in unchanged. Its property is the reason it was
reused: the serializer keeps a **fixed field allowlist per event** and silently drops everything
else, so message text, file names, absolute paths and keys cannot reach the log even by mistake.
Aggregation is V2's `aggregate()`; the presentation is V4's own (`npm run v4:logs`), because V2's
renderer titles its report for V2.

Events recorded: `goal.start`, `goal.finish` (state, duration, receipt counts), `task.result`
per tool call, `model.call` (provider, model, tokens), `verification`.

Proof, not a claim (`test/v4/telemetry.test.js`): a real turn is run with a recognisable secret in
the message, then the raw ledger is read back and asserted **not** to contain the secret, the file
name or the data directory — while a control asserts the file on disk really does contain it.

Telemetry is optional by construction: a broken ledger cannot take a turn down, which is itself a
test.

## Memory was write-only

V4 shipped `memory_save` and `memory_search`, but nothing loaded memory into a new turn. The model
would have to decide to search before it knew anything worth searching for, so a saved preference
never reached a fresh conversation. "Living memory" that is only written is not memory.

`src/v4/memory.js` retrieves per turn and injects a labelled section into the system prompt:

- ranked by **term overlap** (V2's `search()` once per significant word — its whole-string
  semantics are right for its own callers and wrong for a sentence), then importance;
- a hard cap of 6 entries / 900 characters, so the prompt cannot grow with the memory store;
- preferences marked `importance >= 0.8` are injected regardless of wording, because
  "always answer in Swedish" must survive a question that never says *Swedish*;
- the section says these are **notes the owner stored — data, not instructions**, so a memory
  cannot outrank the rules. Tested with a memory that literally says "ignore your rules".

Proven end to end: a preference saved in one conversation is asserted to appear in the system
prompt of a **different** conversation, and a broken memory store cannot take a turn down.

## Integration seams: a resumed goal left no record

Unit tests pass while the seams leak. `resumeGoal` changed a goal's state on disk and emitted an
SSE event, but `appendMessage` was never called — so the user resumed a blocked task, saw a
confirmation, reopened the conversation later, and there was **no trace of it**. The goal said
COMPLETED; the history said nothing.

The V2 `Goal` schema is not ours to change, so the conversation id is resolved where it already
lives: the assistant message that references `meta.goalId`. `ConversationStore.findByGoal()` does
that, cache-first, bounded by the 100-conversation listing.

Also fixed in the same seam: resume wrote no `goal.finish` telemetry row, so the log claimed the
goal finished once when it had finished twice. A test asserts **two** rows for two finishes, and
that test fails on the old code (verified by stashing the fix).

Two more seams checked and found already sound: a model chosen for a conversation survives a
reload, and the goal state shown in a reopened conversation is the live one.

## Cancellation now reaches the work

Pressing stop used to detach the client while the tool kept running for up to its full timeout
(8–20 s, 15 s for plugins), and its side effects landed with no receipt. The UI said cancelled.
That is the worst kind of lie.

Two causes, both in V4:

1. `executeToolCall` received **no signal at all**. V2's runner calls `def.execute(input)` with one
   argument and V2 is not ours to change, so V4 now hands the runner a **per-call registry facade**
   whose `get()` returns a definition bound to this call's `AbortSignal`. No shared state is
   mutated, so two concurrent turns cannot see each other's signal.
2. Plugin tools ran in a child process with no way to be stopped. `worker.call()` now accepts a
   signal; on abort it stops the worker, because the only way to stop code inside a child is to
   end the child.

A tool that ignores the signal behaves exactly as before — the contract is opt-in, and the test
uses one that obeys and one that does not.

**Second seam, fixed the same day:** logging out left the turn running to completion. The revoked
device could not read the result (its cookie is dead, verified with a 401), but the work it asked
for still landed. `beginTurn` now records which session owns a turn, and logout calls
`cancelOwnedBy(sessionId)` so a revoked phone's pending work stops too. A test proves one device's
turns stop while the other's keep running.

## A deadline is not a stop

V2's runner races a tool against a timer. When the timer wins the promise rejects — but
`def.execute()` keeps running, with no signal. A tool that wrote after its deadline landed a side
effect after the goal had already been recorded as FAILED, and no receipt covered it.

V4's per-call registry facade now builds one `AbortController` per tool call, fired by **either**
the owner pressing stop **or** the call's own deadline. A cooperative tool stops before its effect
lands; a plugin tool stops its worker, because ending the child is the only way to stop code inside
it.

**The honest limit:** a tool that ignores the signal keeps running. No process can un-run code it
cannot interrupt, so the test asserts the weaker but true property for that case — an overrun never
earns a success receipt, and is recorded as `TIMEOUT`. Saying that out loud is worth more than
pretending the deadline prevents everything.

Proven the usual way: the cooperative-tool test fails on the old code (checked by stashing the fix)
and passes on the new one.

## The journal could forget work in progress

The reconnection buffer had two eviction paths and **neither consulted `done`**:

- **age**: a turn older than the 10-minute TTL was dropped, even mid-flight;
- **size**: creating a newer turn evicted the oldest by insertion order.

So the one case the journal exists for — a phone reconnecting to a long turn — was exactly the case
it failed. A 15-minute turn on a slow model became unfindable at minute 10, and the client got 404
"turn no longer buffered" while the host was still working.

Now only **finished** turns expire or are evicted. Live turns are protected up to a separate hard
ceiling (`JOURNAL_LIVE_CEILING = 200`), so a flood is still bounded — but normal use never
approaches it, and crossing it is a bug worth seeing rather than a silent drop.

**An existing test encoded the old behaviour.** `turns.test.js` created five turns, never finished
them, and asserted the buffer had dropped two. That assertion was the bug written down. It now
finishes its turns before checking the cap, and points at `journal-live.test.js` for the live-turn
contract.

Proven by stashing the fix: four of the six new tests fail against the old `turns.js`.

## Crash reconciliation was partly imaginary

A crash can leave a goal in any state a turn passes through. `reconcileOnBoot` looked at only two of
them, and attempted `VERIFYING → BLOCKED` directly — **a hop V2 does not allow** (`VERIFYING` exits
to COMPLETED/RECOVERING/FAILED). The throw was caught by an empty `catch`, so the function reported
success while doing nothing. The behaviour had been "tested" only by a test that asserted the
function returned the ids it claimed to.

What was actually broken:

| Interrupted state | Old behaviour |
|---|---|
| `RUNNING` | reconciled correctly |
| `VERIFYING` | **silently did nothing** — unrecoverable and invisible |
| `WAITING_FOR_TOOL` | not considered at all |
| `WAITING_FOR_APPROVAL` | not considered, and its pending approval survived the restart |
| `CREATED`, `PLANNING`, `READY` | never cleaned up |

`interruptPath()` now returns the hops the state machine actually permits: work that reached
execution goes to `BLOCKED` (via `RECOVERING` where there is no direct exit), work that never
started goes to `CANCELLED`, terminal states are untouched. A goal with no legal path is **named on
the boot banner**, not swallowed. Orphaned approvals are cleared with the same call.

Proven by stashing the fix: five of the eight tests fail against the old code.

## Upgrade could carry or lose uncommitted work

`upgrade()` ran `git checkout --detach <sha>` without ever looking at `git status`. With modified
tracked files, git either refuses mid-run or carries the edits across — and MAJIN would discover
which only after it had started moving the checkout. In this project's own history the working tree
has contained local modifications more than once.

Now the upgrade **stops before anything moves** if there is uncommitted work in a tracked file, and
says what to do (`git stash push -u`). Untracked files are explicitly allowed: they are not part of
any commit and survive a checkout untouched, so blocking on them would be annoying without being
safer.

The CLI also gained the error handling it was missing entirely: an `UpgradeError` used to surface as
an unhandled rejection. It now prints `STOPPED (DIRTY_TREE)` with the affected files and exits 1.

Proven with a **real bare git remote** rather than a mocked runner — five tests, one of which fails
against the old code.

## The reported bug: the model could only see five tools

Reported from the phone: MAJIN worked over OpenCode Go but could only use the five
workspace/memory tools. The diagnosis was exact.

**The registry was not the problem. The prompt was.** `src/v4/agent.js` sent a
hardcoded `TOOL_SCHEMAS` array of five entries to the model. Anything registered
afterwards — host files, PowerShell, Windows control — was invisible to the model,
so it could never call it. A tool the model is never told about does not exist.

Two changes:

1. **`schemasFromRegistry()`** (`src/v4/tools.js`) builds the model-facing tool list
   from the live registry, converting each zod input schema with `z.toJSONSchema`.
   The agent now calls `tools.schemas()`; adding a tool is enough for it to appear.
2. **`src/v4/tools/host.js`** detects every V1 tool lane and adapts it into a V2
   `ToolDefinition`, so host tools run through the same runner, approvals and
   receipts as everything else.

### What is now discovered (this Linux sandbox)

| Lane | Tools | Status here |
|---|---:|---|
| files (`fs.*`) | 12 | available |
| shell (`exec.*`) | 5 | available |
| power | 3 | available |
| web (`web.*`, includes `browser.*`) | 12 | available; browser tools withheld without a runtime |
| research | 1 | available |
| jobs (`jobs.*` — CV, search, match, prepare, send) | 9 | available |
| agent (`agent.delegate`, plan, moa) | 4 | available |
| flows | 6 | available |
| github | 2 | available |
| desktop / screen / computer | — | Windows-only, stated |
| browser runtime | — | no binary → **browser tools withheld and named as skipped** |

That is **45 host tools** + the 5 workspace tools = 50 in the registry, versus 5 before.

### Two defects the probe found

`npm run v4:tools --probe` calls one tool per lane through the real runner:

1. **A structured V1 failure was misreported as a broken tool.** V1 returns
   `{ok:false, error:{code,message,hint}}` — an object. The adapter's output schema
   expected a string, so `web_search` failing because no engine answered became
   `INVALID_TOOL_OUTPUT`. Now the object is accepted and mapped onto the kernel
   vocabulary (`classifyV1Error`), so "no internet" reads as `NETWORK_FAILURE`.
2. **`fs_stat` was probed against a directory**, which V1 treats as a different
   operation. The probe now stats a real file. That was a bad probe, not a bad tool
   — and the probe output made that obvious rather than hiding it.

### What is still not proven

Everything above is a **contract** on this machine. Whether `control.type` really
types into Notepad, or `jobs.search` really returns Danish listings, is proven by
`npm run v4:tools --probe` **on your Windows host**, not here. The acceptance test
you wrote needs that host, a browser binary and a credential.

## Uploads from the phone, and live previews of what MAJIN creates

Two surfaces that make the phone usable as a real client rather than a text box.

**Upload (`POST /api/upload`).** The phone sends `{name, type, data(base64)}`; the bytes land
in the workspace, so the file the phone shows and the file the agent can read are the same
file — not two copies. What is enforced:

- a **leaf name** only (no separators, no traversal, no reserved Windows device names)
- a **type allowlist**, and `html`/`svg`/`js` are deliberately absent: they execute, and an
  uploaded HTML file would be a script inside the owner's authenticated session
- size enforced twice — before decoding and again on the decoded bytes
- the payload is **re-typed from its magic bytes**; a "PNG" that is a PDF is refused
- a collision becomes `namn-2.ext`, never an overwrite
- `DELETE /api/uploads?name=…` removes one; nothing is deleted implicitly

**Preview.** When MAJIN writes an `.html` page, the chat renders it inline in an iframe with
`sandbox="allow-scripts"` and **without** `allow-same-origin`. The server sends
`Content-Security-Policy: sandbox` on the same response. Two independent locks: even a client
that forgot the attribute cannot let the page reach this app's DOM, storage or session cookie.
SVG is treated the same way because it can carry script.

Images show as cards with tap-to-zoom; PDFs and documents show as chips with a download link;
the service worker never caches `/api/` so a photo cannot linger in a shared cache.

Proven in the **real client**: `client-dom.test.js` uploads a PNG through the app's own
`fetch`, fetches the bytes back and compares them, then asks the app to preview an HTML file
and asserts the frame's sandbox attributes and the response header.

**Honest limit:** MAJIN cannot *see* an uploaded image unless the configured model accepts
image input. The upload is attached and described; whether the model reads the picture is a
provider capability, not a claim this release makes.

## Owner Mode: permission is a decision the owner makes on their phone

Host tools were behind `MAJIN_V4_HOST_TOOLS=1` — an environment variable that required a
terminal, a restart and a good memory. That is not how a phone user grants access to their own
computer.

**Owner Mode** replaces it. `src/v4/owner-mode.js` writes `<data>/v4/owner-mode.json` (0600):

- per-lane grants, so "web yes, desktop no" is expressible
- the filesystem lane **stays inert without a folder**, and a drive root can never be granted
- a revoke is effective on the **next call**, not the next boot: `refreshHostTools()` removes
  the tools from the registry and they vanish from the model's schema list too
- every grant and revoke is appended to an audit history with a timestamp
- a corrupt or unknown-schema file degrades to *nothing granted*, never to a permission

The installer seeds the safe set (`web`, `research`, `jobs`) and writes down why. Files, shell and
desktop are left for the owner to grant from **Behörigheter** in the app, where the consequence is
visible on screen.

## Skills: procedures, not buttons

Job search is no longer app code. `src/v4/skills/<name>/` holds `skill.json` + `SKILL.md`, and
`src/v4/skills.js` decides what the model is told:

| Rule | Consequence |
|---|---|
| required lanes not granted | the skill is **hidden** from the model |
| required tool not registered | hidden — a procedure naming tools it cannot call is a trap |
| a `prefers` tool is missing | **degraded**, not hidden: the prompt says what is unavailable and tells the model to say so plainly |
| malformed manifest | skipped and named on `/api/skills`, never half-loaded |
| huge SKILL.md | capped, so a hostile skill file cannot flood the context |

Shipped: `job-search` (CV → read → search → verify → compare → prepare, never submit without
approval) and `fix-code` (read → reproduce → minimal patch → retest → show diff).

## Next engineering objective

Wire the tunnel and a real provider on the Windows host, then run the acceptance scenario in
`NEXT_ACTIONS.md` #1 and move HOST points from NOT_STARTED to VERIFIED with captured evidence.


## Universal-agent integration — 2026-10-23

The owner corrected the product definition: MAJIN is a universal agent; the CV flow was an example.
This pass made the tool surface the union of V1–V4 and proved composition end to end. **The score
below is unchanged on purpose**: no criterion was added or reinterpreted after the fact. Points move
only when the pre-registered matrix says so.

### What was built and measured

| Item | Measured |
|---|---|
| V1 tools inventoried | 139 across 26 modules |
| V1 tools registered through lanes | 109 in 19 lanes (10 Windows/browser-gated at runtime) |
| V1 tools excluded | 30, each with a written reason (`src/v4/inventory.js`) |
| V2 components reachable from V4 | 18 of 51 (the rest have a recorded reason) |
| V3 components | 0 of 4 — the slice is superseded |
| Tools registered on this Linux host | 107 (8 built-ins + 99 host tools) |
| Model-facing list per request | core + activated + rest up to `MAJIN_V4_MAX_VISIBLE_TOOLS` (64) |
| Accessible beyond the budget | every registered tool via `tools_search` → `tools_activate` |
| Delegation | 1 level, ≤5 rounds, ≤6 tool calls, own V2 goal, verified artifacts lifted |
| Test suite | **455 tests: 454 pass, 1 skipped** (browser binary absent) |
| Static checks | 554/554 files parse; 0 Swedish literals in 291 files |

### Real end-to-end proof (not a unit stub)

`test/v4/universal-agent.test.js` starts an OpenAI-compatible SSE provider on a real socket and the
real V4 server, then:

1. the scripted model calls `tools_search("system information cpu memory")`;
2. it parses the result, calls `tools_activate(["sys_info"])`;
3. `sys_info` is **not** in the first request's tool list and **is** in the third — discovery is what
   made it callable;
4. it writes `systemrapport.txt`, reads it back, and answers;
5. the test asserts the file on disk, a verified `tool:workspace_write` receipt and a `COMPLETED` goal.

A second test proves delegation: the child request has a subagent system prompt, does **not** get
`agent_delegate`, uses only the named tool, and its answer reaches the parent turn.

### Bugs this pass found (all fixed with a failing test or a real probe)

1. `net.dns` used Node's callback DNS API without a callback → every lookup threw
   `ERR_INVALID_ARG_TYPE`, in V1 too.
2. `net.http` let a failed fetch escape as an unclassified crash → now `NETWORK_FAILURE`.
3. The adapter ignored V1's `required` parameters → missing arguments surfaced as `ENOENT`.
4. `agent.plan` wrote to a frozen context and `agent.delegate` reported `ok:true` while every
   subagent had failed — both replaced by V4-native delegation.
5. `tools_search` searched the registry it was defined on, not the turn's (subagent) view.
6. MCP tools lost their server JSON Schema because the exposure layer looked for it on the
   definition instead of the input schema.
7. **Updater: activation swapped the whole live tree**, deleting `node_modules` and `.git`; a
   successful update could never start. Replaced by a per-file overlay with a journal and rollback.
8. **Updater: every file was fetched from `<base>/<path>`** while releases publish `files/<path>` —
   the first end-to-end apply returned 404 on the first file.

### Still blocked (unchanged by this pass)

Windows execution, the interactive desktop, a real browser runtime, real model inference, the phone
over a tunnel, Task Scheduler firing the update task, and OCR. Commands that would settle each are
in `STATUS.md`.


## File access, shared history and chat management — 2026-10-23

Reported from the owner's real Windows host and iPhone: the server works and 6/6 tool probes pass,
but MAJIN could not find a granted document, the two devices did not share a history, and the layout
was not centred. What changed, and what is measured:

| Item | Before | After | Evidence |
|---|---|---|---|
| Granted folders | recorded, never enforced or advertised | enforced per call by `src/v4/path-access.js`; listed in the system prompt | `file-access.test.js` (7) |
| Finding a file by name | no such tool | V1 `fs.find` (reused, bounded, glob + name) | `file-access.test.js` |
| Reading a document outside the workspace | `document_read` was workspace-only | `path` inside a granted folder, same extractor | `file-access.test.js` |
| Revocation | next boot | next call | `file-access.test.js` |
| Conversation list | flat, unbounded, no views | `view` + `q` + `since` + tombstones | `history-sync.test.js` |
| Rename / archive / restore | missing | `PATCH /api/conversations` | `history-sync.test.js` |
| Delete | no confirmation, possible mid-turn | `confirm=1` required; `409` while a turn runs; `cancel=1` stops it | `history-sync.test.js` |
| Two devices | no sync | cursor polling, version-based reload, bookmarked open chat | `history-sync.test.js`, `client-dom.test.js` |
| V1 history import | none | dry-run + idempotent merge, source untouched | `history-sync.test.js` (2) |
| Layout | 900/780 px mix, `100vh` | one `--content-w` column, `100dvh`, centred hero | `ui.test.js` (3) |
| Chat management UI | a list in the settings sheet | drawer with search, tabs, per-row actions, confirm dialog | `client-dom.test.js` (4) |

Suite after this pass: **479 tests, 478 pass, 1 skipped** (no browser binary). Static gates:
558/558 files parse, 0 Swedish literals in 293 files, inventory has a decision for every module.

The score is unchanged: no matrix criterion was added or reinterpreted. The host rows (H1–H6) and
the device rows (M10, H3, H4) still need the owner's machine and phone.


## Multi-agent equivalence — 2026-10-23

The architect reviewed the inventory and found the real gap: V1's standing teams and V2's DAG were
not replaced, only approximated, and the inventory counted tool lanes only. Both are fixed.

| Item | Evidence |
|---|---|
| V1 `TeamStore` + `runTeam` + `runSwarm` reused unchanged, members = V4 subagents | `orchestration.test.js` "team: roster, blackboard, dependency order, checkpoint and resume" |
| Resume by `runId` skips finished nodes (no repeated work) | same test: `skipped == ['g1','g2']`, child runs stay at 2 |
| Blackboard, roster and checkpoint persisted in V1's own layout | same test reads `roster.json`, `memory.jsonl`, `runs/<id>/checkpoint.json` |
| V2 `TaskGraph` + `runGraph` reused; dependencies respected; results flow forward | `orchestration.test.js` "graph: dependencies…": step b receives `[a]`, three steps done |
| Verified artifacts lifted from a graph onto the parent goal | same test asserts a verified `subagent.verify` receipt |
| Budget breach is loud, including a parallel burst | "a budget breach is loud"; the V1 launch-time check was found to allow `spent > cap` in parallel and is now guarded by a reservation in V4's worker |
| Inventory shows engines, not only lanes | `npm run v4:inventory` → `v1Engines` section, V2 reuse 21/51 |

Still not equivalent, and not claimed: V2's orchestrator/compiler/supervisor (they plan for a loop
V4 does not run), and real-device verification of voice, Windows tools and mobile access.


## Self-improving skill acquisition — 2026-10-24

The owner's rule: teach MAJIN with goals, never with a new master prompt. Built
in `src/v4/learning.js` and wired into the existing agent, skill loader and API.

| Requirement | Where it is enforced |
|---|---|
| Only verified outcomes become skills | `extractCandidate` refuses anything but `COMPLETED` + a verified receipt |
| No secrets, personal data or brittle selectors | `sanitizeInstruction` + procedures store argument NAMES only |
| Never widen permission | `requires` = granted lanes ∩ lanes the path used |
| Distinct states, no silent promotion | `promote()` from evidence only; `revalidate()` marks STALE |
| Retrieval for a related task | `rankSkills` over topic keywords + state + confidence |
| Do not repeat a failed strategy | `avoid` list, surfaced in the prompt and refused at call time |
| Persistence across restart and clients | same on-disk skill format, proven through a real restart |

Executed evidence in this repository: `test/v4/learning.test.js` — 15 tests,
including the full A–H flow (fails → diagnoses → adapts → verifies → stores →
restarts → retrieves → does not repeat) and the avoid guard.

**Open, and reported as open:** the mandatory real-Go run
(`npm run v4:learn-accept`). It refuses to run without a provider rather than
pretending, and it is the only step of this gate that cannot be executed here.

Inventory after this pass: 9 built-in tools, 114 registered on this host, every
V1/V2/V3 component still carries a decision.


## Self-improvement pass — 2026-10-24

The owner asked whether finished repos exist to reuse. Five were checked via the
GitHub API; none is droppable (all are Python research harnesses or a Minecraft
JS library). The designs were reused instead — see `SOURCE_AUDIT.md` §8.

| Addition | Why it matters | Test |
|---|---|---|
| Parameter slots (AWM) | one procedure now serves many files/folders/pages instead of narrating one run | "a procedure becomes a template with bindable slots" |
| Step-level failure attribution (SkillAdaptor) | a changed environment breaks ONE step, not the whole skill | "a failure is attributed to one step" |
| Repeated-failure escalation | the skill becomes STALE only when the same step keeps failing | "turns a verified skill STALE" (real restart) |
| Transient exclusion | a timeout never becomes a permanent verdict | "a transient failure never becomes a permanent verdict" |
| Contrastive insight (ExpeL) | the same action failing in one context is a note, not a blanket ban | "a context-dependent failure is not turned into a blanket avoid" |
| Integrity hash | an out-of-band edit of a skill is visible | "an out-of-band edit … integrity hash" |

**Defect found in our own engine:** `penalise()` existed but was never called, so
a failed turn that had used a learned skill left no trace. `observeFailure` is now
wired into the agent's failure path and proven end to end.

Learning tests: 17 (was 15).
