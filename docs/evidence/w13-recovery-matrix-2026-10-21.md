# W13 never-stuck recovery matrix — 2026-10-21T02:15:00.186Z

recovery rate: **100.0%** (7 recovered + 8 controlled of 15 executed; 0 excluded as not_tested)
unhandled rejections leaked: 0 · suite wall: 964ms

invariants:
- ✓ I1_no_stuck_in_deterministic_suite
- ✓ I2_zero_unhandled_rejections
- ✓ I3_every_row_within_bound
- ✓ I4_rate_counts_only_real_verdicts

| scenario | verdict | wall | why/facts |
|---|---|---:|---|
| swarm.transient-retry-recovers | recovered | 2ms | {"verdict":"recovered","facts":{"tries":2,"okCount":1,"sawRetry":true}} |
| swarm.permanent-fail-blocks-dependents | controlled | 1ms | {"verdict":"controlled","facts":{"failCount":1,"okCount":1,"bBlocked":true,"bReason":"dependency a failed"}} |
| swarm.bad-input-rejected-plainly | controlled | 0ms | {"verdict":"controlled","facts":{"depErr":"node x: unknown dep \"ghost\"","cycErr":"nodes: cyclic graph"}} |
| swarm.deadline-marks-remaining | controlled | 201ms | {"verdict":"controlled","facts":{"wallMs":201,"blocked":2}} |
| swarm.abort-signal-cancels-honestly | controlled | 251ms | {"verdict":"controlled","facts":{"wallMs":251,"cancelled":true}} |
| swarm.adaptive-overrun-contracts-and-completes | recovered | 243ms | {"verdict":"recovered","facts":{"okCount":6,"adaptations":2,"sawOverrun":true}} |
| swarm.critical-tail-first-launch-order | recovered | 1ms | {"verdict":"recovered","facts":{"order":["tail-large","tail-mid","tail-small"]}} |
| watchdog.tool-timeout-fires | controlled | 250ms | {"verdict":"controlled","facts":{"code":"tool_timeout"}} |
| watchdog.abort-deadline-parent-abort | controlled | 0ms | {"verdict":"controlled","facts":{"err":"TypeError"}} |
| watchdog.repeat-detector-flags-no-progress | recovered | 0ms | {"verdict":"recovered","facts":{"thirdCount":3,"afterReset":1}} |
| watchdog.stall-and-approval-transitions | controlled | 0ms | {"verdict":"controlled","facts":{"before":false,"after":true,"transitions":["stall:ap1","timeout:ap1"]}} |
| teams.budget-loud-then-resume-wins | recovered | 6ms | {"verdict":"recovered","facts":{"firstStatus":"partial","skipped":["g1"],"calls2":["g2"],"spentAfterResume":2} |
| teams.crash-resume-exactly-once | recovered | 3ms | {"verdict":"recovered","facts":{"firstCalls":["g1","g2"],"resumedCalls":["g2"],"okAfter":2}} |
| mission.checkpoint-carry-verified-only | controlled | 2ms | {"verdict":"controlled","facts":{"carriedKeys":["n1"],"journalLineWritten":true}} |
| classifier.transient-vs-permanent-accuracy | recovered | 0ms | {"verdict":"recovered","facts":{"checked":6,"misses":[]}} |
