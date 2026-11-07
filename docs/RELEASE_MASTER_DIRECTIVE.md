# RELEASE_MASTER_DIRECTIVE — durable specification (GODLIKE V5)

**Provenance.** Reconstructed 2026-10-19 from the owner's "GODLIKE V5 | UNIFIED MASTER
DIRECTIVE" message (permanent CONTINUE directive) because this file did not previously
exist in the repo. Per directive §1.4: no unseen specifications are claimed preserved.
Where the V5 message references earlier requirement families (benchmarks A–G, 20
workflows, Imagination Engine), their detailed specifications live in the project's
existing documents — the acceptance matrix of record remains
`docs/COMPLETION_MATRIX.md`; decisions/continuity in `docs/DEV_CONTINUATION.json`;
performance evidence in `BENCHMARKS.md`; engine feature radar in `docs/FEATURE_RADAR.md`;
domain readiness in `docs/REAL_WORLD_READINESS.md`; prior handovers under `docs/`.

**Directive version:** V5 (received verbatim from the owner). This file is the durable
home of that specification. Its executable content is summarized faithfully below in
requirement form; the owner's message remains the source text.

## Mission
One user, one conversation, one objective. MAJIN independently coordinates intelligence,
tools and applications to deliver verified results. Not another chatbot — it must
actually finish tasks. Windows-first, model-agnostic, extensible.

## Non-negotiable policies (verbatim force)
- **FREE-ONLY / ZERO NEW SPENDING**: no paid inference, paid fallback, credits, trial
  charges, paid cloud GPU or account rotation — for workers, planners, tests and
  experiments alike. Unknown pricing is never proof of free access. A listed model is
  not automatically accessible.
- **Honesty of evidence**: no mocks, skipped tests, HTTP 200s, agent claims or green CI
  badges treated as universal proof. Exact SHA + environment + reproducible logs.
- **Data integrity**: no silent config/history write failures; no loss of
  conversations/settings/drafts after restart; no global provider changes corrupting
  other chats; no lost task plans or broken handoffs; no duplicate submissions after
  retry/timeout; correct screenshot regions; no dropped images; no plaintext secrets in
  config or backups; no unsafe migrations.
- **Aurora UI/UX identity is preserved** (elegant dark, subtle pink accent, circular
  Send/Stop, clean welcome, no debug spam, every visible control works). UI work is
  owned by the parallel UI agent branch; engine work must not fork UI files.
- **Credential handling**: approved secret storage only (`~/.secrets`, 700/600); never
  in commits; never rotate user credentials without permission.
- **Do not claim**: world-uniqueness, functioning updater from mocked dialogs, browser
  automation proving native desktop control (or vice versa), or speed targets that were
  never measured. The 30× acceleration target is an experiment, not an assumption.
- **Testing progression** (§9): static/unit → CLI/protocol → real browser journeys →
  live permitted model execution → Windows CI → native desktop → persistence/crash
  recovery → installer/updater e2e → realistic workflows → performance/regression.
- **Update/installer** (§10): clean install/start, preserved settings/credentials and
  conversations, verified stop/restart/relaunch, working EXE + installer, version
  metadata + integrity, real update discovery, verified download/install/relaunch,
  migration from a previously installed version, safe failure reporting. Disposable
  Windows environments only.
- **Completion contract** (§12): every mandatory requirement needs an acceptance
  criterion, status and supporting evidence; RELEASE_READY requires all mandatory
  requirements verified for the exact candidate SHA, no critical defects, genuine
  Windows install/upgrade evidence, valid release links, versioned checkpoint. Report
  X/Y verified requirements, never invented percentages.

## Requirement families (V5 §§2–8, engine-readable)
1. **Universal agent capability set** (§2): coding, research/browsing/verification,
   browser automation + real computer interaction, forms/files/workflows, business
   tasks, education, authorized job search, document/media/site production, multi-step
   planning, persistent memory + delegation + recovery, safe capability extension,
   self-improvement through tested software changes.
2. **Intelligence engine** (§3): direct fast-path for simple requests; adaptive
   decomposition; DAG planning + critical path; real parallelism; capability-aware
   model/tool/worker selection; account-wide rate limits + fair scheduling +
   backpressure; bounded queues/retries/timeouts/cancellation; delegation/aggregation/
   verification; read/write isolation; context compression + selective retrieval;
   versioned cache + selective re-execution; persistent tasks/checkpoints/handoffs;
   crash-safe recovery; idempotency + reconciliation of uncertain side effects;
   versioned, tested skills with rollback. Optimize VERIFIED RESULTS / TIME / COST /
   COMPUTE against a single-agent baseline.
3. **Models/providers catalog** (§4): real provider model IDs, search/sort, working
   FREE-only filtering, context/capability metadata, verified tool/vision support,
   unknown/unverified states, availability + accurate errors, per-chat routing without
   global corruption, streaming/cancellation/reconnect, persistent last-known-good
   catalog.
4. **Real computer & browser control** (§6): DOM interaction, screenshots delivered to
   vision-capable models, window identification + UI Automation where supported,
   mouse/keyboard with observable results, DPI/coordinate/multi-monitor handling where
   applicable, file selection/downloads/uploads, custom controls + multi-step forms,
   dynamic-control waits + recovery, active-control indicators + immediate Stop, clear
   approval boundaries. CRITICAL ACCEPTANCE TEST: a genuinely available permitted FREE
   model completes realistic unseen multi-step form workflows through the production
   agent loop — including a test-CV attachment, option selection, validation handling
   and a verified server-side submission receipt — in controlled fixtures with approval
   and cancellation tests; never real applications merely for evidence.
5. **Data integrity, memory, security** (§7): atomic persistence, recoverable journals,
   bounded context retrieval, secure Windows credential handling; permission
   boundaries, prompt-injection resistance, safe tool execution, auditability.
6. **Build vs reuse** (§8): evaluate maintained open-source options (Hermes, Pi,
   LangGraph, Temporal, LiteLLM, specialized tools) for real functionality, license,
   integration cost, security and maintenance before building infrastructure; reuse
   when justified; experiments end in measurable ADOPT/REJECT/DEFER.

## Coordination & process (V5 §§1, 9, 11, 13, 14)
- Every invocation: inspect repo state → checkpoint → highest-impact executable task →
  implement → test real behavior → fix → commit verified improvements → continue.
  After two identical failures: root cause + change approach. Preserve working code and
  user data.
- One active work branch + PR per agent at a time; merge only after acceptance gates;
  no competing pipelines, branches, versions or empty commits; report genuine
  limitations instead of pretending publication.
- Token/context discipline: no full-repo re-reads, no spec re-pasting, compact
  checkpoints, summarized logs with originals retained, deterministic scripts for
  repeats, cached research decisions, no redundant benchmark suites, no CI polling
  loops, no self-sent directives.
- Owner reports: only what was implemented/fixed, tests + verified outcomes, release
  acceptance X/Y, branch/SHA/PR/release links, genuine blockers, exact next task.
  Implementation and verification are always distinguished.

---
*This document preserves the V5 directive's operational requirements. It does not
modify previously accepted matrix rows; it registers them as mandatory where the V5
spec marks them so. Any further requirement edits must update this file and the
acceptance matrix in the same change.*
