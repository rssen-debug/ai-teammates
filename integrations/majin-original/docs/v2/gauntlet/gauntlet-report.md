# MAJIN GAUNTLET — report

- run: 2026-10-22T06:21:30.395Z
- scenarios: 10 | passed: 10 | failed: 0
- verified success rate: 100%
- false successes: 0

| scenario | verdict | goal state | receipts (verified) | time |
|---|---|---|---|---|
| G1 create+verify file | PASS  | COMPLETED | 2 (1) | 4ms |
| G2 serve+verify http | PASS  | COMPLETED | 2 (1) | 37ms |
| G3 pixel evidence | PASS  | COMPLETED | 2 (1) | 5ms |
| G4 transient failure recovery | PASS recovered via policy retry | COMPLETED | 3 (1) | 251ms |
| G5 honest blocking (no fake success) | PASS failure propagated, deploy never executed | FAILED | 1 (0) | 0ms |
| G6 objective: portfolio website | PASS  | COMPLETED | 2 (1) | 9ms |
| G7 objective: honest blender FAIL | PASS honest FAILED with uncovered acceptance reported | FAILED | 1 (0) | 2ms |
| G8 objective: research report | PASS  | COMPLETED | 2 (1) | 1ms |
| G9 objective: bare "photo" clarity fallback | PASS  | COMPLETED | 2 (1) | 1ms |
| G10 objective determinism x3 same workspace | PASS  | COMPLETED | 4 (1) | 10ms |
