# MAJIN V4 — security model

## Threat model

| Actor | Capability | Mitigation |
|---|---|---|
| Anyone on the internet | sees only what the tunnel exposes | loopback bind, tunnel-only ingress, no port forwarding |
| Someone with the URL but no session | can hit `/api/health`, `/api/me`, `/api/auth/pair` | all other routes require a session; pairing is rate limited |
| Someone who guesses a pairing code | 32^8 ≈ 1.1e12 space, 5 attempts/min | code is HMAC-hashed at rest, rotated on demand |
| A malicious page in the owner's browser | cross-site POST | `Origin`/`Referer` must match; `X-MAJIN-CSRF: 1` required; cookies are `SameSite=Strict` |
| DNS rebinding | forged Host header | allowlist + optional `MAJIN_V4_PUBLIC_ORIGIN` match |
| A prompt-injected model | tries `../` paths or a shell | tools are typed, no shell tool exists, filenames are leaf-only, writes are `wx` create-only |
| A malicious plugin | arbitrary code | **not sandboxed from the OS user** — opt-in, allowlisted, permission-declared, run in a supervised child process, quarantined on failure |
| XSS in a rendered answer | script execution | the client renders markdown manually (text nodes), CSP forbids inline and third-party script |
| Stolen phone, unlocked | read access | sessions are revocable (`/api/sessions` view, logout revokes immediately), 30-day expiry |

## Controls implemented

- **Pairing:** 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, displayed once, stored as
  HMAC-SHA256 with a 32-byte key in `v4/secret.key` (0600).
- **Sessions:** random 24-byte id + HMAC signature, stored server-side in `v4/sessions.json`
  (0600); `HttpOnly`, `SameSite=Strict`, `Secure` when HTTPS, `Max-Age` = TTL.
- **Revocation:** logout deletes the record; a token whose record is gone is rejected.
- **CSRF:** custom header + same-origin check on every POST/DELETE.
- **Rate limits:** pairing / turns / general, sliding window per client key.
  Behind a proxy the client key comes from `CF-Connecting-IP`/`X-Forwarded-For`
  only when `MAJIN_V4_TRUST_PROXY=1`.
- **Body limits:** 64 kB default, per-route smaller limits for auth.
- **Headers:** CSP `default-src 'none'`, `frame-ancestors 'none'`, `nosniff`,
  `no-referrer`, COOP same-origin, `Permissions-Policy: microphone=(self)`.
- **Tool boundary:** flat workspace, `wx` open (no overwrite), traversal and reserved
  Windows device names refused, 1 MB content cap, 60 s tool timeout.
- **Secrets:** provider keys never leave the host. `/api/models` returns labels and ids only.
  Logs print counts, never values. The pairing code prints once at boot.
- **Evidence:** sensitive external actions require an approval decision; `strict` policy
  turns every write into a human confirmation.

## Uploads and previews

| Control | Why |
|---|---|
| Leaf-name only | an upload cannot choose a directory or escape one |
| Type allowlist; no `html`, `svg`, `js` | those execute inside the owner's authenticated origin |
| Magic-byte re-typing | the browser's declared MIME is a hint, not a fact |
| Size checked before and after decode | a declared length can lie |
| Collision → suffix | an upload never overwrites work |
| Preview served with `CSP: sandbox` **and** iframed without `allow-same-origin` | a page MAJIN wrote cannot read the session cookie, the app DOM, or the API |
| Service worker skips `/api/` | uploaded photos never enter a shared cache |

**Not solved:** no malware scanning, and an opened PDF is rendered by the owner's own viewer.
Both are stated here rather than implied away.

## Known gaps (do not treat as solved)

1. **Plugin isolation is process-level, not a security sandbox.** Plugins run in a
   separate Node process with a stripped environment, per-call timeouts and crash
   containment (`src/v4/sandbox.js`). They still run as the same OS user and can read what
   that user can read. A true boundary needs a separate account or a container.
2. **Single-host session store:** a JSON file; no clustering, no distributed revocation.
   Sessions do survive a restart, which is what the product needs.
3. **No 2FA/passkey yet:** pairing code + device session. Passkeys are a planned upgrade,
   not a shipped claim.
4. **No audit export UI:** receipts exist per goal; there is no operator audit console.
5. **Rate limiting is process-local** and resets on restart.
6. **No penetration test** has been run against a tunnelled deployment (matrix S14).

## Reporting

If you find a vulnerability, do not open a public issue with exploit details.
Rotate the pairing code first (`npm run v4:pair -- --rotate`), then revoke sessions
by logging out on each device.
