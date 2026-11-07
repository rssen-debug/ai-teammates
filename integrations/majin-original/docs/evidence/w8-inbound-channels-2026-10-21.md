# W8 Channel expansion — inbound (receive) parity proof (2026-10-21)

## What STATUS said was missing
| Claim in STATUS.md (pre-round) | Reality found | Action |
|---|---|---|
| "Discord/Slack/Matrix/Email saknas" | OUTBOUND for discord/slack/matrix/email/webhook already existed and was tool-tested (`src/core/channels/send.js` + `channel.send`) | row reclassified, see below |
| "send/receive-verifiering per kanal saknas" | RECEIVE existed ONLY for telegram/whatsapp (Channels bus); no per-channel receive proof for discord/slack/matrix | **implemented + verified this round** |

## Reuse pass (user directive: don't reinvent)
Absorb-scans (MAJIN's own engine, static only):
- `matrix-org/matrix-js-sdk` — 488 files, Apache-2.0, channels heat 383. Used for: `/sync` GET shape, `next_batch`/`since` semantics, `m.room.message` + `msgtype:m.text` event ontology. **Not a dependency** (488 files for a fetch is exactly the wheel-inversion anti-pattern the directive rejects).
- `slackapi/node-slack-sdk` — 2100 files, MIT, channels heat 172. Used for: `conversations.history` field + `auth.test` self-id sanity.
- Plus the in-repo wheel: the Telegram adapter's own poll→cursor→onMessage shape (`channels/telegram.js`), replicated deliberately.

## Implemented (zero-dep, all fetch-only)
| Adapter | Endpoint style | Cursor | Honest-limits surfaced in status() |
|---|---|---|---|
| `src/core/channels/discord.js` | REST poll `/channels/{id}/messages?after=` (GET) + `/users/@me` baseline | snowflake per-channel, persisted | Message Content privileged intent required — empty content → bus warn `discord.empty-content` (never frozen-agent silence) |
| `src/core/channels/slack.js` | REST poll `conversations.history` (oldest+inclusive=false), `auth.test` baseline | ts per-channel, persisted | `not_in_channel` per-channel in `channelIssues` — surfaced, never swallowed |
| `src/core/channels/matrix.js` | native `GET /sync?since=` (limit:0-filter baseline, never backlog flood) | `next_batch` since-token, persisted | encrypted rooms counted `skippedEncrypted`, never fed as garbage; E2EE unsupported is said plainly |

All three plug into the SAME `Channels` bus: `channel:chatId` sessions, approval routing (`/ja <id>` answered in the chat where the request originated), `deliver()` for scheduler notifications, `status()` parity, shared queue. Outbound replies reuse the verifierade send.js lane — no second send implementation.

## Verification (per-channel, exactly what was missing)
`test/channels-inbound.test.js` **7/7**: tail-baseline-never-floods · newest-first sort · cursor `after`/`oldest`/`since` correct params · dedupe windows · own/bot-message loop-guards · allowlist gates · reply actually POSTed/PUT with right body · status counters honest · cursor persistence across adapter instances · no-creds = explicit `no-token`/`no-channels` state (never silently "running").

Three debugging folkmätningar worth archiving (all test-harness truths):
1. Cursor pollution from `paths.dirs` evaluated at import-time → tests leaked state through the REAL workspace. Fix: `cursorRoot` DI in all adapters.
2. Mock `ok: r.status < 400` = false for status-less response — mock lied about the network and looked like an adapter bug.
3. `sendMatrix` cfg contract is `channels.matrix.token` — adapter convenience fallback `accessToken` must not pretend the canonical key differs.

## Numbers
- Full `npm test`: **787 pass / 0 fail / 17 skip** (774 before round)
- Absorb artifacts: `~/.majin/workspace/absorb/{matrix-org_matrix-js-sdk,slackapi_node-slack-sdk}-capability-*.json`

## What remains (honest)
- **Live wire-out**: needs real bot tokens (discord bot + guild channel, slack xoxb + invite, matrix access token + homeserver). Cred-gated like W2-live. The receive/send roundtrip is proven offline; the gate to green live-state of v1-* (recon: live Slack/Discord) stays open until creds lands.
- Slack Socket Mode / Discord Gateway / Matrix E2EE: out of scope for zero-dep parity; status() says so.
