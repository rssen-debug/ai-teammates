#!/usr/bin/env python3
"""Turn the acceptance harness's JSON report into GitHub Actions annotations.

Why this exists: GitHub caps a check run at ten error annotations, so the budget has
to be spent on the lines that decide the build. Two runs of this workflow were
undecidable because the budget went to scenario *headings* — "1. Fresh installation",
"2. Upgrade…", "3. Python detection" — and the one FAIL line, plus the four problems
the installer actually reported, never reached the API. The printed detail did not
help either: the harness clips it to 220 characters, and a joined list of Windows
paths does not fit in that.

So this reads the report the harness writes and emits, in priority order:

  1. the summary counts,
  2. every FAIL with its unclipped detail and its fix,
  3. the BLOCKED and NOT TESTED scenarios, which are honest gaps but never failures.

Usage:  python .github/acceptance_annotations.py <evidence-dir>/acceptance-report.json

Exit status is 0 when annotations were emitted, 1 when the report could not be read —
the workflow falls back to grepping the raw output in that case. It never fails the
build; deciding FAIL versus BLOCKED belongs to the workflow's judgement step.
"""
from __future__ import annotations

import json
import pathlib
import sys

#: GitHub stops recording error annotations past ten per check run. One slot is used
#: by the "acceptance.py exited N" line the workflow emits first.
LIMIT = 9


def _msg(text: str) -> str:
    """Make a string safe to put in a `::error::` workflow command.

    A newline would end the command and leak the rest into the log as plain text, and
    GitHub reads `%XX` in a message as a URL escape, so a literal percent sign —
    common in these details — has to be escaped as %25.
    """
    return (str(text).replace("\r", " ").replace("\n", " ")
            .replace("%", "%25"))


def build_lines(doc: dict) -> list[str]:
    rows = doc.get("results") or []
    lines = [f"SUMMARY {doc.get('counts')} complete={doc.get('complete')} "
             f"platform={doc.get('platform')} python={doc.get('python')}"]
    for row in rows:
        if row.get("status") == "FAIL":
            lines.append(f"FAIL {row.get('num')}. {row.get('name')}: {str(row.get('detail', ''))[:500]}")
            for key in ("unproven", "fix"):
                if row.get(key):
                    lines.append(f"FAIL {row.get('num')}. {key}: {str(row[key])[:200]}")
    for row in rows:
        if row.get("status") not in ("PASS", "FAIL"):
            lines.append(f"{row.get('status')} {row.get('num')}. {row.get('name')}: "
                         f"{str(row.get('detail', ''))[:160]}")
    return lines[:LIMIT]


def _force_utf8_output() -> None:
    """Details come from the harness and can contain \u2717 or \u25cf.

    A stock Windows console is cp1252, so printing one raises UnicodeEncodeError and
    the annotations — the only diagnostic channel that reaches a developer working
    from a sandbox — would be lost exactly when they are needed. Same discipline as
    `buddy.force_utf8_output()`.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main(argv: list[str]) -> int:
    _force_utf8_output()
    if len(argv) < 2:
        print("::error::acc| no acceptance report path was given")
        return 1
    report = pathlib.Path(argv[1])
    if not report.is_file():
        print(f"::error::acc| no acceptance report at {report}")
        return 1
    try:
        doc = json.loads(report.read_text(encoding="utf-8"))
    except Exception as e:  # a half-written report must not take the step down
        print(f"::error::acc| could not read {report}: {type(e).__name__}: {e}")
        return 1
    for line in build_lines(doc):
        print("::error::acc| " + _msg(line))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
