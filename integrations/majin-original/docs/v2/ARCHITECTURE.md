# MAJIN V2 — RUNTIME ARCHITECTURE (PHASE 2 opening; bound to real code)

Status: first kernel component exists and is tested (src/v2/runtime/, 8/8 green).
This document names the kernel pieces and how they sit BESIDE V1, not on top of it.

## 1. Kernel (v2) vs runtime (v1)

```
                 +--------------------- V2 KERNEL (new, src/v2/) -------------------+
                 | goals.js   task-DAG      scheduler      receipts/states          |
                 | verifier(acceptance)      memory store   event bus                |
                 +-------------------------------|------------------------------------+
                                                 | event stream
+------------------------------- V1 RUNTIME (kept stable) ---------------------------+
| agent.js -> loop.js (tools, budgetGate, recovery) -> registry -> providers        |
| computer.js / wincontrol / pink-cursor / kokoro — real eyes, hands, voice         |
+-----------------------------------------------------------------------------------+
```

Principle (prompt section 177/178): stable kernel + replaceable capabilities.
V1 executor modules become *capabilities* the V2 kernel schedules and verifies.

## 2. What exists today (measured)

| Component | Path | State |
|---|---|---|
| Goal durable state machine (12 states per brief 3.4) | src/v2/runtime/states.js + goal.js | DONE, tested (legality, terminal lock, complete-gate on verified acceptance) |
| Receipts w/ tamper-evident hash chain (brief 183/184) | src/v2/runtime/receipts.js | DONE, tested (verify() replaces hash, keeps prevHash) |
| Goal persistence + crash resume | Goal.save/load/list | DONE, tested (resume RUNNING after disk-only load; terminal stays locked) |
| Executor (V1 loop) | src/core/loop.js | V1 kept; integration later behind MAJIN_V2_RUNTIME flag |
| Single-file artifact verification (V1 reusable) | src/core/goal-artifact.js | reused by kernel verifiers, NOT replaced |

## 3. Next kernel pieces (roadmap order)

1. Task DAG + scheduler (brief 21, 26): goals decompose into a persisted DAG;
   independent nodes run concurrently, dependents wait; budgets enforced.
2. Event bus (brief 29): in-process typed events feed Studio/UI (108).
3. Acceptance verifiers registry (brief 22): file/http/dom/pixel checks wired
   from acceptance items (@file, @http:url, @dom:selector...). Reuse
   src/core/goal-artifact.js for single-file goals.
4. Context engine (brief 27) + memory store (brief 8) on existing workspace DB.

## 4. Constraints honoured

- V2 runtime MUST NOT silently change V1 behaviour: kernel activation happens
  behind `MAJIN_V2_RUNTIME=1`; V1 default path stays byte-identical.
- Every kernel write is receipted; COMPLETED proof = verified receipts, not the model.
- All kernel code is model-independent (no provider calls inside src/v2/kernel).
