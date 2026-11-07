# Terminal appearance

Interactive chat defaults to a compact terminal view. It shows the selected
model, current tool actions, errors and verification, followed by one final
answer and a small usage summary. Successful tool rows and streamed answer
fragments are not repeated. Detailed trace data continues to be persisted.

- `/details` toggles compact and detailed live output without a model call.
- `/logs` displays full result, tool outcomes, verification and trace.
- `/clear` clears the view only. Idle `cls` and `clear` are local aliases.
- `--verbose` starts with the previous detailed output.
- `--compact` explicitly enables the new view, including when piping output.
- `--json` and noninteractive default output retain their existing contracts.
- `NO_COLOR` disables heading color; non-TTY output has no ANSI styling.

The renderer strips terminal control sequences from dynamic compact content.
PARTIAL is explicitly not final-verified; action success is not represented as
proof of task completion. Input remains editable during live activity.
