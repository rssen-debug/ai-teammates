# MAJIN TradingAgents (optional)

User prompt in ordinary chat: **"MAJIN, I have $50 or $100, help me understand a possible investment."**

Trading is one optional skill of the general MAJIN assistant, NOT a new specialized app. No new settings screen, mandatory Python install or new third-party app subscriptions.

## Native (zero external model call) mode

- `trading.plan`: capital-sized hypothetical positions, maximum illustrative 25% exposure, no leveraged orders, five-percent-move risk illustration. Requires a user-supplied price and account fees to calculate any units, and asks which market/ticker if unspecified.
- Values such as $50/$100 represent *investment capital*, not provider/LLM budget. Provider costs, price feed subscriptions and broker fees are separate.
- It does not fetch a current quote or guarantee a stop price, and it does not place even a paper trade.
- No capital is ever allocated to a broker or spent by the native planner.

## Optional original TauricResearch/TradingAgents research

The built-in `trading.research` tool invokes the REAL TradingAgents Python `TradingAgentsGraph` through an isolated, bounded subprocess; the third-party code is not copied or automatically installed. The user can opt in by setting up Python 3.11+ and the upstream `tradingagents` distribution. See https://github.com/TauricResearch/TradingAgents (Apache-2.0 license).

- Uses the selected MAJIN tools model/provider where upstream-compatible, with one market analyst, short risk/research rounds and capped model output to reduce token usage. It can still incur substantial and varying LLM/data costs, and may need upstream vendor/API configuration.
- Supported bridge providers: DeepSeek, OpenAI, Anthropic, OpenRouter, Google/Gemini, Ollama, plus custom OpenAI-compatible endpoints. Unsupported providers return an explicit error, not a silent expensive fallback.
- Subprocess has a strict time limit, bounded output and explicit marker fields `mode=RESEARCH_ONLY`, `ordersPlaced=0`, `brokerConnected=false`.
- The upstream Python package needs local availability to run. Its external services, market-data reliability and dependencies are NOT tested in GitHub CI against live user accounts.
- Upstream buy/sell/hold recommendations are model-generated **research**, not a proven profitable strategy. Backtesting must use out-of-sample data, realistic spreads, commissions and slippage. Even favorable historical results don't guarantee future profit.
- No broker API exists in this integration. It cannot execute a live order, cannot buy/sell by itself and does not silently install an exchange/broker tool.

## Next phase before live broker execution

A separate broker API integration, secure connection/onboarding, independent audited exchange order preview and order-by-order explicit user confirmation, maximum daily cash loss, exchange/market restrictions, real paper fills with costs, separate FX support, safe cancel/failsafes and a long paper-trading evaluation would be required.

The main architecture goal is a universal AI agent whose specific capabilities appear through the same simple chat. Users shouldn't have to see specialized technical control panels.
