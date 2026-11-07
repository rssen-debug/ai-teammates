# W4 Standing Agent Teams — absorb evidence + implementation proof (2026-10-21)

## Reuse research (user directive: "finns det redan färdiga github repos, ta delar — inte uppfina hjulet")

Real scans via MAJIN's own absorb engine (`majin absorb`, shallow clone + static analyze, nothing executed):

| Repo | Files | License | Heat (measured) | Takeaway used |
|---|---|---|---|---|
| openai/swarm | 278 | MIT (low risk) | agents=29, tools=20, memory=5, tests=19 | **Source-verified** (`swarm/types.py`, `examples/triage_agent/agents.py`): (1) Agent = stable entity `name + instructions + functions` → became MAJIN roster members `{id, role, instructions, tools, maxSteps}` persisted in `workspace/teams/<team>/roster.json`; (2) `Result.context_variables` shared across turns → became the **blackboard** (`memory.jsonl`, append-only, `team.manage note/board`); (3) handoff=control-transfer→ goal→member ownership. |
| crewaiinc/crewai | 4000 | unknown to scanner | agents=0, memory=0 | **Scanner limitation honestly flagged**: the keyword-heat detector found nothing in crewAI's current layout — a measured scanner gap, recorded here instead of silently skipped. Not used. |

Design rule kept: **patterns absorbed, execution NOT copied.** W4 runs on the repo's own already-verified executor (`runSwarm` + `subagentWorker` in `src/core/swarm.js` — untouched this round).

## What was INCOMPLETE → what now exists (each with a test)

| W4 requirement (STATUS.md) | Implementation | Proof (test) |
|---|---|---|
| persistent identity | `TeamStore` roster upsert by stable `member.id`; `addedAt` inherited across updates; files survive "new process" | `roster persists across reopen; addMember upsert håller stabilt addedAt` |
| shared memory | blackboard `memory.jsonl`: note/board/key-filter; bounded `digest()` injected as subagent memory-shim; corrupt line never hides the rest | `blackboard append, key-filter, bounded digest…` |
| budgets | per-member `maxSteps` (roster) + global `teamStepCap` in `runTeam`; overrun throws `TeamBudgetError` LOUDLY — the failed node keeps `ok:false`, completed nodes keep results, checkpoint says `partial` | `budget: överträdelse är HÖGLJUDD…` |
| checkpoint | `runs/<runId>/checkpoint.json` written **before** runSwarm learns of completion (atomic tmp+rename) | `goals → runSwarm-graf, checkpoints skrivs löpande…` |
| recovery | `resumeId`: completed nodes return stored values and **never re-execute** (counter-proof: g1 worker invocations = 0 on resume), crash-before-save ⇒ at-least-once (same guarantee W7 measured) | `resume efter krasch kör ALDRIG om klar nod (exactly-once, counter-proof)` |

Tool surface: `team.manage` (create/list/status/add/remove/note/board) + `team.run` (goals JSON, cap, teamStepCap, runId, **resumeRunId**) — registered: 133 → 135 tools (counter asserts bumped consciously, same ceremony as ma.learn et al.).

## Numbers
- `node --test test/teams.test.js` → **9/9 pass**
- Full `npm test` → **760 pass / 0 fail / 17 skip** (was 742 before this round)
- i18n gate fixed within the round: 12 Swedish error literals → English (comments/docblocks may be Swedish; shipped strings may not — suite-enforced).

## What remains for full W4 parity (honest)
- Live multi-member runs against a REAL provider (cred-gated — same external block as W2/W8 live checks; the honest-fail path is tested: `team.run` without a provider returns ok:false + checkpoint, never a fake success).
- crewAI-style long/short/entity memory classes — current blackboard is single-stream; hierarchical memory can layer on top without breaking the store.
