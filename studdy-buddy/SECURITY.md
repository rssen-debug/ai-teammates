# SECURITY

Studdy Buddy reads parts of a student's screen and sends text to an AI provider.
That is a privileged position, so the security model is written down here rather
than discovered later.

## Threat model

What we defend against:

1. **A malicious page or extension** trying to read the local database, exfiltrate
   the API key, or drive the app's IPC surface.
2. **A compromised AI provider** receiving more than the student agreed to share.
3. **Accidental capture** of unrelated private windows (bank, personal mail).
4. **Credential leakage** through logs, crash dumps or the renderer.
5. **Cheating** — Buddy being used to complete graded assessments.

What we explicitly do **not** defend against: an attacker who already has the
user's OS-level account and can read their files. Full-disk encryption and the
Windows login are the real boundary there.

## Permission model

Nothing is enabled by default. Every capability is an explicit, revocable grant
stored in the `permission_grant` table:

| Permission | What it allows |
| --- | --- |
| `screen.capture` | Capture a single chosen window |
| `application.observe` | Read window titles and the accessibility tree of approved apps |
| `browser.read` | Read the NetAcad tab the student has open |
| `microphone` | Record while the student holds the talk control |
| `computer.actions` | Perform an individually confirmed click/keystroke |
| `provider.dataShare` | Send gathered context to the AI provider |

Three operating modes layer on top:

* **OBSERVE_ONLY** — read approved context, cannot draw or act.
* **VISUAL_GUIDE** — may also highlight targets on screen.
* **APPROVED_ACTION** — may perform one action at a time, after confirmation.

`computer.actions` requires *both* the grant and APPROVED_ACTION mode. Revoking a
grant takes effect immediately, including hiding the overlay.

## What is never done

* No hidden screen recording. Capture happens only in response to a student
  action, one window at a time.
* No global keyboard logging.
* No collection of passwords, form values or authentication tokens. The content
  script reads headings, navigation labels and *deliberately selected* text.
* No bypassing NetAcad authentication. The extension only reads pages the student
  already has open and logged in.
* No manipulation of course completion or grades.
* No submitting answers in graded assessments.
* No arbitrary AI-generated shell commands.
* Raw screenshots are not written to disk by default.

## Assessment integrity

`packages/curriculum/src/assessment.ts` classifies the page as
SELF_STUDY / PRACTICE / GRADED_QUIZ / FORMAL_EXAM / UNKNOWN, conservatively: when
signals are ambiguous it picks the *more* restrictive mode.

In GRADED_QUIZ and FORMAL_EXAM, `assistancePolicy()` sets
`maySuggestAnswer: false`. The services layer then injects an explicit instruction
into the model's system prompt not to answer the specific question, and the UI
shows a notice. Concept explanations and original practice questions remain
available — the goal is that the student actually learns the material.

## Secrets

* API keys are stored by `FileVaultKeychain`, encrypted with AES-256-GCM using a
  key derived (scrypt) from a per-install secret file with `0600` permissions.
* Keys are **never** written to SQLite (asserted by a test), never sent to the
  renderer, and only placed in the `Authorization` header of a provider request.
* Logging redacts `sk-*` keys, Bearer tokens, `api_key=` values and passwords
  *on the way in*, so a secret never waits in a log file to leak.

**Honest limitation:** the encrypted-file vault is not the Windows DPAPI or
Credential Manager. A process running as the same user can decrypt it. The
intended production improvement is DPAPI (`CryptProtectData`) on Windows with the
file vault as the cross-platform fallback; that is not implemented yet.

## IPC and process isolation

* Renderer runs with `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`.
* The preload script exposes a fixed allow-list of channels. No dynamic channel
  names, no Node APIs, no `require` in the renderer.
* Every IPC handler validates its payload and returns a discriminated
  `Result<T>`, so the renderer cannot confuse an error with data.
* The renderer's CSP forbids external scripts, inline scripts, remote fonts and
  framing.
* `setWindowOpenHandler` denies all popups; external https links are handed to the
  OS browser.

## Browser bridge

* Loopback only (127.0.0.1). Never bound to 0.0.0.0.
* Shared token compared in constant time (`timingSafeEqual` over SHA-256 digests).
* Message types are an allow-list; unknown types are rejected before parsing.
* Message size is capped at 2 MB.
* Page origins are validated against a NetAcad/Cisco/SkillsForAll allow-list that
  rejects lookalike domains (`netacad.com.evil.io`) and non-HTTPS URLs.
* The extension has zero message queue: when the app is not connected, observations
  are dropped rather than spooled, so the extension never becomes a browsing-data
  archive.

**Current gap:** the loopback WebSocket listener is not yet started in
`main.ts`. The auth and validation logic is complete and tested, but the extension
cannot connect until the listener is bound. This is tracked as the top next action
in BUILD_STATUS.md.

## Data handling

* Everything is local: one SQLite file in the platform data directory.
* The student can wipe learning history (Settings → Data).
* The observation log is bounded and pruned.
* Logs rotate at 2 MB.
* The only outbound traffic is to the provider endpoint the student configured,
  and to the TTS provider if they enabled cloud voice.

## Dependency and build integrity

* No native compilation step: SQLite comes from Node's built-in `node:sqlite`.
  This removes `node-gyp`/prebuilt-binary supply-chain surface entirely.
* The renderer bundle is self-contained; nothing is loaded from a CDN at runtime.
* CI runs typecheck, the full test suite and both builds on Linux and Windows.

## Reporting

This is a personal study tool, not a published product. If you are reading this
from a fork, treat the file vault as adequate for a single-user machine and no
more.
