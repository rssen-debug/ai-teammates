# MAJIN V3 dependency decisions

**Round:** initial vertical slice plus Node 22 runtime alignment · 2026-10-22.

## Added in V3

No new production package was added. V3 uses Node built-ins (`fs`, `path`, `crypto`, `http`) and internal V2 modules (`Goal`, `runVerifier`); the browser client uses native `fetch`. The root package manifest/lock engine metadata was updated to Node `>=22.0.0` because required locked dependencies declare Node `>=22`. A V3 runtime contract test, Windows guards/docs and a read-only V3 workflow accompany that compatibility change.

| Requirement | Reused component | Why it is sufficient now | License / notice |
|---|---|---|---|
| Goal state and durable receipts | `src/v2/runtime/goal.js` and `receipts.js` | Already provides legal transitions, acceptance gates and persistence. | Internal MAJIN project code; no third-party license change. |
| File verification | `src/v2/runtime/verifiers.js` | Independent file existence/size/hash verification already exists. | Internal MAJIN project code. |
| Safe local HTTP UI | Node `http`, `URL`, browser `fetch` | Loopback-only route and simple JSON request need no web framework. | Node.js runtime terms. |
| Browser E2E (future) | Existing `playwright` devDependency | Do not add another automation framework; V3 browser-rendered acceptance is not yet implemented. | Apache-2.0; preserve dependency notices in release metadata. |

## Reviewed, not adopted

- **Browser Use:** MIT; Python runtime and separate AI browser loop would overlap MAJIN's existing browser and goal code.
- **LiveKit Agents:** Apache-2.0 framework; voice plugins/model assets can carry distinct terms; Python/WebRTC architecture needs a real Windows evaluation.
- **Pipecat:** BSD-2-Clause; strong realtime pipelines but additional Python/service packaging needs justification.
- **Silero VAD:** MIT candidate; model/runtime selection, Windows packaging, Swedish and noise performance are not yet validated.
- **LangGraph:** MIT; V2 already provides a native goal/DAG/scheduler layer.
- **OpenHands:** MIT core; WSL/Docker-oriented Windows deployment adds a substantial optional-runtime cost.
- **Mem0:** Apache-2.0; vector/embedding infrastructure is not justified by a current measured requirement.

Details and source links: [`UPSTREAM_RESEARCH.md`](./UPSTREAM_RESEARCH.md).

## Runtime compatibility decision — Node 22

The installed lockfile declares Node `>=22` for `canonicalize`, `p-queue` and a transitive package, so V3 now declares `>=22.0.0` rather than advertise a Node 20 floor. The floor is aligned across `package.json`, `package-lock.json`, Windows install/build preflights, the doctor, V3 runtime guards, README/Windows docs and the new read-only V3 CI workflow. The bundled setup selects Node `22.23.2`, matching the repository's established Windows build line.

Regression coverage checks the lockfile/manifest floor, required dependency engines, runtime rejection of Node 20/21, and alignment across V3 entry points, installers, doctor, documentation and CI. Under Node `22.23.4`, the clean locked install completed without `EBADENGINE`, the full suite passed (1,186 passed, 0 failed, 19 skipped), `npm run check` parsed 452/452 files, and i18n found zero Swedish literals in 236 files. The install used `--ignore-scripts`; npm emitted a deprecated-package notice and retried a corrupt-tarball warning, then exited successfully. Windows behavior and the remote GitHub workflow remain unverified. Older V2 dependency notes and `BASELINE.md` preserve the initial Node 20 observation as historical evidence; no V1/V2 protected branch was edited.
