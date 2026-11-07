# W13 live-provider chaos — 2026-10-21T06:38:11.509Z

provider: opencode zen/go (live — model choice per-row, see facts)
recovery rate: **100%** (2 recovered + 5 controlled av 7; stuck=0)
unhandled rejections leaked: 0 · suite wall: 3782ms

invariants:
- ✓ I1_no_stuck_in_live_suite
- ✓ I2_zero_unhandled_rejections
- ✓ I3_every_row_within_bound
- ✓ I4_rate_counts_only_real_verdicts
- ✓ I5_no_api_key_in_artifacts

| scenario | verdict | wall/bound | why/facts |
|---|---|---:|---|
| baseline.real-answer-arrives | recovered | 1634/20000ms | {"verdict":"recovered","facts":{"ms":1629,"httpStatus":200,"textChars":13,"reasoningChars":539,"finishReason":"stop","usage":{"prompt":28,"completion":125,"total":153},"model":"glm-5.3-flash"}} ± |
| latency.tight-deadline-aborts-honestly | controlled | 405/3000ms | {"verdict":"controlled","facts":{"ms":405,"aborted":true,"error":{"code":"deadline_abort","message":"AbortError"}}} ± |
| abort.mid-flight-zero-leaks | controlled | 51/3000ms | {"verdict":"controlled","facts":{"ms":51,"error":{"code":"deadline_abort","message":"AbortError"}}} ± |
| auth.bad-key-plain-refusal | controlled | 115/15000ms | {"verdict":"controlled","facts":{"httpStatus":401,"code":"auth_refused","ms":114}} ± |
| model.bogus-name-refused-plainly | controlled | 113/15000ms | {"verdict":"controlled","facts":{"httpStatus":400,"code":"request_refused"}} ± |
| concurrency.burst-of-5-settles-bounded | recovered | 1187/30000ms | {"verdict":"recovered","facts":{"ms":1187,"oks":5,"refusedPlain":0,"leakedRejections":0}} ± |
| empty-messages.client-or-server-refuses-plainly | controlled | 277/15000ms | {"verdict":"controlled","facts":{"httpStatus":400,"code":"request_refused","refusedBy":"server"}} ± |
