# MAJIN W11 desktop eval harness — verifier contract (2026-10-21)
tasks: 3 · verified: 2 · flagged: 0 · deferred (hardware-required): 1 · unverified: 0
agent lanes live: pending-hardware — declared, never fabricated
| task | env | contract | good | bad | why |
|---|---|---|---|---|---|
| notepad-write-save | simulated | verified | true | false | good end-state passes, bad end-state fails — the verifier measures the desktop state, not a story |
| rename-file-dialog-win | windows-real | deferred | — | — | hardware-required — live Windows desktop; declared, never fabricated |
| window-title-observe | simulated | verified | true | false | good end-state passes, bad end-state fails — the verifier measures the desktop state, not a story |
> 1 task(s) DEFERRED — hardware-required, declared above, never fabricated or counted.
