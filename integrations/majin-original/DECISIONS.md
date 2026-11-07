# Decisions

Why MAJIN is built the way it is: **what we chose — why — what it cost — how it is proven**.
If you change one of these, change the entry here in the same commit. Nothing in this file is
allowed to contradict a test.

## Valt

- **Crash recovery = evidence arbitration, not optimism.** After an interrupt the code
  decides from journal + external inspection what may re-run — never the model.
  Kinds the code cannot inspect are parked as `uncertain` and require an explicit
  user action (Del 8 frontier). Cost: one sha256 per journaled write; payoff:
  "resume" can never duplicate an external effect.

- **Scoring comes from reproduction commands, never from the changelog.** Every row in
  `docs/COMPLETION_MATRIX.md` starts UNVERIFIED (0 pts) until the evidence exists; the
  informal 61% estimate is retired; a regression revokes already-awarded points.
  Cost: the scoreboard moves more slowly; payoff: the number always means exactly
  what the code proves on current main.

- **En mission-deklaration är aldrig sanning förrän verifieraren kunnat peka
  på filen i workspace.** `findClaimedArtifact` (deterministisk: write-verb +
  filnamespattern) plockar fram claimade artefakter, `verifyClaimedArtifact`
  behåller bara parts som kan bevisas, EN repair-runda med exakt felavgoerande
  gar tillbaka, och mission-summan fick aerliga verified/repaired-raknare.
  Cost: +1 extrarund per claimed-part (bara vid looogn); payoff: "Mission done"
  aer bevisdokument, inte beroring. Proof: test 8/9 fail-first roda pa pre-fix
  (loogna markerades ok: okCount var 2), groena efter; live opencode-run 36 s
  med 2/2 VERIFIED i workspace.

- **Inline-lista utlöser också mission.** Människor skriver "(1) x, (2) y, (3) z"
  i EN rad lika ofta som de radbrutar en lista; den radbrudna ankar-heuristikken
  gick förebi alla numreringar inuti en rad, så compilern såg dem aldrig.
  Nu extraheras inline-items deterministiskt (samma marker-familj, steg-stigande
  sekvens från 1/a, minst 3 items, så att decimaler och struntord stoppas)
  — utan modell-kall. Cost: en extra regex-pass per turn (~0,01 ms); payoff:
  mission trigger täcker en av de vanligaste människoformuleringarna av mål.
  Proof: `test/mission.test.js` fail-first röd före, grön efter; live-run på
  opencode Go visade exakt samma input → 3 worker_start + 3 worker_done + mission.
- **Compiler-fallbacken for inline-listor följer samma extraktion.** En mission
  triggad av inline-lista får aldrig degraderas tillbaka för att modellen bara
  kan text. Utrostring: heuristicNodes delar inline-items samma väg som line-list.

- **Preset-headrar hljer med verktyg-vagen, inte bara UI.** `majin.provider add` med preset
  kopierar preset `headers` in i config (opencode Go gatewayen 400:ar utan x-opencode-session).
  Cost: inget; payoff: agenter kan onboarda gateway-presets utan att användaren måste öppna
  UI-panelen. Proof: `test/provider-flow.test.js` rött före (headers saknades), grönt efter.

- **Sessionskontext = disk, alltid.** Agentturnen läser historiken från disk (240 meddelanden)
  om callern inte skickar den — aldrig verslailla mekanismer (cache, maps). Cost: en fil-läsning
  per tur (~0,1 ms); payoff: modellen kan aldrig tappa sammanhanget mellan meddelanden, oavsett
  vilken väg (chat-API, tasks, handoff) den kom in genom. Proof: `test/handoff.test.js` rött
  före, grönt efter.
- **Handoff = filen, inte en hemlig kanal.** Checkpointen är `<session>.handoff.json` +
  `<session>.plan.json` bredvid historiken — läsbar, diffbar, överlever restart och
  runtime-byte, och två agenter behöver aldrig prata direkt. Cost: extra disk-skriv
  per plan/händelse; generisk: vilken kompatibel modell som helst kan plocka upp den.
- **Handoff injiceras medvetet EN gång** (consume-märke `consumed: true`) — aldrig som tyst
  system-litteratur, och aldrig i dubbelkopia. Uppmaningen är explicit: "continue, do NOT restart".


- **A normal person has to be able to use it.** Pick the provider, paste the key, get going;
  the 78 tools, the model chain and the schedule are bonuses, never requirements for the first
  answer. Cost: no CLI-only features — every capability needs a tool *and* a panel surface.
  Proof: `test/onboarding.test.js` answers the first message from an empty home in 127 ms
  (limiet 15 s).
- **A few things fully, rather than many halfway.** It answers, it touches the machine, it
  remembers, it is reachable from a phone. Nothing else may degrade those four. Proof: `npm run
  bench` (7 scripted real scenarios, pass) + the full suite against the same code path a
  browser uses.
- **The browser tab is the product; the CLI is the door opener.** UI routes delegate to the
  tools (`/api/provider` runs `majin.provider`); onboarding tests drive HTTP endpoints, not
  internals. Cost: API surfaces must stay in sync with the tools.
- **Measure, then fix what the measurement showed.** Every fix starts from a number gathered
  on a fresh `MAJIN_HOME` against a request-counting stand-in provider — never from reading
  code and guessing. Proof. the onboarding wall: rejected key burned 4 retries in front of the
  user before; 1 step / 33 ms afterwards.
- **Write the failing test before the fix, ≤5 files per fix; when a fix wants more, the scope
  is wrong.**
- **Autopilot = task-as-session on top of the engine we already have.** `agent.turn` serializes
  per session, so each independent message becoming its own task *session* yields real
  parallelism, isolated history and per-task stop for free (`src/core/tasks.js`). A follow-up
  message carries the task id and rejoins the same session — duplicates are structurally
  impossible. Cost: one new module + server wiring; zero changes to the loop. Proof:
  `test/tasks.test.js` A/E/B scenarios against the real engine (182/0 in the suite).
- **Coordination is deterministic, never an LLM call.** Task registry, FIFO file locks
  (owner = task session, re-entry, 30 s timeout), atomic tmp-then-rename writes. No hidden
  model switching, no orchestrator model, no token spend on bookkeeping. Proof: lock FIFO/
  timeout/re-entry tests + awareness text built from live registry state.
- **Silent installs never launch the app from Inno.** `skipifsilent` stays on postinstall;
  one-click-update relaunch is our own watchdog (`src/core/update.js`, PowerShell
  `-EncodedCommand`, `%LOCALAPPDATA%\MAJIN\update-relaunch.log`). Why: Inno silent launches
  hang the setup process — CI-proven twice (below, Avvisat). Cost: relaunch lives outside the
  installer, so it must be watched on real Windows once (TODO). Proof: byte-verified script
  decode test + green CI release (run 39111598323 → assets + full Windows smoke).
- **A `.vbs` is never a launch target.** Shortcuts/autostart carry `wscript.exe` + the vbs as
  argument (the user's CreateProcess **193** dialog); interactive postinstall uses
  `runhidden` on the exe itself. Proof: stability test pins the launch-point pattern; Inno
  compile would fail otherwise.
- **One sentence, one place.** `explainError()` in `src/core/provider/chat.js` owns all failure
  wording (`no_key|auth|billing|model|toobig|rate|unreachable|upstream|provider`) with
  `retryable`/`needsKey`; no caller writes its own apology. Why: one failure reaches chat, SSE,
  toast and `doctor` — four phrasings of one truth is how products start feeling sloppy.
- **A permanent failure must not be retried** (401/402/403/404, missing key, over-long context);
  429/5xx/network keep backoff.
- **Never show the user the machinery.** No `Provider error after N failures`, no
  `EVIDENCE FROM THIS TURN`, no raw model metadata in the window.
- **The UI never hardcodes a provider list** (`GET /api/state` carries `presets`);
  **an empty box is not a save** (`needsKeyFor()` is the one rule); **your own endpoint belongs
  in the card, not in a config file** (address box, loopback/RFC1918 counts as yours);
  **no model chain while setup is unfinished** (`needsSetup` turns MOA off for the turn).
- **Shipped strings English; input may be anything.** `npm run i18n` gates `src/`, `scripts/`,
  `install.ps1` (word list + åäö + allowlist for the deliberate Swedish input matchers);
  comments/docs as Swedis as we like. New since 2026-10-18: the app itself must also *speak*
  English by default (owner requirement).
- **A submission without proof is not a submission.** `jobs.send` clicks, then
  demands confirmation words + saves a screenshot; the machine refuses
  `submitted` without evidence and leaves the status `waiting` with plain words
  instead. Same family as "no fake progress" — the pipeline is a ledger, not a
  mood board.
- **Parallel tasks render as cards, not as a second transcript.** The blessed single-stream
  chat stays byte-identical; parallel tasks own a card each (status chip, activity line,
  streaming body, stop button) and their events never touch the main-turn globals.
  Why: a full multi-stream refactor of `S.cur/S.tools/S.gauge` is maximal-risk surgery in a
  surface a browser here cannot smoke-test. Cost: parallel answers live inside their cards
  instead of being merged into the vertical timeline — acceptable until the first human round
  says otherwise.
- **Browser-use = CDP against the browser already installed.** No bundled Chromium, no
  Playwright dependency, no Python: Node≥22's built-in fetch+WebSocket speaks the DevTools
  Protocol. One window + one profile per agent session (isolation by construction, never
  shared tabs), fleet cap via the existing task locks, a deterministic 3-identical-actions
  loop guard, and evidence (page words, stuck values, real screenshots) in every tool answer.
  Cost: less API sugar than Playwright (we hand-roll ~6 well-chosen primitives instead of 200
  methods); a CDP wire test against a real browser is still owed on CI Windows. Proof:
  `test/browser.test.js` 6/6; `no-dead-tools` 4/4 at 84 tools.
- **Deferred-but-chosen product order:** browser-use reliability, parallel agents (done,
  backend), verification — then natural-language teamwork, ETA from real telemetry, the job
  agent — *then* Living Missions. Not because Missions are uninteresting; because Missions on
  unverified legs are a demo, not a product.
- **Deliberately not done:** silent telemetry/key mirroring/"improvement" uploads (dataset has
  *no upload code path*: `dataset.upload` is rejected by config validation); runtime rewriting
  of MAJIN's own source (self-config edits *config* with backup+diff only); anything requiring
  Windows Defender/firewall/service mutation; background multi-machine sync.

- **Parallelism decisions are arithmetic, not opinions.** `analyzeSwarm`
  counts the critical path, simulates makespans per worker count, and grants
  extra workers only when the modeled gain beats `max(2x spawn overhead, 10%
  of the sequential plan)`. If durations are unknown it says so and runs one
  worker - honest underdetermination beats a confident wrong number. Cost:
  until a mission compiler feeds it measured `estMs`, unknown-shape goals stay
  sequential (the conservative side; mitigated by per-node usage recording
  feeding future estimates). Proof: `test/swarm.test.js` 8/8 including the
  fail-first judges; `bench --swarm` measured gain 66% on real file IO.
- **Updates speak platform-truth and status-words.** One status field per
  check result (disabled|error|up_to_date|available) and non-Windows systems
  get the release page, never a stranded Windows installer. Cost: the
  windows_only chip-click no longer offers a manual download anywhere (the
  release page carries the same file - judged null loss, real gain).
  Proof: test/livedelivery.test.js 1-3, 7.
- **Mission decisions belong to code; models fill content.** shouldMission,
  graph validation (acyclic, max 6), worker count and scheduling are all
  deterministic. The model only PROPOSES the DAG JSON, and when it cannot
  (small local models), a deterministic list-extraction takes over - marked
  honestly as heuristic-fallback. Cost: free-form goals without any list
  structure stay single-agent (conservative, no forced splitting).
  Proof: test/mission.test.js 2-5; live qwen3:0.6b run 2026-10-18.
- **The swarm scheduler is work-conserving.** Capacity never idles while
  runnable work exists; blocked deps propagate transitively so no node waits
  forever. Cost: per-node timing interleaves more (acceptable; isolation is
  per-session subagent). Proof: test/swarm.test.js REGRESSION 9+10.
- **Diagnostics are opt-in, allowlisted, local-first.** No automatic uploads
  ever; endpoint required AND analytics:true. Cost: near real-time product
  insight is deferred until a backend exists. Proof: test/diagnostics.test.js.
## Avvisat

- **"loadSafe / meaningful-diffs" as the race answer** (2026-10-18): classifying
  a config file by how much it deviates from DEFAULTS solved nothing — the
  CLI/server race needed a write-path fix, not a judgement. Dropped before
  commit; the diff idea survives only as the tombstone registry.
- **Raw disk (no DEFAULTS, no expandEnv) as patch base** (2026-10-18): failed
  two configs at once — partial fixture files lost their defaults, and
  `{env:X}` literals turned into phantom keys. The base must be the exact
  `load()` pipeline re-run on the fresh file.
**Direct `.vbs` as an Inno launch target (0.5.2 installer).** CreateProcess code 193 on the
  user's real machine — a vbs is not a Win32 program. (Inno uses CreateProcess, not the shell;
  Explorer double-click resolving the association is why desktop icons
  *looked* fine.)
- **Postinstall launch via wscript+vbs during silent install.** CI job log: "install silently"
  → 17 min of silence → runner timeout; orphan `majin-win-x64` + `conhost`. Never again.
- **Postinstall launch via `runhidden` exe during silent install.** Same hang, 18 min, same
  orphan shape — the wscript was innocent; *launching at all* from silent Inno is the fault.
- **`skipifsilent`-less postinstall as the silent-relaunch mechanism.** Same corpses as above;
  relaunch now lives in the updater's watchdog, which is testable on any OS and leaves a log.
- **Fifth-quote-cluster Inno escaping** (`"""{sys}\wscript.exe"" """{app}\..."""`): Inno
  rejects interior 3-quote runs ("Mismatched or misplaced quotes", compile line 84). Quotes
  only at parameter edges; literal interior quote = `""`; the final form is encoded in
  `test/stability.test.js`.
- **MOA default-on** (`moa.policy:'always'` in early versions): a fresh install burned ~3×
  tokens on echoes of itself. External audit was right; default is `'off'`, opt-in only.
- **The global `S.busy` gate as the parallelism story.** It prevents exactly zero backend
  races (serialization already does per session) while making real multitasking impossible in
  the window. Removal scheduled with the task-card UI (TODO Hög prioritet).
- **Bundling Playwright/Chromium** (≈300 MB engine in a 97 MB install): same reason as below, plus it would leave two click-paths to maintain.
- **Importing browser-use/computer-use frameworks wholesale** (Python ecosystems): would break
  the "no Python dependency" rule from VNEXT §13. Patterns (Agent-Reach doctor, Playwright MCP
  context isolation) are taken; frameworks are not.
- **Re-tagging a published release.** Violates the owner's standing rule; a tag may only be
  recreated while it has never produced release assets (used twice for v0.5.3 pre-release CI
  iteration, then left alone).

## Öppna frågor

- ~~**Ska loopen skicka RELEVANTA verktygsscheman i stället för alla 103 till modellen?**~~
  **BESLUTAT 2026-10-18**: ja — subset ar standard nu. Mål-villkoret var
  uppmatt paritet + raknad besparing innan flipp; bench fyllde det
  (-97% schema-char, paritet 7/7). Limitation som star kvar: paritet mäts mot
  en SCRIPTAD mock, sa "selector-blindness" (modellen ser inte verktyget den
  behovde) kan inte observeras har — den risk mitigeras av flyktvagen
  tools.search och av capability.test.js som pinnar search-rankingen. Om
  verkliga modeller visar returvag-ofel: rulla tillbaka via agent.toolSubset=false
  (en rad, redan testad).

- ~~**Job dedupe identity**~~ **DECIDED 2026-10-18**: fingerprint = canonical URL
  (tracking params stripped, real id params kept, case/diacritics-folded
  title+company fallback). The pipeline file IS the dedupe memory — one place where
  "seen" lives, one truth for the agent and the user. Cost: two postings of the
  same real job (apply-direct vs board) with different urls are two applications;
  acceptable, they are different submission channels anyway.
- ~~**Card telemetry source**~~ **DECIDED 2026-10-18**: the card's own clock + the card's
  own `tool_result` events (elapsed, count, self-measured average). Globally aggregated
  intervals may enrich later via `/api/tasks`, but a predicted total finish time is not
  displayable from what we measure — so totals stay unshown until something counts them.
- **Ambiguity tiebreak for NL control.** Shipped stance: a sentence matching two live tasks is
  refused with a plain-words error ("which one?"), never guessed. Candidate if it annoys:
  task the user most recently addressed, else ask once. (DECIDED 2026-10-18 unless UX says
  otherwise.)
- ~~**ETA granularity**~~ **DECIDED 2026-10-18**: per-tool measured ms → interval
  {avg, lo, hi} after n≥2 runs of the same tool; null answer is valid. Card-level
  aggregation is a display problem, not a prediction model.
- **Pause mechanics.** Shipped pause is abrupt (stop mid-turn + status `paused`; resume says
  "Continue from the step ..."). A graceful "finish the current tool call, then hold" pause is
  the open refinement — loop.js has no safe-point concept yet.
- ~~**Resume channel**~~ **DECIDED 2026-10-18**: resume rides the reply path
  (follow-up with a continue-brief into the same session) — it streams onto the
  exact card that paused it, no second engine path. The NL "resume agent N"
  command stays for channels, unchanged.
- ~~**Where do prices come from**~~ **DECIDED 2026-10-18**: from the provider's own
  `/models` answer when it carries pricing (OpenRouter/Kilo do), imported as GAPS ONLY
  with provenance — a hand-set or shipped price is never overwritten by a later list.
  Cost: prices for providers without pricing in `/models` stay unknown... which is the
  point: unknown is never reported as $0, it is counted (`unpricedCount`) and treated
  as PAID under a spending cap. Proof: `test/pricing.test.js` 6/6.
- **`cap/1`-kontraktet är utlett, inte handskrivet** (2026-10-18): sideEffects,
  tags och inputs härleds ur risk/namn/schema som redan finns. Underhållsdyrk:
  en handskriven klassificering hade sett bättre ut men kostar en människa vid
  varje ny verktyg. Cap/2 får lägga till kostnad/tillstånd/verify per verktyg
  när bevis finns att det används.
- **Brand consistency is enforced by measurement, not memory** (2026-10-18):
  brand.test.js asserts rosa-dominans + M-separation i varje ico-storlek och
  båda png-varianterna. En framtida designändring = ändra kanonen + alla
  varianter + toleranserna i testet. Utpekade småstorlekar som "fel" ska
  först mätas — 16px-M:et är samma märke, inte en gammal design.
- ~~**Whose truth is the config file**~~ **DECIDED 2026-10-18**: the disk, at the
  moment of the patch. Readers may be stale; writers never are. Cost: one
  file-read per patch (negligible) + the tombstone rule below. Proof: the
  CI failure chain that unearthed it, and the three config.test pins.
- **Deletions are process-scoped tombstones, not global ones.** A key this
  process deleted (undefined in a patch) stays deleted across ITS future
  merges; a key it never heard of and another process added must still arrive.
  Anything stronger (tombstones persisted to disk) would resurrect the very
  DEFAULTS-refill problem preset providers already have on boot.
- ~~**Does the budget cap stop anything**~~ **DECIDED 2026-10-18**: yes, since today —
  `budget.mode 'cap'` refuses the call in the loop preflight, BEFORE it costs. Free
  routes (0/0 price, mock, own server on loopback/RFC1918) still answer. Rejection is a
  sentence the user can act on, never a spinner. Proof: `test/pricing.test.js` 4/6.
- ~~**Browser live-gate cadence**~~ **DECIDED 2026-10-18**: two consecutive green runs
  (39 119 535 069 + 39 120 606 397) and one real bug caught on run one — the local form
  server is deterministic enough for the Windows runner. `continue-on-error` removed;
  the live step is a hard gate now.
- **Browser-context resource model.** Files lock cleanly by path; a browser context is not a
  path. Candidates: a named-resource lock per provider-site domain; count-based pool keyed by
  `channel:browser`. Decided when browser hardening starts (next phase).
- ~~**Job submission form model**~~ **DECIDED 2026-10-18**: generic field-role
  detection (whole-word vocabulary over label/aria/placeholder/name + hard type
  gates — a file input is never a phone). Zero site recipes SHIPPED; recipes are
  permitted only as fallbacks behind the classifier when a real counterexample
  arrives, never as the front door. Proof: substring-trap pins
  (`js ⊂ node js`, `.net ⊂ kubernetes`, `internet ⊄ linkedin`) in
  `test/jobs.test.js`.
- **Handoff cost.** Reassigning an agent to a sibling's task needs the sibling's plan + state
  summary; how much do we copy vs re-derive? Test with the first real teamwork run.
- **Living Missions data model.** One persistent goal holding many tasks + decision points —
  is it a task with children, or a new object? Deferred until the teamwork phase proves what
  the primitives should be.

## 2026-10-18 — Del 4A: verify in code, repair before you fail, provenance in the summary

- **Contracts are checked against evidence, never against a second model.** A
  `count` contract is re-counted with `fs.readdir` and compared to the number the
  worker printed; a `file_contains` contract runs `readFileSync.includes`. A fresh
  model call would inherit the same hallucination family — code checks cannot.
- **A dead contract means repair, not instant failure.** The repair prompt names the
  dead contracts so the retry fixes the right thing; the part still ships only if the
  repaired output re-verifies. Fail-fast would trade four acceptance points (deliberate-
  failure REPAIR) for nothing.
- **Provenance strings are first-class output.** "VERIFIED: 3 files (independently
  counted)" and "reported, not independently verifiable" are deliberately different
  sentences in the mission summary — the user must see the difference between checked
  truth and a claim we took on faith.
- **`count` contracts only bind when the brief targets the workspace.** A mission like
  "how many moons has Jupiter" has no verifiable `count`; the engine only fires when the
  brief names a local directory, avoiding false repair rounds on trivia.

## 2026-10-19 — Del 4C: one limits policy, charged on measured usage, markers are contract-level honesty

- **The model never limits itself.** retry/timeout/budget live in one object
  (`missionLimits`) with hard clamps in code. A safety gate that is a prompt is a
  suggestion; a gate in the scheduler is a guarantee.
- **Budget counts provider usage, not chars-in-my-head.** subagentWorker forwards
  `usage`; repairs are charged to the same pool. Mock usage (`reported:false`) is
  accepted in tests exactly because the wiring is what is under test.
- **Exceeded caps must be visible to the user.** `[LIMIT:RETRY]` explains WHY a
  part failed differently than `verification failed` — the difference between
  "the worker was wrong" and "we chose safety" is product-trust material.
- **Abort marks, it does not fabricate.** Parts killed by budget/timeout end
  `blocked` with a LIMIT tag, never `ok`. A limit firing mid-flight must never
  retro-certify half-finished work.

## 2026-10-19 — Del 3C/3D: one accountable recovery owner per layer, locks proven hostile-safe

- **Recovery must have ONE owner per scope.** Provider call (chat.complete),
  agent turn (loop error counter) and mission scheduler (runSwarm) ALL retried
  at once: up to 3×4 invisible attempts. For missions the scheduler is now the
  only owner (workers: retries 0 / errorCap 0). Chat keeps its layered
  resilience — different product need, same library.
- **"Transient" is an allowlist.** Only network/rate-limit/5xx shapes retry;
  everything else is permanent and runs once. A generic "retry on error" gate
  would duplicate side effects on semantic failures — exactly the failure mode
  the directive forbids.
- **Replacement = fresh session, not continuation.** `:a2` sessions start
  empty because a half-dead worker's context is part of what failed.
- **Locks are proven hostile-safe, not assumed safe.** The adversarial test
  WANTS to corrupt; the mutex is what saves it — and the sabotage run proves
  the test notices when the mutex is gone.

## 2026-10-19 (kväll) — Del 2C: ask before touching, replan once, carry what already passed

- **A question is cheaper than a wrong side effect.** The clarify path exists
  only at compile time, costs zero workers and zero writes, and its question
  must NAME the missing choice. It is deliberately NOT a new agent loop.
- **Repair floods a puddle; replan re-routes the pipe.** Repair retries the same
  instruction N times (bounded); only THEN does one strategy-change attempt run
  (also bounded), against the SAME contracts. The order is load-bearing: strategy
  change is expensive, retry is cheap.
- **Carried work trusts the recorded verdict, not re-verification.** A part
  VERIFIED under the previous objective keeps its verdict by node id and says so
  in plain text ("carried from previous objective"). Re-verifying costs tokens
  for evidence we already hold; hiding the provenance would be lying.

## 2026-10-19 (sen kväll) — Del 6A: one gate, measured cost only, unknown is not zero

- **One guard, two call sites.** `budgetGate` lives in loop.js and is used by
  the loop for both monthly and per-task decisions — testing the function
  tests production behavior exactly; synthetic routes and live loop share the
  same code path.
- **A per-task cap gates on measured COST, never on token counts.** Ten
  million free tokens are free; gate vibrancy metrics would break local-model
  workflows for no safety gain.
- **"Unknown" is its own state, distinct from both zero and priced.** A cloud
  model without a price table may not display as $0 (that lies to the user's
  wallet) — it renders UNKNOWN and, under a cap, does not spend.

## 2026-10-19 (natt) — Del 7B+7C
1. **Adapters are descriptors, never code.** JSON + allowlisted fields; validation
   is the security boundary, so it runs INSIDE `create()` — you cannot opt out.
2. **Failure state lives ON DISK, not in memory.** Two agents (or a crash+restart)
   share one truth; a success streak cannot be faked by process lifetime.
3. **Disable is honest, not fatal.** A repeat-fail skill is filtered from selection
   and prompt, but the file stays with its history; `enable()` resurrects it when
   the world changed. Data only dies by explicit user deletes.

## 2026-10-19 (natt, fortsatt) — Del 7D
1. **Execution re-validates, always.** An attacker who can edit the data dir
   still cannot sneak a hostile descriptor past execution — validation re-runs
   from the on-disk bytes on EVERY call.
2. **External writes need two yeses.** approved:true from the caller AND a live
   decision through the engine's approvals singleton; one without the other
   never posts; a denial is recorded and the wire stays cold.
3. **Self-disable beats silent retries.** Three consecutive failures park the
   adapter; callers get `adapter_disabled` with an enable-hint, not another
   doomed hop. A human `enable` resurrects after the world changed.

## 2026-10-19 (natt, fortsatt 2) — Del 9D + 10C
1. **Detection must be free when absent.** The injection defense annotates only
   on a hit; clean tool results stay byte-identical, so the bench holds parity
   without a token tax on honesty.
2. **Corpus lists justify every entry.** Each pattern maps to an observed
   override style; a positive corpus fixture regression-proofs catches, a
   negative corpus guards false positives.
3. **Environmental drift is named, never hidden.** Bench moved 24400→24399 this
   wave; branch-vs-main parity (identical bytes measured on both) proved the
   cause external — the report says so explicitly rather than silently.

*(Correction note: the 7B/7C and 7D entries above were re-committed after a
silent no-op docs edit was discovered — the earlier runs' code, tests and
matrix rows were unaffected; only these prose entries went missing briefly.)*
## 2026-10-19 (kväll) — Del 3E
1. **Concurrency is proven with timestamps, not claims.** Overlap-pairs from
   measured startedAt/endedAt intervals are the contract — if they collude,
   the benchmark lies; hence sabotage D2 zeroed them and the test went red.
2. **Interleaved replicates kill drift.** S,P,S,P interleave keeps go-slow
   gateway windows equally visible to both groups; a median of 3 is honest
   enough on a free gateway.
3. **Live evidence is recorded, live tests stay optional.** The numbers live
   permanently in docs/BENCHMARKS.md; the live test gate (MAJIN_LIVE=1) keeps
   CI deterministic while the reproduction command stays one line long.


## 2026-10-20 — Första runtime-beroendet: chokidar@4 (MIT, node>=14, pure JS)

Kontext: W5 event-flows needs kross-plattformskorrekt file-watching (fs.watch halter pa Windows: blodiga — batch, mtime-negativ timing, unicode sokvagar). Aggressivanalys: bygga sdett sjalv = bot-termouse wheel-reinvention motit partners user-order (re-use rather than rebuild). chokidar@4 har: erprovad Windows/UNC-stod, awaitWriteFinish (for Write-completed-event som matchar fil-dialoger), MIT, ingen native-build.

- [x] Sakerhet: pure JS, kaj som ingenva native-compilation pa installerare.
- [x] Bundle: majin.cjs esbuild badden proofed (chokidar i bundle ✓ 1053 KB byggs rent fran kallan, ingen behova extra paket).
- [x] Licens: MIT — licens-frihet kompatibilitet Bekraftad.
- [x] Alternative avvisade: fs.watch (felbuster), watch@legacy, gaze (maintenance).
