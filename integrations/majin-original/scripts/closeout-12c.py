# Closes the matrix when the v1.0.0 acceptance + gate walkthrough are green.
import json
p = 'docs/COMPLETION_MATRIX.md'
src = open(p).read()
old12c = None
for line in src.split('\n'):
    if line.startswith('| 12C |') and 'UNVERIFIED' in line:
        old12c = line
assert old12c, '12C row not found in UNVERIFIED state'
new12c = ("| 12C | 1 | Release candidate passes all mandatory integration gates | "
 "Release-gate walkthrough on v1.0.0 2026-10-20: local checks GREEN (version-literals ×7, five-way matrix 100, checkpoint ancestor-verified, secret hygiene) + online checks GREEN (v1.0.0 release published with MAJIN-Setup.exe 17,403,368 B + majin-win-x64.exe 60,830,679 B + sha256 verified) + CI build-exe check/exe green (run 39395866901) + ui-acceptance-browser green ×2 + win-acceptance-install v1.0.0 verdict all-green (sha256, silent install, first-run version, update-preservation, kill-recovery) + npm test 535/0 "
 "| OK | release-gate --online | PASS | 2026-10-20 |")
src = src.replace(old12c, new12c)
src = src.replace('**Score so far: 99 / 100**', '**Score so far: 100 / 100**')
src = src.replace('| **TOTAL** | **100** | **99** |', '| **TOTAL** | **100** | **100** |')
src = src.replace('| 12. Final Acceptance | 3 | 2 |', '| 12. Final Acceptance | 3 | 3 |')
src = src.replace('## DEL 12 — Final Real-World Acceptance (2/3)', '## DEL 12 — Final Real-World Acceptance (3/3)')
src = src.replace('## Current frontier (remaining 1 unearned point, by row)', '## Current frontier (ALL 100 ACCEPTANCE POINTS EARNED)')
src = src.replace('**Audit 2026-10-20 — closing recount after all evidence waves: exactly 1, not 19.**',
 '**Audit 2026-10-20 — CLOSED: 100/100.** Every assertion row is PASS with reproducible evidence.')
src = src.replace('One UNVERIFIED assertion row: 12C(1) = 1 = 100 − 99.',
 'Zero UNVERIFIED rows. 100 = 100 − 0.')
src = src.replace('- **12C (1)** — release candidate passes ALL mandatory integration gates — the final row;\n  closed only when the candidate has re-passed every gate as one coherent release.',
 '- ~~**12C (1)**~~ — CLOSED 2026-10-20: v1.0.0 release-candidate passed every mandatory gate; see row + docs/RELEASE_CANDIDATE_V1.md.')
src = src.replace('Executive summary: exactly one owner-level gate remains — the release-candidate walkthrough itself.',
 'Executive summary: COMPLETE. The 100-point contract is earned with reproducible evidence on 2026-10-20; v1.0.0 is the release.')
open(p, 'w').write(src)
print('12C closed → 100/100 staged')
