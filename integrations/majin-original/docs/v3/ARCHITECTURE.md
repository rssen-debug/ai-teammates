# MAJIN V3 architecture — first vertical slice

**Status:** Initial architecture, implemented only for a deterministic local file-deliverable slice. This is not yet the full autonomous V3 runtime.

## Separation rule

- V1 source baseline: `main` at `814459ea50fc86c5ac1aeed939ec9d2344dc5bfb`.
- V2 source baseline: `v2/main` at `b2533097ca3c744fa7e9b152b221a97186507835`.
- V3 target: a separate `v3/main` line, created locally from the V2 source baseline because V2 contains the goal/receipt/verifier kernel that V3 should reuse.
- The V3 implementation is additive under `src/v3/`; it does not alter V1 or V2 implementation paths.

## Target shape

```text
MAJIN V3
  Minimal experience surface
      src/v3/ui/page.js
      src/v3/server.js  (loopback only; optional preview server)
            |
      V3 capability adapter
      src/v3/runtime/file-deliverable.js
            |
      Existing V2 kernel contracts (reused, not forked)
      Goal / state machine / receipts / file verifier
            |
      Restricted capability
      create one visible file in an explicit workspace
            |
      Independent verification
      file existence + exact SHA-256 + verified receipt
            |
      Visible result
      COMPLETED only after the V2 acceptance gate is satisfied
```

Future modules should follow the existing repository conventions and only be added when a tested capability requires them: `src/v3/{runtime,goals,planning,agents,models,tools,voice,computer,browser,memory,context,verification,security,telemetry,ui,config,platform}`.

## Implemented flow

1. Receive a structured local request containing objective, filename, content and an explicit workspace.
2. Reject invalid requests, traversal, hidden paths, reserved Windows device names, oversized content and missing workspace configuration.
3. Create a durable V2 `Goal` and persist its state checkpoints inside the workspace.
4. Execute one create-only write (`open(..., 'wx')`); no overwrite, shell, process, network action, model call or implicit directory.
5. Verify the file with V2 `runVerifier('file', ...)`, including the expected SHA-256.
6. Verify the corresponding V2 receipt and complete the goal only through its acceptance gate.
7. Render a minimal local interface and return the verified artifact name, byte count and digest.

## Trust boundaries

- The preview server binds only to loopback and rejects external Host/Origin requests; it sends no CORS permission.
- The UI serves inline CSS/JS only and uses `textContent` for result rendering.
- The API accepts JSON, limits request size and exposes no filesystem reads, generic shell or arbitrary tool registry.
- Workspace root is explicit. The initial write capability accepts only one filename level and refuses overwrites.
- A goal result is not success merely because the write call returned; a matching verified receipt is required.
- External content, model responses and future tool output remain untrusted data.

## Reuse boundary

V3 imports and composes `src/v2/runtime/goal.js` and `src/v2/runtime/verifiers.js`. It does not copy those modules, change their APIs, or toggle the V1 runtime. Existing V1 browser, computer, provider and memory capabilities are candidates to wrap behind the V3 permission/verification boundary; they are not automatically enabled by this slice.

## Known design risks

- This first feature is synchronous file I/O wrapped in an async verification contract; long tasks need cancellation, bounded timeouts and worker-safe scheduling.
- Goal persistence must be fault-injected and tested on Windows (including concurrent checkpoints) before it is used as a release durability claim.
- The server is a development preview, not yet part of the CLI/installer/update flow.
- A static/source-level UI test does not establish rendered browser accessibility or visual quality; use the existing Playwright tooling for that acceptance.
- The supported Node floor is now `>=22.0.0`, matching installed dependency engine declarations. The runtime guard and Linux Node 22 tests pass; Windows installer execution remains unverified.
