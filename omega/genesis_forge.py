"""Genesis V4: automatic, safe draft promotion from repeated verified patterns.

No model calls, no executable automation generated from untrusted experience.
This creates a deterministic, read-only advisory skill using Buddy's existing
Skills.propose/test lifecycle. Activation still requires explicit owner approval.
"""
from __future__ import annotations

import hashlib
import json

from genesis_playbooks import PlaybookStore


def safe_advisory_source(candidate: dict) -> str:
    """Statically generated Python, no interpolation of untrusted source code."""
    tools = candidate["tools"]
    if not isinstance(tools, list) or not tools:
        raise ValueError("no tool pattern")
    payload = {
        "category": candidate["category"],
        "pattern": tools,
        "verified_runs": int(candidate["verified_runs"]),
        "warning": "Advisory only. Re-observe, seek permission and independently verify. Nothing executed.",
    }
    literal = repr(payload)
    return ("def run(args: dict) -> dict:\n"
            "    # Read-only reference skill; no filesystem or network actions.\n"
            "    return " + literal + "\n")


def forge_once(app, minimum: int = 3) -> dict:
    """At most one deterministic tested draft; no activation or model spending."""
    if (getattr(app, "shutting_down", False)
            or getattr(getattr(app, "privacy", None), "private", False)
            or not app.settings.get("accelerator_auto", True)):
        return {"created": 0, "reason": "private, disabled or stopping"}
    if getattr(app, "current_run", None) or getattr(app.tasks, "current", {}):
        return {"created": 0, "reason": "owner task has priority"}
    if getattr(app.tasks, "paused", False):
        return {"created": 0, "reason": "autopilot paused"}
    if app.store.one("SELECT id FROM tasks WHERE state IN ('queued','running') LIMIT 1"):
        return {"created": 0, "reason": "user work queued"}

    candidates = PlaybookStore().forge_candidates(min_verified=minimum, limit=5)
    existing = {row["name"] for row in app.skills.list()}
    for candidate in candidates:
        name = "genesis_" + candidate["category"].lower() + "_" + candidate["signature"][:10]
        if name in existing:
            continue
        script = safe_advisory_source(candidate)
        # An immutable deterministic source is reviewed through existing gates.
        proposal = app.skills.propose(
            name, "Evidence-based, read-only tool-sequence reference",
            {"type": "object", "properties": {}, "additionalProperties": False},
            script, risk="read_only_advisory")
        tested = app.skills.test(name, proposal["version"], {},
                                 expect_contains="Advisory only")
        if tested.get("passed") is True:
            return {"created": 1, "name": name, "status": "tested",
                    "verified_runs": candidate["verified_runs"],
                    "note": "Draft is NOT active; owner approval still required"}
        return {"created": 1, "name": name, "status": "failed",
                "reason": "generated draft did not pass isolated test"}
    return {"created": 0, "reason": "no new evidence-gated candidates"}
