# V4 shared app layout

The desktop window and mobile/browser clients load the same V4 UI from the shared
host. The existing V1 browser-app mechanism is reused by Ghost's desktop shortcut
with installed, Authenticode-valid Chrome, --app=http://127.0.0.1:7373/ and
--window-size=520,860. It has no browser tabs/address bar. No V1 server is launched.

The Electron default window is likewise 520 by 860; existing saved window bounds
and resizing remain supported. This changes the shell defaults, not the shared UI.

Actual Chrome on isolated demo hosts verified both 520x860 desktop and 390x844
touch viewports: V4 heading/spirit/composer, absent suggestion buttons, focusable
input, enabled send after text, history opening and no input-blocking overlay.
Public ordinary-host HTML independently identifies V4 and the current heading.
This proves layout and interaction, not native installation or physical speech.

Existing desktop policy, mobile touch/cache recovery and heartbeat real-browser
regressions: six passed, zero failed/skipped with the installed Chrome executable.
Screenshots are explicitly isolated demo UI previews. Ghost's shortcut was saved
and read back, but not automatically opened because the previous saved browser
opening restriction has not been bypassed. No host restart was attempted.

Production native signing, installation, activation/update/rollback and all earlier
acceptance gaps remain NOT READY; see FINAL_EXECUTION_20261024.md.
