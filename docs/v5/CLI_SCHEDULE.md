# Scheduled work in the V5 CLI

Keep `node bin/majin-v5.mjs chat` or `serve` running. With the `sys` lane granted (included in `grants full`), the model receives `majin_schedule` and can add, list, pause, resume or remove scheduled tasks. The schedule runs through the same V5 provider agent, using the currently saved model and current grants. DeepSeek and OpenCode Go use the same path. It does not install a Windows service or wake a powered-off computer.

Example request: “Every day at 07:30 for the next seven runs, find new matching jobs and save a shortlist. Do not apply to duplicates.” The model selects the schedule tool and sets `maxRuns: 7`; the default is one run. Times use the computer's local timezone. Supported expressions reuse the core scheduler: `07:30 daily`, `every 30m`, five-field cron, or a local date/time.

The add result includes a verification URL. The model can register an HTTP criterion containing the returned job ID, so creating a schedule is independently verified before COMPLETED. This verifies creation, not future execution.

The HTTP host exposes GET/POST `/api/v5/schedule` with the same actions. Records live in `v5-schedule.json` in the V5 data directory and retain the corresponding V5 goal ID. Execution waits while an agent is running, paused, blocked or waiting for the owner. Revoked permissions or emergency stop prevent timer dispatch. Any result other than independently verified COMPLETED pauses that schedule; an exception also pauses it. Interrupted runs are paused after restart, never automatically replayed.

Only one host may own a data directory's scheduler. An exclusive `v5-schedule.lock` contains its PID. Normal shutdown removes it. If a host is forcibly killed, the next host reports the stale lock rather than risking duplicate execution: confirm that the recorded process is no longer running before removing that lock file. Closing chat/serve stops scheduling; launching it again loads persisted schedules. Missed intervals do not create a backlog of catch-up runs.

This supplies the V5 provider-host schedule capability; the isolated deterministic driver still cannot run a scheduler. It does not add heartbeat, remote message delivery or per-schedule provider routes. Local fixture tests prove scheduling and V5 tool execution, not a live DeepSeek account or a real employer submission.
