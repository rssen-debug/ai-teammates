# MAJIN Marketing Autopilot (Meta Ads, analysis only)

Built into MAJIN: no Python process, no paid MCP service, no additional LLM calls just to compute campaign economics. The optimizer itself is deterministic.

## Connect directly in chat (no panels)

1. Select your MAJIN AI provider and model once, using the normal onboarding.
2. Say **"MAJIN, optimize my Facebook ads"** (or an equivalent explicit marketing task in Swedish).
3. If Meta is not connected, MAJIN asks for only the required data **in the chat** and shows a temporary secure connection form next to your conversation. Nothing is permanently added to the sidebars, settings or header.
4. Enter your Meta ad account ID, its actual currency, a Marketing API token with **ads_read** permission, your product sale price, costs and an advisory daily budget. Tap **Connect & analyze**. MAJIN resumes your original request automatically.

**Important:** Never paste an API key into the chat composer. The contextual token field sends it to MAJIN's authenticated local configuration API, not to the language model or chat history. As with MAJIN provider keys, saved tokens are local but **not encrypted**. You can also set environment variable MAJIN_META_ACCESS_TOKEN for the MAJIN process instead of pasting a token; the default config refers to it.

Costs, selling price and ad spend must use the **same currency**. Convert before entering them if your shop sells in SEK while your ad account bills in USD. Connection settings are not proof that Meta accepted the token; the first actual analysis verifies API access.

No AI-token usage is needed for the first-use question or for calculating the marketing metrics. The selected AI model is used only for reasoning about the analysis and other normal MAJIN tasks.

## 50 SEK example: zero-spend-first, no new UI

Say in the normal MAJIN chat: **"Help me market wearmeoften.com with a TOTAL budget of 50 SEK. Start with free ways to get real orders, then tell me what you would need before testing ads."**

The new read-only `marketing.plan` tool constructs a seven-day organic-first experiment, computes break-even cost-per-order from real unit economics when known, identifies missing facts, and preserves the full 50 SEK when a meaningful paid test cannot be justified. It does not use any additional LLM requests itself. MAJIN can use your already-selected provider to write marketing copy or explain findings, but those ordinary model calls can still cost tokens. Ad spend and provider tokens are **separate costs**.

A single purchase with positive margin might mathematically recover 50 SEK of ad spend, but the purchase is **not guaranteed**, and such a tiny result does not validate an advertising algorithm. Prices, currency and cost assumptions are user-reported until verified.

No automatic campaign creation or budget changes are exposed. "50 SEK maximum" is a proposed **TOTAL** experiment allowance, not a daily Meta cap. To restrict actual billing, set limits inside Meta Ads Manager.

## Chat tools

- **marketing.plan** — build a conservative 0- or 50-SEK total-budget launch plan, organic creative tests, conversion checklist, meaningful shopping metrics and evidence gates. No Meta API key required.
- **marketing.status** — show connection and settings without secret values.
- **marketing.analyze** — fetch last-7-day Meta Ads Insights and compute campaign CPA, after-spend attributed contribution, conservative recommendations and a comparison to the advisory daily spend ceiling.

The Meta Insights calculations are available inside the chat. No separate marketing panel. Meta Graph Marketing API v23.0, max five pages and 20-second request timeout.

## What profit-first really means

Contribution/order = selling price × (1 − expected refund fraction) − product/fulfillment costs − shipping − fees.

Break-even CPA = contribution/order. Target CPA holds back a minimum profit reserve (at least 20% of contribution). Decisions:

- **collect_data** — low sample; do not pretend certainty
- **review_tracking_or_pause** — significant spend and zero Meta-attributed purchases
- **review_loss** — enough attributed purchases but CPA is above margin
- **hold_and_verify** — inconclusive evidence
- **scale_candidate** — enough purchases and conservative CPA signal suggest a small *10% increase for manual consideration only*

ALL results are **read-only recommendations**, not verified profit. Meta pixel attribution can lag, duplicate or disagree with real WooCommerce orders, refunds and chargebacks. Purchase action types are prioritized, not summed. Estimated contribution is not confirmed net profit or true incrementality.

**No campaigns, bids or budgets are written.** The daily ceiling is advisory only, NOT an enforced Meta Ads budget. Set campaign/account spending caps independently in Meta Ads Manager. Any future write actions need explicit human approval, tested diff/rollback and audit logging. No automatic scaling loop runs.

## TikTok and Google Ads in the same chat (read-only)

Ask **"MAJIN, analyze my TikTok Ads"** or **"MAJIN, analyze my Google Ads."** No new sidebar panels are added. If the account is not configured, a contextual secure form appears in the chat; never paste tokens into a normal conversation.

- **TikTok Ads**: provide an authorized TikTok Business API access token, numeric advertiser ID and actual account currency. Uses TikTok's public Business Reporting API v1.3 (campaign-level spend, clicks, impressions). The currency is USER-REPORTED and not verified through the TikTok API, so comparisons across accounts require separate verification.
- **Google Ads**: provide numeric customer ID, developer token from Google Ads Manager, authorized OAuth access token, account currency and optional manager login customer ID. Uses Google Ads REST API v25. Unlike an LLM provider API key, Google Ads requires its OWN Google developer token plus OAuth; **access tokens expire** and this implementation does NOT automatically perform the full OAuth authorization/refresh flow. You must obtain/refresh authorized credentials separately. The Google report requests a currency code for verification, and refuses mismatches.
- The new `marketing.channel_report` tool fetches campaign spend/clicks/impressions; Google reported conversions are NOT necessarily purchases and must NOT be presented as confirmed WooCommerce profit. The report is bounded to a few pages and always read-only.
- Both APIs require developer/account approval and reporting permissions. CI tests use mocked HTTP responses; a live test requires the user's real approved accounts. No new third-party npm package, background Python process, paid MCP subscription, or extra LLM request for metric calculation is required.
- The existing MAJIN provider is used for *explaining* reports and generating marketing ideas, not for authenticated Google/TikTok API access.
- Privacy: the contextual secure form sends token values to local authenticated MAJIN config, never to model messages. Local config remains unencrypted on disk; using a dedicated secret vault would be preferable in a future release.
- No cross-platform ROAS or automatic "best winner" claims until WooCommerce orders, currency conversion and attribution are independently reconciled. The total budget of 50 SEK remains an advisory cash constraint; no ad campaigns are created, altered or billed by these tools.

Upstream API documentation: https://github.com/tiktok/tiktok-business-api-sdk and https://github.com/Opteo/google-ads-api. MAJIN uses the native Node HTTP primitives rather than bundling bulky SDK dependencies; the implementations follow those published endpoint contracts.

## Known gaps

- No WooCommerce reconciliation, refund sync, checkout tracking diagnosis or multichannel attribution yet.
- Live Meta access is not verifiable in CI without your Meta access token/account; automated tests use a controlled stand-in.
- Missing or mismatched Meta currency blocks recommendations.
- Daily cap is not a hard spend limiter.

Sources: src/core/marketing.js, src/core/tools/marketing.js, src/ui/marketing.js; test/marketing.test.js.
