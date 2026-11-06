# BROWSER_EXTENSION

The extension is how Buddy sees what you are studying. It is deliberately small:
it reads structure, it never writes, and it works on **any site you allow** —
Canvas, NetAcad, Moodle, Itslearning, Blackboard, a university portal, docs, or a
course someone wrote themselves.

There is no "supported vendor" list in the security path. NetAcad is just one of
many sites; `KNOWN_STUDY_SITES` in `browser-bridge.ts` only pre-fills suggestions.

## Load it

1. `chrome://extensions` → Developer mode → *Load unpacked* → pick
   `apps/browser-extension`.
2. Start the desktop app. Open **Inställningar → Webbläsare**. The panel shows a
   48-character key.
3. In the extension popup: paste the key, press **Spara**, tick **Aktivera
   läsning**.
4. In the app panel, add the site you study on (e.g. `canvas.instructure.com`).
   The extension receives the list and starts reporting only that site.

If you prefer the other direction: open the site, press **Tillåt den här sajten
i appen** in the popup. That creates a *request*, which appears in the app panel
as a pending site. It is not read until you approve it there. Requests are
untrusted input; the app owns the allow-list.

## What it reads

| Reads | Never reads |
| --- | --- |
| Page URL (https only) | Password or login fields |
| Page title and course name | Form values of any kind |
| Heading trail (`h1`–`h4`) | Cookies or auth tokens |
| Navigation items with nesting depth | Anything on a site that is not allowed |
| Completion state **only when the page states it** | Colour, opacity or icon shape as completion |
| Text you deliberately select (debounced 450 ms) | Continuous typing or clipboard |

Completion is read from an explicit label ("completed", "avklarad", "klart"),
`aria-checked`, or `data-completed`. If a page only colours a row green, Buddy
reports `unknown` — that is the honest answer, and it stops the app from claiming
you finished something you did not.

Cross-origin lesson frames cannot be read. The snapshot then carries
`contentInIframe: true`, the app marks those nodes inaccessible, and the
curriculum is reported as `partial`. It never guesses what was inside.

## Transport

Loopback WebSocket to `ws://127.0.0.1:8765` (configurable), implemented by
`apps/desktop/electron/bridge-server.ts`.

* bound to `127.0.0.1` only; a connection from any other address is closed
* the first frame must carry the shared token; comparison is constant time over
  SHA-256 digests
* message types are an allow-list (`hello`, `ping`, `page-context`, `curriculum`,
  `selection`, `quiz-observation`, `site-request`); anything else closes the socket
* frames are capped at 2 MB before parsing
* the app answers `hello` with `welcome` containing the authoritative allow-list
* **no queue**: while the app is not running, observations are dropped. The
  extension never becomes an offline archive of your browsing.

Rotating the key in the app disconnects every connected extension immediately.

### Why not native messaging?

Native messaging is the right production answer: no listening port at all. It
requires a registry key on Windows and a host manifest installed next to the
browser, which means the installer must register it — that belongs in the same
Windows packaging step that is currently untested here (see `BUILD_STATUS.md`).
The loopback bridge is the honest interim: it is real, tested, and locked to
localhost with a per-install secret.

## Enabling per site

`manifest.json` uses `optional_host_permissions: ["https://*/*"]` and a content
script that matches all https pages. The content script is **inert** until the
service worker sends `set-active`, which happens only when:

1. the student enabled the extension (`enabled`), and
2. the site is in `allowedSites` (the app's list).

Pressing the popup button calls `chrome.permissions.request` for that one origin,
then asks the app. Chrome's permission and the app's allow-list are two separate
gates; both must pass.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3, optional host permissions, no `tabs` permission |
| `content.js` | Reads the page; inert until activated; site-agnostic |
| `background.js` | Holds the socket, token, backoff, allow-list mirror |
| `popup.html/js` | Paste key, enable, allow current site |

## Testing status

The bridge server is covered by `tests/unit/bridge-server.test.ts` (11 tests) over
a **real socket**: authentication, wrong-token close, unknown-type close, unlisted
site rejection, selection validation, ping/pong, broadcast restricted to
authenticated clients, clean shutdown.

The extension itself has **not** been loaded into a real Chrome here — no browser
is available in this environment. Marked BLOCKED in `BUILD_STATUS.md`. What is
verified is the protocol it speaks, byte for byte, from the other end.
