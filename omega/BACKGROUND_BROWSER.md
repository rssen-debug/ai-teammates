# Omega background browsing — existing tabs extension (current default)

**Current approach:** install and pair the Omega Chrome/Edge extension from
`omega/extension` to control the user's **existing logged-in browser tabs**.
It does not start another browser/profile or change Windows foreground focus.
See [EXISTING_TABS.md](EXISTING_TABS.md) for instructions and limitations.

The older CDP section below documents the superseded debug-browser approach.
Omega's default browser-task gate now requires the paired extension; it does
not silently start Chrome with remote debugging.

---

# Omega background browsing — user desktop is never hijacked

**Goal:** work in a Chrome/Edge tab while the owner continues working in
another application, without switching Windows focus or moving the OS cursor.

This is implemented using Chrome DevTools Protocol (CDP) directly against a
debuggable tab, **not VNC against the active Windows desktop**. The protocol
works per tab, independent of the currently foreground window. VNC to the
normal desktop would still steal mouse/keyboard/focus.

## Existing browsers: an important limitation

Chrome and Edge must have been launched with remote debugging **before**
Omega can discover their tabs. CDP cannot retroactively attach to ordinary
existing Chrome windows whose debugging port is disabled. A separate Buddy
debug-browser profile also does **not** inherit the user's logged-in cookies.
For already-running non-debug Chrome/Edge, Omega must say it cannot connect,
not open/switch the active window or invent a successful result. An optional
browser extension/native messaging bridge is the longer-term solution to
attach to existing browser profiles, pending security review and user install.

## Workflow

- Ask: "Skriv ett utkast i ChatGPT-fliken, men skicka inte än".
- Omega checks whether a CDP session is present.
- `browser_tabs` lists tabs, `browser_dom_elements` finds actual form
  controls/selectors, and `browser_type` types into the selected tab.
- The owner's foreground Windows application remains focused.
- Posting/submitting remains subject to the existing approval rules.
- Direct click/selection tasks have a 12-step and 120-second ceiling.
- When CDP is absent, the agent **blocks immediately**, before any tool
  attempts, rather than making dozens of ineffective UIA/PowerShell calls.
- Host desktop and Windows UIA mouse/keyboard actions are blocked by default.
  Separate VM VNC is an alternative that needs its own guest and server.

## Performance improvements

- Terminal transcript render budget reduced for older turns; the most recent
  complete reply remains visible, with full history preserved separately.
- Streaming display repaint throttled to 160ms between updates.
- No TextArea buffer mutation if the visible text has not changed.
- Activity panel uses fewer terminal rows, leaving more space for chat.

## Release gates

Automated CI verifies fail-closed routing, focus protection and step limits.
Actual background operation with the user's logged-in Chrome/Edge instance,
ChatGPT webpage DOM behavior, authentication and keyboard latency require
real Windows end-to-end tests. **No claim of invisible operation is justified
unless CDP is actually attached to the correct tab.**
