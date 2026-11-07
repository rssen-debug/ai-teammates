# Local owner full access

Run `node bin/majin-v5.mjs grants full` once in the same data directory used by chat.
This explicit local command persists all 23 lanes, existing Windows drive roots (the filesystem root on Unix), and `*` for HTTP(S) browser writes. It does not elevate the OS account. The model and the remote access API do not expose this grant operation.

`grants revoke` revokes all persisted permissions. `grants browser-origin clear` removes browser write authority; running browser tools reread it. Ordinary `grants grant --all-lanes` retains folder/exact-origin semantics. Start a new chat after changes to filesystem/lane grants.

Full access is tool authority, not a replacement for task instructions. Login, MFA, CAPTCHA, provider credentials, runtime dependencies and OS restrictions still apply.

Run `node scripts/v5/owner-cli-accept.mjs` on the owner's machine to test the exact saved OpenCode Go model against the installed CLI. This makes real provider calls using the locally saved credential, creates isolated fixture files and verifies their contents. It does not submit a real application. The existing acceptance runner cleans its temporary credential state. A missing configuration exits with NOT VERIFIED rather than passing. No automatic model substitution is allowed by this wrapper.

The provider now reports MODEL_TOOLS_UNAVAILABLE when saved metadata explicitly disables tools, instead of silently sending an empty tool catalog. Refresh with `model verify --provider opencode-go` if metadata is stale; do not manufacture tool support for an incompatible model.

The owner acceptance runner supports the saved `opencode-go` or direct `deepseek` provider. It pins the saved model, uses that provider’s saved endpoint and key locally, and never substitutes a different model. A local fake-endpoint test verifies CLI plumbing only; run `node scripts/v5/owner-cli-accept.mjs` to test your actual saved account. This file smoke test does not certify every job portal.
