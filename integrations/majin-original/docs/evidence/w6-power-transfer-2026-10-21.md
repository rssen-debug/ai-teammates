# W6 Power Transfer — DISCOVER → APPROVE → INSTALL, verifierat mot RIKTIG uppströmsrepo (2026-10-21)

## Real end-to-end (mätt denna runda, aldrig fixtur-påstående)
```
absorb openai/swarm                  → 278 files, license MIT (W1 engine runs the discovery)
power.propose  triage_agent/agents.py→ planHash 3abbfa82573f5964, risk=low, candidates: triage-agent, sales-agent, refunds-agent
power.approve  (human gesture)      → ledger event
power.apply                          → installed 3 member(s) into "helpdesk-demo" (verified by roster read-back)
ROSTER READ-BACK                     → triage-agent, sales-agent, refunds-agent
PROVENANCE SAMPLE                    → [origin: openai/swarm, license: MIT, pattern: openai/swarm, file: …/triage_agent/agents.py]
BOARD NOTES (audit trail)            → 3
```
The upstream definitions arrived as MAJIN team members — with origin+license engraved in every member's instructions and a blackboard note per transfer. Zero upstream code was executed anywhere on this machine; only definitions moved.

## Pipeline contract (the absorb report's own caution made real)
| Stage | Guarantee | Enforced by |
|---|---|---|
| DISCOVER | extraction reads upstream source as DATA (swarm `Agent()` literals, crewAI `agents.yaml`); unparsable chunks are counted `skipped` never guessed | `extractSwarmAgents` / `extractCrewaiAgents` |
| PROPOSE | deterministic planHash; validated/normalized member ids; duplicate-ID refusal; license-risk mapping (low/copyleft/unknown) | `transferPlan` |
| APPROVE | human gesture is a separate ledgared event; copyleft/unknown REQUIRES `acceptCopyleftRisk=true` | `approvePlan` + ledger.jsonl append-only |
| INSTALL | **refuses without approval with the exact missing step**; idempotent upserts (re-apply marks `updated`, roster never double-counts) | `applyPlan` |
| VERIFY | roster is re-read; a claimed-but-unreadable transfer throws `verify_failed` | post-verify inside `applyPlan` |

## Reuse honored
Built entirely on pre-verified wheels: absorb() (W1) for discovery, TeamStore (W4) for installation target, js-yaml (declared dep) for crewAI parsing, the ledger shape from existing jsonl stores. New file count this round: power-transfer.js + tools/power.js + test.

## Numbers
- `test/power-transfer.test.js` **6/6** (both extractors, plan invariants, gateflow with idempotent re-apply, copyleft gate, tool surface incl. honest error paths: bad pattern, no propose event, invalid JSON)
- Full `npm test`: **802 pass / 0 fail / 17 skip** (787 before round)
- Tools: 135 → **138** (power.propose/approve/apply — counter asserts bumped consciously, same ceremony)

## Remaining honest scope
- Additional source patterns (AutoGen config, LangGraph graphs) plug in as new extractors — the pipeline shape is pattern-agnostic.
- Transferring executable integrations (npm packages) stays a deliberate NON-goal: install of code is a different trust class than install of definitions; if ever built it needs a separate approval class. Current boundary stated in module comments.
