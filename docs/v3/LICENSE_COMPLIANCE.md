# MAJIN V3 license compliance — initial inventory

**Status:** No third-party source or model weights vendored by the V3 changes in this round.

## Project and selected dependencies

- MAJIN repository manifest declares `MIT` (`package.json`). V1/V2 notices and existing dependency inventory remain authoritative until reviewed for the V3 release artifact.
- V3-specific source files are newly authored in this branch and import internal V2 code; no third-party file or copied algorithm implementation was added.
- Existing `playwright` devDependency is Apache-2.0. It is already in the package manifest; this round adds no new dependency and does not vendor its source or browser binaries.
- Other existing production dependencies and upstream decisions are documented in `docs/v2/DEPENDENCIES_AND_LICENSES.md`. Re-run the dependency/license generator against the final lockfile before release.

## Research-only candidates

| Project | License observed | Incorporated? | Required action if later integrated |
|---|---|---:|---|
| Microsoft Playwright | Apache-2.0 | Existing devDependency only | Keep Apache license/notice in distribution; recheck transitive/browser assets. |
| browser-use | MIT | No | Include MIT notice if code is copied or redistributed; review hosted-service terms separately. |
| LiveKit Agents | Apache-2.0 framework; model licenses may differ | No | Record exact plugins, bundled models and separate model terms. |
| Pipecat | BSD-2-Clause | No | Preserve copyright and BSD conditions; review any copied third-party service code. |
| Silero VAD | MIT | No | Preserve code notice and separately verify model/weight terms and hashes. |
| LangGraph | MIT | No | Preserve notice if code is copied; audit any separate server/API components independently. |
| OpenHands | MIT core (verify subdirectories/releases) | No | Recheck exact repository path, release, optional components and Docker images. |
| Mem0 | Apache-2.0 | No | Review optional stores, provider clients and all transitive licenses. |

## Release gate

Before publishing V3: regenerate an SBOM/license report from the exact lockfile and packaged artifact; include required MIT/Apache/BSD notices; identify bundled model weights and browser binaries; scan for secrets and unlicensed copied content; ensure the published docs accurately describe platform constraints. This file is an initial inventory, not a legal opinion.
