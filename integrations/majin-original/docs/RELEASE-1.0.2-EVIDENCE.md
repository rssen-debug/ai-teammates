# MAJIN v1.0.2 release evidence and limitations

Source baseline: main at 403424913dafa0f1623dc265bdc52832d8947107, after PR #211.

## Scope

- Restore-safe GRAND ARCHITECT checkpoints: re-check current file contracts and recorded artifact digests; do not carry stale or modified artifacts.
- Bind resumable work to exact task instructions and dependencies; reject stale node-ID reuse.
- Fail closed with REQUIRES_REVIEW for carried steps that cannot be independently verified without re-executing unknown side effects.
- Retry external Ollama model download errors at most three times in the real free-model CI gate; preserve red result if the model cannot be fetched.
- Bump package, lockfile, runtime literal, installer default, and publish script to 1.0.2 consistently.

## Required release proof

1. v1.0.2 PR gates green: syntax/full Node tests, live OpenCode Go, Windows GUI/installer, free-model acceptance, and build-exe.
2. Exact merged main commit verified. New main build-exe must pass before declaring the release usable.
3. Newly created public GitHub release v1.0.2 with MAJIN-Setup.exe, majin-win-x64.exe and both respective .sha256 checksums.
4. Do not mistake the previous v1.0.1 assets for freshly built v1.0.2 artifacts.

## Interactive Windows evidence — precise scope

The self-hosted runner MAJIN-INTERACTIVE-01 (2026-10-21, run 39584274075) was confirmed in an interactive Windows session and executed real MAJIN control.list/type/read/click against a disposable QA window with verified saved bytes; it also observed the W12 pink overlay appear, move and hide in actual screen pixels (only synthetic QA pixels sampled, no desktop screenshot uploaded). These are real limited-scope tests, not a generic autonomous desktop task.

**Verified narrowly on the owner's interactive Windows session:** real OpenCode Go planned MAJIN computer.use Win32 actions in a disposable QA window; independently checked persisted bytes. W12 cursor pixels appeared, moved, and disappeared. Run [39588560481](https://github.com/rssen-debug/MAJINCLI/actions/runs/39588560481), source commit 40d47236cb530c693d9c16986876b9d2208763eb. **Still NOT VERIFIED:** arbitrary third-party Windows apps, all model/account combinations, automatic update over an installed end-user binary, or a broad multi-hour desktop mission. QA fixture proof is not a blanket 100% certificate.

## Verified interactive Windows desktop fix scope

- On the self-hosted Windows desktop runner, real WinForms list/type/read/click/save for a disposable QA app; saved bytes read back exactly.
- MAJIN computer.use executes a bounded OBSERVE→PLAN→ACT→VERIFY chain on that disposable window, both with a deterministic test planner and with actual OpenCode Go model inference. Real cloud model chooses actions; test checks the saved QA file.
- Pink overlay pixels are sampled in-memory in a small region and proved to appear, move, update label state and disappear; no private screenshots or unrelated window titles uploaded.
- Reference owner-PC workflow: https://github.com/rssen-debug/MAJINCLI/actions/runs/39586059993 (earlier Go+pink PASS). Follow-on W11/W12 + live-cloud acceptance workflow: https://github.com/rssen-debug/MAJINCLI/actions/runs/39588560481 (PASS; same QA code incorporated into the release candidate).
- Only synthetic QA app and basic Win32 Edit/Button controls verified. This DOES NOT prove universal arbitrary app navigation, user-file manipulation, or unsupervised high-impact actions.

- v1.0.2 main build-exe additionally re-downloads both public EXEs and SHA256 manifests to prove their bytes match the newly built binaries. An absent or mismatched asset is a release-gate failure.

## Fixed in this interactive patch (candidate-branch additions)

- Run Win32 control bridge as a direct PowerShell process rather than nested command parsing.
- Recognize standard Windows Forms EDIT and BUTTON controls.
- Correct UTF-8 PowerShell source encoding and diagnostics; byte-accurate synthetic QA readback.
- Keep pink WinForms overlay attached to the real interactive session; fix Add_Paint event handling, display position, and visibility.
- Wire guarded `computer.use` to a real cloud model planner, reject unverified `done` claims, restrict actions to known safe Win32 control capabilities, require independent verification.
- New real-device, nonintrusive self-hosted Windows acceptance workflow.

**Install/update note:** the user may need to install or update this version to run the newly fixed code; a QA runner checkout alone does not install the release onto the user's computer. Interactive-desktopen patch-releases rubric notes this explicitly so no one mistakes a QA checkout for an installed 1.0.2 binary.

## Successor release version (2026-10-21)

The tag `v1.0.2` already points at `29193b533c8934cab41d326db455ff8894fc7316` (the prior main baseline). To prevent a new installer's binaries being mislabeled by an existing tag, the interactive Windows fixes and current acceptance gate changes are published as **v1.0.3** only after all CI gates pass on the final pull-request head. Do not force-move or reuse the earlier v1.0.2 tag. Never call v1.0.2 assets proof of the new v1.0.3 build. The main build workflow must publish and independently SHA256-verify both v1.0.3 Windows EXEs before RELEASE READY.
