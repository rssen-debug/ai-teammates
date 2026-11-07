# MAJIN V5 — GRAND ARCHITECT: Handover & Verification Report

- **Version**: `5.0.0`
- **Branch**: `arena/0d83a123-majincli`
- **Base Commit SHA (`origin/main`)**: `e59794988795b97b40ec5a90d71e8d1fa71f0d69`
- **Protected Historical Baselines**:
  - V1 `main`: `e84b716e79ac4fc3cb443280e56d3f12553c8fc2`
  - V2 `v2/main`: `1ef253fb1f44406c262a290e170902403f68cceb`
  - V3 `v3/main`: `df678b21dfb784233da8cea25bdc54722a61236a`
  - V4 `origin/main`: `e59794988795b97b40ec5a90d71e8d1fa71f0d69` (plus unmerged `v4/main` fix commit `a5d7a99b59b0b7feac8152e65cffba6215428e0f`)

---

## 1. What Was Reused, Adapted, and Built

MAJIN V5 (`src/v5/`) is built as a clean, isolated layer that preserves V1–V4 untouched while reusing their verified engines through explicit adapters (`docs/v5/REUSE_MATRIX.md`, `src/v5/inventory.js`):

1. **Grand Architect Single Runtime (`src/v5/architect.js`)**:
   - Coordinates the full execution pipeline:
     `User goal -> Context & files -> Relevant skills (or autonomous Python/Node skill synthesis) -> Plan/DAG -> Tools -> Independent verification -> Result -> Learning & XP`.
   - Reuses V2 `Goal` (`src/v2/runtime/goal.js`), `STATES` (`src/v2/runtime/states.js`), `TaskGraph` (`src/v2/runtime/dag.js`), `runGraph` (`src/v2/runtime/scheduler.js`), and `runVerifier` (`src/v2/runtime/verifiers.js`).
   - Enforces a single source of truth (`goal-ledger.json`) tracking `goal_id`, `status`, `criteria`, `owner_instructions`, `checkpoints`, `used_skills`, `tool_results`, `verification_evidence`, and `cost`.
   - Strictly separates `COMPLETED` (`klart`), `PARTIAL` (`delvis klart`), `FAILED` (`misslyckat`), `BLOCKED` (`blockerat`), `CANCELLED` (`avbrutet`), and `WAITING_USER` (`väntar på användaren`). `COMPLETED` requires an independently verified outcome receipt — model prose alone never marks a goal `COMPLETED`.
   - Fences out late async callbacks from aborted/steered runs via monotonic `runEpoch`.

2. **Canonical Skill Tree & Autonomous Python/Node SkillBuilder (`src/v5/skill-tree.js`, `src/v5/skill-builder.js`, `docs/v5/SKILL_REGISTRY.json`)**:
   - Separates `Tool`, `Skill`, `Domain`, and `Workflow` under schema `majin.v5.skill-registry/v1`.
   - Every built-in and newly synthesized skill starts **untrained at Level 1 (`0 XP`, `UNTRAINED`)** — existing code never automatically grants a high level.
   - Deduplicates candidate skills via intent normalization, alias lookup, and tool/verifier contract comparison (`resolveOrRegisterSkill`), and supports safe merges (`proposeMerge` / `mergeSkills`) that preserve aliases and history without double-counting shared receipts.
   - Enforces cycle-free dependency DAGs (`assertAcyclicDependencies`) and marks skills `STALE` when the environment fingerprint or target origin changes without erasing historical XP/level.
   - **Self-Building Skills (`SkillBuilder`)**: When Majin lacks a skill for a task, it synthesizes a Python 3 or Node.js skill (`SKILL.md` + `skill.json` + `scripts/runner.py` or `runner.mjs`), validates code safety (`validateSynthesizedCode`), runs a scrubbed-environment sandbox self-test, independently verifies the output artifact with V2 `runVerifier('file')`, and registers the skill into `SkillTree` without modifying `src/`.

3. **RuneScape-Inspired XP & Level 1–99 Engine (`src/v5/xp-engine.js`, `docs/v5/XP_RULES.md`)**:
   - Implements deterministic progression (`majin.v5.xp-curve/v1`) from Level 1 (`0 XP`) to Level 99 (`XP_TABLE[99]`).
   - Awards XP **only** for independently verified outcome receipts (`isVerifiedOutcomeReceipt`), idempotent per unique `receiptId` across parallel writes and restarts (`XpLedger` with lockfile + append-only `xp-ledger.jsonl`).
   - Enforces steep diminishing returns for repeated identical task signatures (`variationMultiplier`: `1.0 -> 0.5 -> 0.25 -> 0.0`) and a bounded per-task XP budget (`MAX_TASK_XP_BUDGET = 60`) split between `primarySkill` (75%) and `supportSkills` (25%).
   - Caps effective level at **98** until all **5 Level 99 quality gates** pass (`versionedTestSuite`, `variedTasks >= 5`, `errorRecovery >= 2`, `freshEvidence` with reliability >= 0.90, and `definedScope`).

4. **Black Box UI & 99-Dot Matrix (`src/v5/ui/*`, `src/v5/server.js`, `docs/v5/screenshots/*.png`)**:
   - Near-black `#050508` background, existing Majin logo (`/logo.png` -> `assets/majin-transparent.png`), centered single column, unified input composer (text, opt-in voice, file drag-and-drop/attach), discreet provider/model selector pill, and inline result cards.
   - 99-dot matrix (`computeDotMatrixState` & `createDotMatrixCanvas` in `src/v5/ui/dot-matrix.js`) rendering 3 concentric rings of 33 dots (`99` total) around the Majin logo plus a 99-dot progress bar, lighting up `1..level` in green (`#22c55e`), activating a cohesive emerald mastery ring at `99/99`, and displaying numeric level + text status + discreet ticker (`"Formulär 18/99 · +24 XP"`).
   - Skill Tree drawer (`#skill-tree-drawer`) is **closed (`hidden`) by default** and opens when clicking the Majin logo or skill button.
   - Visually separates working activity (`data-activity="working"` with concrete Swedish status labels like `"Läser CV"`, `"Kontrollerar matchningar"`, `"Laddar upp CV"`, `"Bekräftar mottagen ansökan"`) from verified learning (`data-learning="verified"`).

5. **Provider Manager, Streaming Files, Owner Mode, 500-Job Workflow, Learning Engine, Voice & Ops**:
   - `src/v5/providers.js`: Reuses `src/core/provider/catalog.js` and `chat.js`, first-class OpenCode Go (`User-Agent: majin-v5/5.0.0`, `x-opencode-session`), manual model ID fallback, persistence across restarts, strict separation of `savedConfig` vs `connectionVerified`, and error classification.
   - `src/v5/files-access.js`: Reuses `UploadStore`, `extractText`, `OwnerMode`, and `checkPath`, adds configurable 25 MB limit + streaming uploads (`saveStreamUpload` > 6 MB), verified external portal uploads (`uploadToPortal`), instant revocation/emergency stop, OS Administrator separation, and untrusted prompt-injection escalation guard.
   - `src/v5/workflows/job-search.js`: Composes `documents.read`, `research.search`, `career.job-match`, `browser.forms`, and `documents.upload` for the 500-job search & application workflow with zero-fabrication CV fact extraction, multi-portal deduplication, required vs preferred skill matching, 8 counters (`found`, `unique`, `matched`, `prepared`, `submitted`, `confirmed`, `blocked`, `failed`), independent confirmation receipt verification beyond clicking Submit, crash-safe idempotent `submissionLedger`, CAPTCHA/MFA/MISSING_INFO blockers, and mid-flight steering (`"Nej vänta, bara jobb i Köpenhamn"`, `"Öppna de fyra bästa"`).
   - `src/v5/learning-engine.js`: Parameterizes procedures (`{{file_path}}`, `{{search_query}}`), sanitizes secrets and PII (`learned-procedures.json`), intersects permissions, attributes failures to the specific step + argument fingerprint without blocking whole tools for bad arguments, and separates procedural learning, user memory, verification history, and `modelTraining.weightsTrained = false`.

---

## 2. External Research Summary (`docs/v5/RESEARCH_DECISIONS.md`)

- **Chosen Single Runtime**: MAJIN V5 `GrandArchitect` over V2 `Goal`/`TaskGraph`/`runVerifier` + V4 tool host & learning lifecycle. Competing external agent loops are **not** stacked.
- **Evaluated External Sources**:
  1. `NousResearch/hermes-agent` (`930e5ed557edb25b4b0b8ca3f51679dde3c92eb6`, MIT) — adopted closed-loop skill synthesis & trajectory sanitization patterns.
  2. `deepseek-ai/deepseek-harness` (`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`, MIT) — adopted capability seams & twin LLM adapter concepts.
  3. OpenCode Go (`https://opencode.ai/docs/go/`) — integrated headers (`User-Agent: majin-v5/5.0.0`, `x-opencode-session`) and live/manual model selection.
  4. Agent Skills (`https://agentskills.io/`) — adopted `SKILL.md` frontmatter and 3-stage progressive disclosure (`discovery -> activation -> execution`).
  5. Grok Bot UX (`https://docs.x.ai/grok-bot/*`) — adopted single unified composer, inline previews, and mid-flight steering.

---

## 3. Verification Commands & Proof Artifacts

All checks and tests run cleanly with 0 failures and 0 skipped tests:

```bash
# 1. Run all 20 V5 unit, integration, workflow, UI and server tests
node --test test/v5/*.test.js

# 2. Run the 7 end-to-end V5 acceptance flows + screenshot renderer + package manifest builder
node scripts/v5/accept.mjs

# 3. Verify all 732 JS/MJS/CJS files in the repository parse cleanly
npm run check

# 4. Verify zero unlocalized Swedish string literals in non-localization files
npm run i18n
```

### Generated Deliverables in `docs/v5/`

- `docs/v5/REUSE_MATRIX.md` — Capability-by-capability reuse matrix across V1–V4, branches, and external sources.
- `docs/v5/RESEARCH_DECISIONS.md` — External research evaluation (commit SHAs, licenses, pros/cons, rollback, single-runtime decision).
- `docs/v5/XP_RULES.md` — Level 1–99 XP curve (`majin.v5.xp-curve/v1`), anti-farming rules, budget cap, and 5 Level 99 quality gates.
- `docs/v5/SKILL_REGISTRY.json` — Versioned canonical skill registry (`majin.v5.skill-registry/v1`).
- `docs/v5/ACCEPTANCE_MATRIX.json` — Machine-readable acceptance matrix (`7/7` flows passed, `4/4` screenshots pixel-verified).
- `docs/v5/build-manifest.json` & `scripts/v5/install-majin-v5-windows.ps1` — Reproducible build manifest with SHA-256 hashes and Windows 11 installer/rollback script.
- `docs/v5/windows-desktop-smoke.json` & `docs/v5/windows-installer-evidence.json` — Real Windows (`windows-latest`) verification receipts for the packaged `MAJIN V5.exe` Electron application and the `MAJIN-V5-Setup.exe` NSIS installer.
- `docs/v5/screenshots/` — Pixel-verified PNG screenshots (`v5-blackbox-home-level18.png`, `v5-skill-tree-open.png`, `v5-mastery-level99.png`, `v5-mobile-view.png`).

---

## 4. Windows Electron Desktop Application & `MAJIN-V5-Setup.exe`

The Electron application in `desktop/` is integrated with MAJIN V5 (`5.0.0`) and verified end-to-end on Windows (`windows-latest`):

1. **Automatic Local V5 Host & Native Black Box Window (`desktop/main.cjs`, `desktop/policy.cjs`, `scripts/v5/desktop-host.mjs`)**:
   - Launches `scripts/v5/desktop-host.mjs` automatically when `MAJIN V5.exe` starts (using the bundled `resources\host\runtime\node.exe` in packaged Windows builds, requiring no system Node.js installation).
   - Verifies `/api/v5/state` and `/api/health` (`app: 'majin-v5'`, `version: '5.0.0'`), renders the V5 Black Box UI (`#07080a`, 99-dot matrix, Majin icon) inside its own native `BrowserWindow` (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`), and falls back to `desktop/offline.html` while the host boots.
2. **Majin Icon, Desktop Shortcut & NSIS `MAJIN-V5-Setup.exe` (`desktop/stage-host.mjs`, `desktop/package.json`)**:
   - Generates `desktop/stage/icon.ico` and `icon.png` directly from `assets/majin.png` (the Majin M emblem) and copies `assets/` into `resources/host/assets/` so `/logo.png` (`assets/majin-transparent.png`) is served locally.
   - Builds `MAJIN-V5-Setup.exe` (one-click/silent per-user NSIS installer, `appId: com.majin.v5`, `productName: MAJIN V5`, no administrator elevation required) with Desktop (`MAJIN V5.lnk`) and Start Menu shortcuts and `deleteAppDataOnUninstall: false`.
3. **Persistence Across Restarts & V1–V4 Coexistence (`src/v5/providers.js`, `src/v5/architect.js`)**:
   - Stores V5 desktop state in `%LOCALAPPDATA%\MAJIN\v5` (`provider-state.json`, `goal-ledger.json`, `xp-ledger.jsonl`, `desktop-window.json`) without modifying `%LOCALAPPDATA%\MAJIN\config.json` (V1) or `%LOCALAPPDATA%\MAJIN\v4` / `%LOCALAPPDATA%\Programs\majin-v4-desktop` (V4).
   - Non-destructively seeds initial V5 provider configuration from existing V1/V4 config on first boot and preserves provider/model selection and goal history across restarts and updates.
4. **Verified on Windows (`docs/v5/windows-desktop-smoke.json` & `docs/v5/windows-installer-evidence.json`)**:
   - `scripts/v5/desktop-smoke.mjs` (`status: "PASS"`): Launched packaged `MAJIN V5.exe` via Playwright `_electron`, verified automatic V5 host startup, `/api/health` (`5.0.0`), 99-dot matrix rendering, renderer security flags, provider persistence (`opencode-go` / `Kimi K3.1 Pro`) and goal history persistence across full process restart, and V4 data preservation.
   - `scripts/v5/desktop-installer-verify.ps1` (`status: "PASS"`): Executed `MAJIN-V5-Setup.exe /S`, verified `%LOCALAPPDATA%\Programs\majin-v5-desktop\MAJIN V5.exe`, bundled Majin icon, bundled `node.exe`, Desktop & Start Menu `.lnk` shortcuts, background host startup and provider persistence (`opencode-go` / `GLM-5.3`) across restart, clean uninstallation via `Uninstall MAJIN V5.exe /S`, and preservation of V1, V4, and V5 user data.

---

## 5. Honest Environment Boundaries

In accordance with Section 13 ("Var ärlig med vad som faktiskt är testat i denna miljö och vad som inte kunde verifieras här"):
- **Verified in this Linux container (`Node v22.22.3`, `Python 3.11.2`)**:
  - All 20 V5 unit/integration tests and all 7 acceptance flows (`CV extraction`, `portal upload`, `500-job deduplication/matching/confirmation/crash-recovery`, `page build`, `autonomous Python 3 skill synthesis & self-test`, `local file repair under Owner Mode`, `mid-flight steering & mobile-to-host remote execution`).
  - Deterministic HTTP transport contracts for OpenCode Go (`User-Agent`, `x-opencode-session`, catalog discovery, manual model ID fallback, error classification).
  - Reproducible Windows 11 PowerShell installer script (`scripts/v5/install-majin-v5-windows.ps1`) and SHA-256 package manifest (`docs/v5/build-manifest.json`).
- **Requires external credentials or physical hardware outside this container**:
  - **Live external LLM API call in this sandbox**: No live `OPENCODE_API_KEY` / `OPENAI_API_KEY` is injected into the sandbox environment (outbound network is restricted to GitHub/npm/PyPI); live `opencode-go/glm-5.3-flash` execution was previously verified in the V4 A–H gate (`docs/v4/HANDOVER_NOW_20261024.md`) and will verify live as soon as an owner API key is saved in `/api/v5/provider`.
  - **Physical Windows 11 GUI session**: Win32 UI Automation window clicking (`desktop.*`) requires running on a physical Windows 11 desktop session.
  - **Physical acoustic hardware**: Echo cancellation, TV-noise rejection, and speaker biometric identification are explicitly marked unverified (`false`) in `VoiceController.describeStatus()` until tested on physical audio hardware.
