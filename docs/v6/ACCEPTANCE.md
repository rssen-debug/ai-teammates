# V6 acceptance evidence

Environment: Linux sandbox, Node `v22.22.3`, repository commit
`ea439ec` + this branch. No Windows host, OpenCode binary, OpenCode config,
V5 user profile, Gmail account or GitHub sync token was available.

Reproduce:

```bash
npm run v6:test          # 48 tests, 0 fail (2.5 s)
npm test                 # 1457 pass, 0 fail, 19 skipped (162 s)
node scripts/parse-all.js  # 823/823 files parse cleanly
node scripts/release-gate.mjs  # local checks GREEN
```

Statuses are used as defined: **PASS** has executed evidence here; **FAIL** is a
known defect; **BLOCKED** needs a missing permission/environment; **NOT_IMPLEMENTED**
is absent by design or scope; **NOT_TESTED** means no evidence either way.

## Requirement-by-requirement

| # | Requirement | Status | Evidence or reason |
| --- | --- | --- | --- |
| 0 | Do not damage the working version | **PASS (local)** / **NOT_TESTED (Windows)** | Work is on `arena/abdefe02-majincli`; pre-change tag and bundle created; V6 refuses to share the V5 data directory; no OpenCode config or binary was touched. `C:\MAJINCLI` was not accessible. |
| 1 | OpenCode is the only interactive UI; no second model runtime | **PASS** | No provider code added; the bridge reuses `CodexDriver`; `majin_status` reports `provider: OpenCode retains its existing model`. |
| 2 | Complete V1–V5 inventory | **PASS (calculated)** | `majin-v6 inventory --deep --history --write`; 157 V1 entries, 97 real driver adapters, 93 available today, 64 unavailable with reasons, 176 historical unique declarations (lower bound). See `docs/v6/TOOL_INVENTORY.md`. |
| 3 | Direct OpenCode tool integration | **PASS** | Real MCP stdio session executed `fs_read` through the actual V5 driver, returned a persisted receipt, rejected mismatched `operationId`, and denied an ungranted lane (`test/v6/mcp-live.test.js`). Search/schema/call, pagination, progress and cancellation covered by `test/v6/mcp.test.js`. |
| 4 | Always-on bounded work engine | **PASS** | Durable queue + supervisor + heartbeat + watchdog + budgets; queue continues through independent tasks, isolates blockers and refuses uncertain retries (`test/v6/supervisor.test.js`, `test/v6/queue.test.js`). Detached start via MCP is bounded; real worker CLI executes tools (`test/v6/worker-live.test.js`). |
| 5 | Parallel work without corruption | **PASS (queue level)** | Two supervisors over one queue completed 6 tasks exactly once; effect ownership prevents simultaneous irreversible work. Browser-context isolation **NOT_TESTED** (no browser here). |
| 6 | Job hunter end to end | **PASS (discovery→approval→receipt→email)**, **NOT_IMPLEMENTED (portal automation)** | Candidate separation, exclusions (incl. Atea/Gigstep/Poolia), canonical-URL dedupe, CV scoring, state machine, evidence rules and receipt persistence tested. No adapter clicks/submits on an employer site; `job.submit` returns a blocking diagnostic. |
| 7 | Gmail integration | **PASS (client + classifier, fixtures)**; live **BLOCKED** | OAuth2 refresh-token client is read-only, refuses unsafe file permissions, types auth failures, masks accounts, never follows links. Marketing/verification/confirmation classification and matching tested with fixtures. No real mailbox was authorized here. |
| 8 | Observability and private debugger | **PASS (local)**; live GitHub upload **BLOCKED** | JSONL events, real status report, worker health, watchdog and test-backed activity lines. Private sync uses the REST API (no `gh`), verifies `private: true` before every upload and refuses private payloads. No token/repo access here. |
| 9 | Memory, skills and learning | **NOT_IMPLEMENTED** | V6 does not migrate or unify V1–V5 memory. The existing V5 memory/procedure surfaces are untouched; no new memory store was invented. |
| 10 | Self-repair and tool extension | **NOT_IMPLEMENTED** | Only the safety boundary and handover guidance exist. No automatic code generation or self-modification was added. |
| 11 | OpenCode experience | **PASS (server side)**; OpenCode UI **NOT_TESTED** | Native MCP tools, lazy search/schema discovery, commands documented in `docs/v6/OPERATIONS.md`. No OpenCode binary was available to verify end-to-end prompts, themes or session history. |
| 12 | Real testing, no false success | **PASS (Linux)**; Windows/Gmail/job portal **NOT_TESTED / BLOCKED** | 48 V6 tests include real subprocess MCP/worker runs; full repo suite green. No Windows acceptance was possible. |
| 13 | Work autonomously through the session | **PASS (this session)** | Implementation, tests, fixes, inventory generation, launcher, docs and checks were executed without asking for "continue". Durable backlog maintained. |
| 14 | Deliverables 1–16 | **PARTIAL** | See table below. |
| 15 | Definition of done | **NOT MET** | Several required end-to-end proofs (OpenCode+DeepSeek live, real Gmail, real receipts, Windows acceptance) are absent. No readiness percentage is claimed. |

## Deliverables

| Deliverable | Status | Note |
| --- | --- | --- |
| Frozen reference | **PASS** | Tag `v6-reference-checkout-ea439ec-20261027` + `.majin-v6-safety/pre-v6.bundle`; labelled "known-working NOT VERIFIED" |
| Isolated V6 branch | **PASS** | `arena/abdefe02-majincli`; V6 state separated from V5 |
| Tool inventory | **PASS** | Generated Markdown + JSON, deep + historical |
| Unified MCP integration | **PASS** | 11 MCP tools, dynamic catalog, exact schemas, persisted operation IDs |
| Durable supervisor and queue | **PASS** | Leases, dependencies, retries, budgets, effect ledger |
| Heartbeat and stall diagnostics | **PASS** | Worker heartbeat files + watchdog events + status health |
| Safe continuation and recovery | **PASS** | Auto-dispatch of eligible work; lease recovery; uncertain isolation |
| Multi-worker orchestration | **PASS (queue)** | Bounded concurrency; no browser-context management yet |
| Job Hunter integration | **PARTIAL** | Pipeline and evidence real; portal submission adapter absent |
| Authorized Gmail verification | **PARTIAL** | Read-only client implemented/tested with fixtures; live access blocked |
| Structured debug observer | **PASS** | JSONL events + status CLI |
| Private sync without `gh` | **PASS (dry-run/mocks)**; live blocked | Private check + privacy gate tested |
| Preserved/migrated skills and memory | **NOT_IMPLEMENTED** | Existing data untouched, no migration |
| Automated tests and Windows acceptance | **PARTIAL** | Tests PASS; Windows acceptance absent |
| Single safe PowerShell launch | **PASS (static)**; execution NOT_TESTED | `start-v6.ps1` + opt-in registration with backup |
| Complete handover | **PASS** | `HANDOVER.md`, `OPERATIONS.md`, `PRIVATE_TELEMETRY.md`, this file |

## What a "PASS" here does not mean

- A green test does not prove a live Gmail account, OpenCode+DeepSeek session or
  employer portal works.
- A registered tool is not a working integration; availability reasons are in
  the generated inventory.
- No application was submitted anywhere. No real Gmail message was read in this
  environment. No telemetry was uploaded.
