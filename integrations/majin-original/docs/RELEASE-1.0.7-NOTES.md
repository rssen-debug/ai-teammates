# MAJIN v1.0.7 — update discovery and Windows UI

This release fixes the case where MAJIN 1.0.3's CLI correctly discovers a newer GitHub release but its open window remains without an Update button.

- Always show **Check updates** in the header if update checks are enabled, even while offline or up-to-date.
- Render **Update <version>** immediately from a cached checked release in user config.
- At app start, perform a non-blocking release check and refresh the header once it finishes; no fixed 6.5-second delay.
- Retry checks and confirm installation inside the app; a real installer failure remains visible.
- Browser CI asserts a cached update is instantly discoverable and manual checking is always available.

PR: https://github.com/rssen-debug/MAJINCLI/pull/228

## Verification scope

The pull request passed fast offline checks, live OpenCode Go smoke, Windows runner acceptance, Windows GUI/browser/installer gate and full EXE build on commit `ac05521cf992fbdb12d3ff3fd1f6d4eba651e7f4`. Final GitHub release assets and SHA256 must be independently confirmed after the main-branch publish job.

**Upgrade note:** Older already-installed v1.0.3 executables cannot be changed retroactively. Installing this new version once through the GitHub Windows Setup asset is required to gain the persistent in-app update control. Settings and workspace should remain in their existing user directories; back up important data before installing.
