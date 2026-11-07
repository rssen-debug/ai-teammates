
## W13 live-provider chaos — LIVE-VERIFIED vs opencode zen/go (runda 38, 2026-10-21)

W13 var VERIFIED-CORE **/ LIVE-AGENT-SIDE PENDING**: den deterministiska recovery-matrisen bevisade maskinen mot injicerade fel; restlåset var att samma disciplin behövde gå **mot en riktig provider**. Runda 38 stängde låset: opencode-nyckeln (oc_sk_ service account) + rätt endpoint-familj = live-lane.

### Endpoint-utforskning (dokumenterad för framtiden)
- `oc_sk_` = opencode **service-account-nyckel**. Två svarande ytor:
  - `opencode.ai/console/api/v2/config` → 200, workspace-config (providers opencode + opencode-go; org org_01M3FGRWEVW4AJNQRCYXRCVNJ4).
  - `opencode.ai/zen/go/v1` → 200, OpenAI-kompatibel completions (37 modeller listade: glm-5.1–5.3, kimi-k2.6/k3, deepseek-v4, qwen3.8-max, minimax-m3, claude-haiku-5-5, gpt-5.6-luna, m.m.)
- Tidigare 404-dead-end: fel host (api.opencode.* istället för opencode.ai/zen/go).
- `x-opencode-session`-header är OBLIGATORISK — utan får du `{type:error, error:{type:MissingSessionID}}`. Nu permanent i adaptern.

### Live-mätning (två separata körningar, samma resultat)
`OPENCODE_KEY=… node scripts/live-provider-chaos.mjs --save`

| rad | verdict | mätbar sanning |
|---|---|---|
| baseline.real-answer-arrives | ✓ recovered | httpStatus 200, 13 text-chars + 714 reasoning-chars, finish_reason=stop, usage 28+173=201 tokens (RÄKEN på riktigt) |
| latency.tight-deadline-aborts-honestly | ◦ controlled | 400ms-deadline → deadline_abort vid 403-405ms — ingen hängning, ingen retry-slinga |
| abort.mid-flight-zero-leaks | ◦ controlled | 50ms-abort stannar rent (50-51ms), zero unhandled |
| auth.bad-key-plain-refusal | ◦ controlled | medvetet trasig nyckel → refusal vid ~110ms (server-side, enskilt anrop) |
| model.bogus-name-refused-plainly | ◦ controlled | bogus-modell → plain 4xx-refusal ~110ms |
| concurrency.burst-of-5-settles-bounded | ✓ recovered | 5 parallella → ALLA 5 ok, leakedRejections=0, ~1s |
| empty-messages.client-or-server-refuses-plainly | ◦ controlled | guard finns (server-side), refusal högljudt |

**rate=100% (2 recovered + 5 controlled av 7), stuck=0, unhandled=0 — vid båda körningarna.**

### Maskineniar + hygiene
- `src/core/live-provider-chaos.js` (majin-live-provider-chaos/1): radfabrik offline-kontraktstestbar via injektionspunkt `call()` (offline-suite 6/6 bevisar dommergeringen: STUCK vid latens, controlled vid refusal, recovered vid faktiska token).
- apiKey **läses ur ENV, skrivs aldrig** — evidential audit I5: den riktiga nyckeln `oc_sk_5e0bbe5...` != 0 förekomster i artifacts (assertat); även chaos-nyckeln är maskad.
- Invariants: no-stuck i live-sviten ✓, zero unhandled ✓, alla rader inom bound ✓, rate räknar bara riktiga verdicts ✓.
- i18n: svenska strängar i levererad kod fångade av i18n-suiten under rundan — översatta före push.
- Kostnad: bytade som engerade sviten möter är token-spetsarna (usage ovan); Sandbox-egress tillåter opencode.ai utan extra regler.

### Kvarvarande ärlig restpunkt
Denna lane bevisar W13:s live-sida mot **en** provider (opencode zen/go, modell glm-5.3-flash). GLM-QA 25→33-scenarierna ägs av din parallella agent (separat credential-spår, inte samma som denna lane). STATUS-raden uppdateras: VERIFIED-CORE + LIVE-AGENT-SIDE **VERIFIED (opencode zen/go)** / GLM-QA-axel pending (other-cred).
