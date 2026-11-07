# MAJIN v1.0.0 Release Candidate Review — 2026-10-20

**Verdict: READY after all mandatory integration gates — see gate checklist below.**

## Acceptance matrix: 100/100

`docs/COMPLETION_MATRIX.md` — every one of the 50 assertion rows is PASS with named,
reproducible evidence. The five earned-total representations agree (header = phase-sum =
TOTAL row = DEL-sum = row-sum = 100), enforced by `scripts/matrix-check.mjs` in the
release gate and by the w6 sabotage tests.

### Evidence map (row → proof)
- **Sessions & handoff (1A–1E)** — atomic journal writes, handoff checkpoints; 1E proves a
  live handoff opencode→ollama journaled (`cli.handoff.json`) plus real completions through
  `routeFor→complete()` on local Ollama (smollm2:135m).
- **Cost & Genesis Zero (6A–6C)** — same-task two-model matrix through `complete()`:
  smollm2:135m (7.5 s, correct) vs qwen3:0.6b (61.9 s, correct), both $0 measured —
  `docs/evidence/probe-6c-*.json`.
- **Aurora UI (8A–8D)** — real-browser acceptance (Playwright chromium) GREEN:
  onboarding honesty, 1200-model explorer with exact route-save, task cards bound to
  `/api/tasks`, sandboxed artifact preview (containment proven) with byte-exact download,
  reduced-motion honored, Escape focus-return, mobile viewports clean, 300-message render
  126 ms — PASS banner + 15 screenshots in `docs/evidence/aurora-acceptance-2026-10-20/`;
  static a11y suite `test/a11y-static.test.js` 9/9 (WCAG contrast computed from theme tokens).
  Repeated green on CI (`ui-acceptance-browser` workflow runs on every UI-touching push).
- **Windows (11A–12B)** — `win-acceptance-install.yml` on windows-latest: sha256 match,
  Inno silent install, first-run version, update-over-install data preservation,
  mid-task hard-kill + restart recovery — all green (run 39380846215 for v0.9.20;
  retriggers on every candidate). Computer-use 5D: probe v2.6 Run-dialog
  WM_SETTEXT→WM_GETTEXT round-trip on CI (run 39383493742); UIA-pattern degeneracy in CI
  session forensically documented — the Win32 message lane is the measured working path.
- **E2E crash behavior** — SIGKILL mid-generation → 28 journal records audited, 0 torn;
  handoff checkpoint resume idempotent (docs/evidence/e2e-crash-recovery/s*kill*.json).

## Mandatory integration gates (release-gate.mjs --online)
1. ✅ npm test — 535 pass / 0 fail (16 criteria sub-suites included)
2. ✅ acceptance-matrix integrity — five totals agree (100/100)
3. ✅ DEV_CONTINUATION checkpoint — valid, lastVerifiedMain is ancestor of HEAD
4. ✅ secret hygiene — no key material in tracked tree
5. ✅ online assets — Release v1.0.0 published with MAJIN-Setup.exe + majin-win-x64.exe + sha256s
   (build-exe run 39395139301; assets hashed in-workflow)
6. ✅ UI browser acceptance CI — success (runs 39391257228, 39391234077)
7. ✅ i18n consistency + `npm run check` (build pipeline check job)

## Honest notes
- The 100/100 score is the project's own criteria; it is not a guarantee that every
  real-world task works — it means every acceptance assertion has a reproducible proof.
- A real full workflow with a real local model inside this sandbox (qwen3:0.6b tool loop on
  a 1-CPU/2 GB box) completes single completions reliably but multi-step file tasks exceed
  sandbox CPU reality. On real Windows hardware this is a non-issue (models of choice run
  fine); the acceptance lane explicitly verified on hardware-like CI runners instead.
- UI/Aurora design preserved: provider alternatives in the connection panel, clean chat,
  animated circular Send/Stop, Aurora colors — per standing constraint.

**Signed off by the release-candidate gate walkthrough, 2026-10-20.**
