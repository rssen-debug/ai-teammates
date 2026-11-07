# Authorized browser submissions and PDF extraction

The deterministic browser used by both normal provider tools and CODEX DRIVER
can submit forms when the owner starts the runtime with an exact origin grant:

```sh
node bin/majin-v5.mjs serve --submit-origin https://employer.example
node bin/majin-codex-mcp.mjs --workspace ./workspace --browser --submit-origin https://employer.example
```

Repeat `--submit-origin` for each explicitly authorized origin. The Go provider
and the Codex AppServer adapter pass the same trusted runtime option into the
worker. Tool arguments and page content cannot add grants. Frame and request
origins must both be granted for a write; other writes remain blocked and their
method, origin and path appear in inspection diagnostics. No request bodies or
query strings are included in those diagnostics. A separate workspace gets a
separate persistent browser profile. Required applicant facts must come from the
owner or their documents; an uncertain submission must be checked before retry.

Inspection emits unique selectors for idless controls, checked/disabled state,
visibility and link destinations. Native radios, selects, file inputs and final
form submits are exercised by a real Chromium integration test; that test is a
local regression test, not evidence of an employer receiving an application.

The V5 document tool now recovers CID/custom-font PDF text through a pinned local
PDF.js-based parser when the basic extractor reports partial/no text. It copies
pooled buffers before parsing, preserves encrypted-document rejection and reports
image-only PDFs as needing OCR. It does not claim scanned-document support.

The autonomous acceptance script takes explicit output and document paths. Its
local portal is intentionally labelled as a test portal. Public live application
receipts and personal documents must be stored outside the source repository.
