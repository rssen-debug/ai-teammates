# Omega browser extension — existing logged-in tabs, no extra Chrome

**This is the workflow for the owner's ACTUAL existing Chrome or Edge session.**
The extension installs inside the browser profile that is already open.
No separate Chrome installation/profile, remote-debugging-port, VNC,
global keyboard/mouse events, or window activation is needed.

## Install and pair (once per browser profile)

1. Launch Omega latest using `omega/start_latest.ps1 -WithBrowser`.
   The launcher installs `websockets` and copies the extension to
   `%LOCALAPPDATA%\\StuddyBuddy\\extension` without starting Chrome.
2. In your EXISTING Chrome, open `chrome://extensions`, turn on Developer
   mode, select **Load unpacked**, and select the folder printed by launcher.
   For Edge use `edge://extensions`. Extension permissions give access to
   tabs/webpages: install only if you accept that scope.
3. In Omega enter `/browser pair`. Copy the random token into the Omega
   extension's **Options**. It is stored locally in that browser profile.
   Do not put pairing tokens in bug reports or public messages.
4. Enter `/browser status`, then `/browser tabs`. The tabs in this listing
   are the same browser tabs you are already using.
5. Example: "Hitta min ChatGPT-flik och skriv ett utkast om subnetting, men
   skicka det inte." Omega uses `background_tabs` to select tab ID, then
   `background_elements` for selectors and `background_type` to fill a draft.

No special browser startup flags are required. **Your active tab remains
active**, but background pages can reject or throttle scripts; those actions
fail clearly rather than steal desktop focus.

## Security / constraints

- Loopback WebSocket listens only on `127.0.0.1:18783`.
- Accept only `chrome-extension://` origins with an explicit matching
  pairing token, kept in Windows DPAPI on the Omega side.
- Pairing rotates via `/browser rotate`; remote webpages cannot connect
  directly as Chrome extension origins.
- Tool exposure limits to tab listing, reading, control discovery, clicks,
  and draft typing. Arbitrary page JavaScript is **not** exposed to the model.
- Tabs identified by exact numeric tab ID: no guessing which of multiple
  same-titled tabs to operate.
- Native Chrome internal pages, Web Store, extension pages, and some sandboxed
  frames cannot be scripted through the extension; return a clear error.
- This first version does not guarantee a SPA (React) editor will accept every
  scripted keystroke; verify readback before claiming success.
- An installed browser extension has sensitive access. Users must choose
  to install and pair it. The extension cannot be silently force-installed.
- For external sends/purchases/deletes, existing Omega permission gates apply.
- No claim of guaranteed zero UI latency on a physical Windows laptop.

## Current verification

CI tests protocol registration, fail-closed behavior, Node syntax, and zero
Chrome focus API calls. A real Chrome extension load, live ChatGPT typing
and user desktop latency test still require the owner's Windows session.
