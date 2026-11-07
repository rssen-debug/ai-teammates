# V5 local heartbeat

The V5 chat/serve host reuses the durable core Heartbeat engine. It observes real provider-agent goal transitions: BLOCKED, FAILED, PAUSED and WAITING_USER. Starting/resuming a goal or resolving it removes stale pending alerts. Only host-generated goal IDs and generic status descriptions are copied; provider text, CV contents, passwords and URLs are not included.

Digests are delivered to a local bounded inbox (`v5-heartbeat-inbox.json`, latest 100), visible in the CLI even while it is idle. GET `/api/v5/heartbeat` reads status/inbox. POST supports status, enable, disable, preview and tick. The model receives `majin_heartbeat` when the sys lane is granted. Preview does not deliver; tick respects the five-minute quiet interval. The automatic timer checks once per minute. Disabling persists across restarts. Old inbox entries remain historical records, not claims that a goal is still blocked.

The service uses the host ownership already held by the V5 scheduler. Another host cannot start a competing writer. Corrupt state is reported and preserved. There is no external delivery, no synthetic event tool input, and no heartbeat-driven retry of a job application. It does not monitor unrelated processes or create new tasks.

## Windows start

Run `scripts/v5/start-full-cli.ps1` from PowerShell after closing the old CLI. It finds the latest source installation (or accepts `-CliRoot`), updates main without discarding tracked edits, installs dependencies, saves explicit full access, refreshes the selected provider catalog, selects a real DeepSeek ID and runs both the no-skip browser tests and the saved-account live file test before opening visible-browser chat.

Optional `-Provider deepseek` selects a saved direct DeepSeek account; `-Provider opencode-go` selects a saved Go account. `-ModelId` pins a discovered DeepSeek model. Without overrides it retains a saved DeepSeek selection or explicitly prints the catalog model selected. No key is printed or placed on a command line. The live test makes billable provider calls according to the account. These checks do not send real applications or certify every external job portal. Full MAJIN permissions do not change Windows UAC rights.
