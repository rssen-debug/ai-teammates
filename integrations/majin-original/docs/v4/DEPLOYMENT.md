# MAJIN V4 — private deployment

Goal: a private HTTPS URL that only you can open, pointing at the MAJIN host on
your Windows PC. No port forwarding, no RDP, no public API surface.

> This document is honest about what has been verified. The scripts exist and
> were reviewed; the tunnel steps require **your** Cloudflare account and have
> **not** been executed in this environment. Steps marked ⚠ require you.

## 0. Prerequisites

- Windows 10/11, Node.js **22 LTS** (`node -v`)
- The MAJIN repo cloned, e.g. `C:\MAJINCLI`
- Your existing MAJIN V1 providers/keys already configured on that machine
  (`%LOCALAPPDATA%\MAJIN\config.json`, or `MAJIN_CONFIG`)

## 1. Start the host (verified locally)

```powershell
cd C:\MAJINCLI
npm ci
npm run v4:doctor
npm run v4
```

The console prints a pairing code **once**. Copy it to the phone when you open
the URL — never into chat, e-mail or a ticket.

Default bind is `127.0.0.1:7373`. That is deliberate: nothing outside the machine
can reach it until a tunnel exists.

## 2. Automatic start at logon (script written, not run on Windows here)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\v4\install-v4-windows.ps1 -AutoStart
```

This registers a **per-user** Scheduled Task at logon with restart-on-failure.
It does not create a service account and does not change machine-wide settings.

Remove it with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\v4\install-v4-windows.ps1 -Uninstall
```

## 2.1 Files, history and the phone after this release

Three things behave differently from the first V4 build, and one of them needs a grant you make from
the phone:

1. **A granted folder is real access.** Behörigheter → *Mapp att ge åtkomst till* → add e.g.
   `C:\Users\<you>\Documents`. From that moment `fs_find`, `fs_read`, `fs_write`, `fs_search` and
   `document_read` can use absolute paths inside it, and MAJIN is told the path in its system prompt.
   Everything else on the disk stays refused. Revoke the folder and the next call is refused too.
2. **The chat history is the server's.** Open MAJIN on the computer, then on the phone (or the other
   way round): the left drawer lists the same conversations, search covers the whole transcript,
   archive is reversible and deletion is permanent and confirmed. An installed PWA picks up the new
   shell on its next launch (the cache version was bumped); if it looks stale, close it from the app
   switcher and reopen.
3. **Importing the old history is one button.** Historik → *Importera tidigare historik* shows what
   would be imported, asks, then writes through the same store. The V1 files under
   `%LOCALAPPDATA%\MAJIN\sessions` are only read.

Verify all three on the host:

```powershell
npm run v4:accept -- --url https://<your-address> --write
```

`history.rename`, `history.archive_restore`, `history.search`, `history.two_devices`,
`files.fs_find_registered` and `files.granted_folders` are the rows that prove it.

## 3. Cloudflare Tunnel ⚠ (owner action)

Assumes a domain you control is on Cloudflare (free plan is enough).

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login                       # browser, pick your domain
cloudflared tunnel create majin-v4
cloudflared tunnel route dns majin-v4 majin.DIN-DOMAN.se
```

Config file `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: majin-v4
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: majin.DIN-DOMAN.se
    service: http://127.0.0.1:7373
  - service: http_status:404
```

Run it as a user service so it survives logout:

```powershell
cloudflared service install
```

Then start MAJIN with the public origin and proxy trust:

```powershell
setx MAJIN_V4_PUBLIC_ORIGIN "https://majin.DIN-DOMAN.se"
setx MAJIN_V4_TRUST_PROXY "1"
```

Restart the host task. `npm run v4:doctor` should now show `public_origin OK`.

If your tunnel uses rotating subdomains, allow the family instead of one name:

```powershell
setx MAJIN_V4_ALLOWED_HOSTS "*.din-doman.se"
```

A wildcard entry only matches real subdomains — `*.din-doman.se` matches
`majin.din-doman.se` but never `din-doman.se` or `evildin-doman.se`.

## 4. Put an identity gate in front (Cloudflare Access) ⚠

Cloudflare dashboard → Zero Trust → Access → Applications → **Add an application
(Self-hosted)**:

- Domain: `majin.DIN-DOMAN.se`
- Policy: `Allow` → **Emails** → your address only (or your Google/Apple login)
- Session duration: 24 h (or your preference)

Now the URL requires an IdP login **and** MAJIN's own pairing session. Two
independent gates. Tailscale is the documented fallback: install Tailscale on
the PC and phone, keep MAJIN bound to `127.0.0.1`, and reach it over the tailnet
(`http://<pc-name>:7373`). Tailscale-only means no public URL at all — that is a
feature for a private release, not a limitation to hide.

## 4.5 Run it supervised (recommended)

```powershell
npm run v4:serve:supervised
```

The supervisor restarts the host after a crash with backoff, gives up loudly after five
restarts inside ten minutes, and writes one JSON line per event to
`%LOCALAPPDATA%\MAJIN\v4\logs\supervisor-<date>.jsonl`. Ctrl+C stops it for good.

## 5. First phone run (acceptance)

1. Open `https://majin.DIN-DOMAN.se` in Safari/Chrome.
2. Pass the Access login.
3. Enter the pairing code from step 1.
4. Add to home screen (iOS: Share → Add to Home Screen; Android: ⋮ → Install app).
5. Send: `Skriv filen test.txt med innehåll: hej från telefonen`.
6. Expect a tool card that turns green **verified on disk**, then the answer.
7. Lock the phone, reopen: the conversation is still there.

Then run the automated gate and paste its output into `docs/v4/TEST_EVIDENCE.md`:

```powershell
npm run v4:accept -- --url https://majin.DIN-DOMAN.se --write

# or do the whole install and the acceptance run in one command:
npm run v4:setup -- --autostart --accept --release-url https://<release-base> --auto-update
```

It exits non-zero if anything fails, and it will not claim a model while none is configured.
The matrix points H3/H4 stay unearned until that evidence exists.

## 6. Backup, update, rollback

```powershell
# backup: a verified bundle (conversations, goals, memory — never keys or sessions)
npm run v4:backup -- backup
npm run v4:backup -- verify "$env:LOCALAPPDATA\MAJIN\v4-backups\<stamp>"

# restore onto this or another machine (pair the phone again afterwards)
npm run v4:backup -- restore "<bundle dir>" --dry-run
npm run v4:backup -- restore "<bundle dir>" --force

# update: gates on install -> doctor -> tests -> matrix, rolls back on failure
npm run v4:upgrade -- --dry     # see the plan
npm run v4:upgrade

# manual rollback if you ever need it
cd C:\MAJINCLI; git checkout <previous-sha>; npm ci --ignore-scripts
```

Data format is JSON with a `schema` field per file (`majin.v4.conversation/v1`,
`majin.v2.goal/v1`). `restore` refuses an unknown schema on purpose: a future format needs
a migration, not a guess.

## 7. Shutdown and offline behaviour

- `Ctrl+C` (or stopping the task) closes the listener; in-flight goals stay
  `RUNNING` on disk and are marked `BLOCKED` on next boot — never "completed".
- The phone shows an offline bar when `/api/state` fails and does not pretend
  messages were delivered.
- If the PC is off, the tunnel returns 502/1033; MAJIN cannot fake availability.
