# MAJIN V5 — Living Minimal UI: Codex handoff

## Goal
Preserve the proven MAJIN V5 backend and XP integrity while shipping a beautiful, calm, accessible desktop experience. A 75-year-old must be able to use the home screen without instructions.

## Implemented on this branch
- Removed noisy home-page controls and translated the initial desktop UI to English.
- Made the hero orb the focal point; clicking opens existing skills details.
- Implemented continuous, gentle orbit motion for the 99 earned dots with reduced-motion support.
- Working uses an independent cyan/violet moving arc; only verified outcomes add green dots/XP.
- Kept the existing text input, file attachment, mic, submit/stop, model settings, and skills drawer.
- Added step-specific, factual "Uploading <file>" and "Working on your request" status updates without spamming the conversation.

## Codex checklist (must execute before merge)
1. Run `npm run v5:test`, `npm run i18n`, `npm run check`, and `npm run v5:accept`. Investigate and repair all failures; do not modify core XP/receipt security logic to satisfy UI tests.
2. Build `npm run v5:build` and Windows desktop using the supported CI/build workflow. Confirm no broken URLs, CSP/style issues, missing assets, or console errors.
3. Perform browser-based visual checks at 1920x1080, 1366x768, 1024x768 and 390x844. Test keyboard navigation, focus, contrast, 200% zoom, and reduced motion.
4. Verify level 1, intermediate level, level 99, stale skills, no XP, genuine +XP, background working, failure, and cancellation. The working animation MUST NOT increase earned dot count or XP.
5. Confirm orb runs continuously but uses low CPU and stops when hidden; cap to ~30 FPS or less, pause on `visibilitychange`, and respect reduced-motion. Test against a low-end Windows laptop.
6. Change display stage only on truthful backend signals, never fake "researching/building/testing" stages based on elapsed time.
7. Audit remaining Swedish strings in both static and dynamic UI; all visible product UI should be English by default.
8. Verify microphone truly activates and interrupts voice end to end before claiming live voice. Handle denied mic permission visibly, and never autostart on typing.
9. Test that messages remain concise, intermediate progress stays in the single status area, and final response is shown once.
10. Preserve previous V5 releases and stable branches. Prefer a reviewable PR and do not overwrite production state or secrets.

## Acceptance criteria
- One clear prompt box; microphone beside it; no always-visible navigation/sidebar, tool cards or XP dashboard.
- Living green circle at idle. Different visual status for actual work, error, stopped, and verified XP.
- No fabricated progress, skill gain, or completion claims.
- Functional provider choice and remembered selection after reload.
- No visual regression on mobile or desktop and no broken accessibility.
- Verifiable tests, screenshots, build evidence and precise remaining issues in the PR.
