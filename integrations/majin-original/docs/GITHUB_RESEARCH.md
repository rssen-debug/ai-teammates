# MAJIN built-in GitHub research (no separate interface)

Say in normal chat: "MAJIN, find a maintained MIT-licensed GitHub tool for Meta Ads; compare choices and tell me if any actually improve our existing implementation."

MAJIN can now use one native, read-only tool: **github.research**.

- action **search**, query words: returns live GitHub repository metadata, license, star count, recent code activity, archive status and explicit warnings. Uses the public GitHub REST API without a token for normal personal use, with rate limits.
- action **inspect**, repo owner/name: returns GitHub metadata and a bounded README excerpt, clearly labeled untrusted. Never executes README instructions.
- No extra model request is made by this tool itself, and its cache avoids repeated GitHub requests within 10 minutes. The user's usual LLM calls still consume tokens when MAJIN reasons about results or modifies code.
- No automatic clone, installation, code execution, deployment or GitHub push is performed by this tool. MAJIN has existing filesystem/shell/git capabilities for that work; major external code changes still need user permission, suitable credentials, license checks and a successful test run.
- Trendshift's **official Signal API is a separate paid service** and is deliberately NOT required. Free GitHub repository search is the default.

There are no new UI menus or panels. The normal MAJIN chat routes relevant requests to its existing tools.

This is an incremental discovery capability, **not** a verified autonomous coding-and-release system. Human review remains important for licensing, security and expensive actions.
