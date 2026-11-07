# MAJIN Desktop — UI/UX repair master brief (2026-10-20)

> **Status:** Implementation specification / acceptance contract, NOT a claim of completed implementation. Source: owner screenshots dated 2026-10-20, current `src/ui/index.html` and `src/ui/app.js`. Keep this document in the repo as the single acceptance checklist for Astra and independent QA.

## Owner's non-negotiable complaints

1. **Cannot archive or delete chats.** Provide visible and functional controls, including confirmation for permanent deletion.
2. **Chats are not ordered by recent activity.** The conversation the user just sent a message in must move to the top immediately, persist through reload/restart, and stay first after the server acknowledges the message.
3. **Two top headers.** The native window title bar and a separate heavy web-app header look like two unrelated apps. Produce one coherent desktop-app chrome and consistent sidebar/content top alignment. Keep necessary native window controls and accessibility.
4. **Overall UI looks unfinished.** Prioritize calm premium density, legible typography, clean controls, consistent spacing, meaningful empty/loading/error states. Do not merely recolor existing controls.
5. **Existing product behaviors must continue working:** OpenCode Go (not Zen) / GLM selection and persistence, chat send/stream/stop, model search and free filter, settings persistence, onboarding, file/task panels, workspace, keyboard shortcuts.

## Screenshot observations (owner supplied)

- Narrow dark sidebar: `New chat`, `Search chats`, `RECENT`, `General`, `Hi. What do you need?`; no visible archive/delete actions.
- Full app: Windows-native black title bar `MAJIN · agent`, followed by a separate MAJIN/logo/model/workspace/settings/hamburger top bar. A URL appears across the content near the top. The combined chrome feels disconnected.
- This is a visual report, not proof that a particular API endpoint is missing; inspect backend before implementation.

## Required UX behavior

### A. Conversation list

- Each conversation has a **stable ID**, editable title, `createdAt`, `updatedAt` / `lastActivityAt`, and `archivedAt` or equivalent durable status.
- Sort active conversations by descending last meaningful activity, with a deterministic ID tie-breaker. Sending a message in an older chat moves it to the first row **immediately** (optimistic UI); reconcile with server response without flicker.
- Keep order after reload, process restart, window close/reopen, and two windows/sessions. Avoid using only in-memory arrays or browser localStorage as source of truth.
- New empty chats can be first while active; don't persist phantom/blank chats indefinitely. Give each chat a sensible fallback title, and title from content only with an explicit, deterministic policy.
- Each row: title, active state, hover/focus-visible ellipsis action; context menu **Rename / Archive / Delete**. Mobile/narrow layouts must offer equivalent accessible action.
- **Archive** hides from Recent without deleting messages. Provide an **Archived** view, restore action, and search that distinguishes active vs archived. Archive is reversible.
- **Delete** must require an explicit confirmation with the chat title. Delete removes the session and history using a documented backend operation, never merely removes the row. Ensure deleted chats cannot resurrect after refresh or from stale caches. Specify and test file/attachment handling; never silently delete unrelated workspace files.
- If the selected chat is archived/deleted, switch to a safe active chat or a clear empty state; don't leave an invalid session ID or stream into a deleted chat.
- If an API operation fails, roll back optimistic state and show a clear retryable error. Never show success on failure.
- Search chats across title and supported message content; ensure sorting and active/archived filters behave correctly.
- Keyboard: Ctrl+N new chat, Escape dismiss menu/dialog, keyboard navigation for actions; focus returns to the triggering row on cancel. Accessible names for all icon buttons.

### B. One coherent desktop header

- Inspect Electron/native wrapper and embedded page chrome first. **Do not hide Windows close/minimize/maximize buttons**, break dragging, or create a frameless inaccessible window.
- Prefer a unified visual titlebar/appbar with sidebar and content sharing the same vertical origin; native title bar can remain if integrated cleanly. Avoid a second heavy banner immediately below it.
- Put brand and current model in a compact consistent area; group workspace/settings/window controls logically. No redundant menu icons.
- Model picker should clearly show `OpenCode Go · GLM` when selected (not ambiguous `glm-5.3` alone), persist provider+model across app restart, and never silently switch to Zen.
- URLs and technical debug text must not float as unstyled content at the top of the chat view. User-supplied URLs should render as part of the message content.
- Align sidebar search/new-chat/recent with chat content; preserve resizable sidebar and readable small-screen layout. Remove gratuitous borders and stacked bars, not useful functions.
- Match polished desktop interactions: hover, selected, loading, empty, error, keyboard focus, tooltips, and reduced-motion behavior. Avoid fake progress indicators.

### C. Real functionality and truthful state

- API, UI and durable storage must agree. Audit existing `/history`, `/session/clear`, chat session persistence, SSE streaming, and task state. Implement missing server routes only after locating the canonical persistence layer.
- No fake data, no stubbed successful delete/archive, no client-only cosmetic hiding.
- Avoid logging secrets, API keys, chat contents or private URLs in CI artifacts/screenshots. Use isolated test MAJIN_HOME with synthetic data.
- Keep actual OpenCode Go GLM inference as a **separate live gate**: the browser mock suite cannot prove that account auth works. Never use a key pasted in a chat; use a newly rotated secret or local protected configuration.

## Mandatory automated tests (release blockers)

Use real Chromium Playwright against a disposable MAJIN server, plus real Windows desktop smoke where available. Extend `scripts/phoenix-browser.mjs`, and/or add a separate focused suite:

1. Create chat A and chat B; send in A; assert A immediately first and still first after reload/restart.
2. Rename A; refresh; verify persistence and search result.
3. Archive A; verify hidden from Recent, present in Archived; restore; verify message history intact.
4. Delete B: cancel confirmation => B remains; confirm => B and history gone; refresh/restart => still gone.
5. Simulate archive/delete API failure; verify UI rollback, honest error, no false success.
6. Stream response in one chat, switch to another, then return: no cross-chat messages or wrong active state.
7. Keyboard-only context menu, archive confirmation, Escape/focus restoration, Ctrl+N.
8. 1440px desktop, narrow 800px, mobile-width 390px: sidebar/menu/header don't overlap, clip, or hide primary actions. Capture screenshots for each viewport.
9. Inspect actual app-window screenshot for double header, unstyled URL and alignment. Browser screenshot alone cannot validate native window chrome.
10. Model picker OpenCode Go selected => correct Go endpoint, GLM model, persisted through reload/restart; **not** Zen. Validate errors without claiming live auth.
11. Re-run existing UI acceptance and static accessibility suite, full Windows/Linux npm tests, and installer/update smoke. Fail the gate on real regressions.

## Delivery requirements

- **Do not declare 'all bugs fixed' without the full acceptance evidence.**
- Implement in small commits on the active development branch, coordinate with Astra to avoid competing edits to `src/ui/`. QA branch can carry independent tests/docs.
- Run the test suites and record exact passing/failing/skipped counts and links to workflow runs; preserve screenshots and trace artifacts on failures.
- Report each issue as `FIXED + VERIFIED`, `FIXED NOT VERIFIED`, `OPEN`, or `NOT TESTED`.
- Merge only when branch checks pass, no unreviewed conflict exists, and the live/provider/installer gates are accurately represented.

## Current independent QA context (not UI certification)

- QA PR #106: https://github.com/rssen-debug/MAJINCLI/pull/106
- UI browser QA: https://github.com/rssen-debug/MAJINCLI/actions/runs/39495603505
- OpenCode Go GLM Windows QA: https://github.com/rssen-debug/MAJINCLI/actions/runs/39495384879
- Prior full Linux and Windows unit suites each had zero failing unit tests, but skipped cases and incomplete real-world UI/provider coverage remain. This document defines **new acceptance work** rather than claiming those features already pass.

## Priority

**P0**: archive/delete end-to-end; activity sorting/persistence; truthful API errors; no data loss.
**P1**: unified app chrome, eliminate double header and stray URL; model-provider clarity and persistence.
**P2**: polished microinteractions, accessibility, responsive layouts, performance.

**Definition of done:** A user can create, revisit, rename, archive, restore, delete, search, and reorder chats without data loss, through a coherent single desktop app interface, verified by Windows+Linux UI automation and real-window visual evidence.

## Implementation evidence (2026-10-20, fix/realworld-repairs)

- **P0 chat conversations (archive/delete/rename/sort/search)**: FIXED + VERIFIED —
  `src/core/chats.js` durable server-side index (`chats-index.json`), routes
  `/api/chats`, `/api/chats/rename|archive|delete` (422 truthful errors, exact-title
  delete confirmation, "General" protected), activity hook on `/api/chat`,
  `src/ui/chats.js` (ellipsmenu, dialogs with Escape/focus-return, optimistic
  send-bump with server reconcile, mobile-friendly), CSS states.
  Delete removes `*.jsonl` + `.bak` siblings + `<id>.route.json` sidecar (bug
  found by browser testing: header textContent obliterating the toggle button —
  fixed by patching the text node only; sidecar leak fixed the same round).
- **P1 chrome/model clarity**: FIXED + VERIFIED — unified single header verified
  (exactly 1 `header` element), model chip renders `provider · model` (never
  ambiguous model alone, never silently Zen), no stray URL in content.
- **Acceptance suite delivered**: `scripts/ui-repair-test.mjs` — **26/26 gates
  green** against real Chromium incl. reload AND process-restart durability;
  **620/602/0/18** existing suite green, i18n curtain clean.
- **Stream-switch (spec #6)**: FIXED + VERIFIED — gates P0.6a-c found the
  switch-back bug (classic-script `const S` never landed on `window`, so
  chats.js updated a ghost object and the real session never moved); fixed by
  an explicit `window.S` alias. Verified with a real mid-flight SSE stream,
  switch away and back: no cross-chat text, correct active state, history
  intact. Cross-chat content was measured clean even before the fix (P0.6a).
- **NOT TESTED here (environment)**: Windows-native window chrome visuals,
  drag-region aesthetics on Windows, OpenCode-Go live provider lane (separate
  audited gate), installer/update smoke on Windows. Syne my-kördtandard the
  available gates; those stay in the Windows runner scope.
