"""OMEGA V5 Decision Engine: deterministic, bounded and evidence-grounded.

It ranks possible observation/discovery tools, not permissions or direct actions.
No LLM inference, goal persistence, API calls or cost escalation. A recommendation
never executes anything; executor and model must still verify the live state.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

PATTERNS = {
    "web": (r"https?://", r"\b(url|website|webb|hemsida|browser|chrome|sajt|web page|länk|link|streaming)\b"),
    "desktop": (r"\b(windows|desktop|outlook|skärm|fönster|screen|button|knapp|app|program|klicka|click)\b",),
    "code": (r"\b(python|code|kod|script|skript|bugg|debug|repo|github|git|test|implement|build)\b",),
    "file": (r"\b(file|fil|folder|mapp|document|dokument|readme|pdf|xlsx|docx)\b",),
}
CATEGORY_TOOLS = {
    "web": ("browser_context", "browser_dom", "web_search", "tool_search"),
    "desktop": ("desktop_context", "screen_observe", "desktop_windows", "tool_search"),
    "code": ("tool_search", "file_list", "file_read"),
    "file": ("file_list", "file_read", "tool_search"),
}
ROLE_FOR_DOMAIN = {"web": "computer", "desktop": "computer",
                   "code": "coding", "file": "planner", "chat": "chat"}
OBSERVE_REASON = {
    "web": "Inspect real URL and page contents before answering or acting",
    "desktop": "Refresh target window and accessibility state before clicking",
    "code": "Inspect code and available test tools before editing",
    "file": "Discover exact file and inspect content before changing it",
    "chat": "Answer directly; no computer tool is required unless facts need verification",
}

@dataclass(frozen=True)
class Decision:
    domain: str
    role: str
    reason: str
    proposed_tools: tuple[str, ...]
    available_tools: tuple[str, ...]
    missing_tools: tuple[str, ...]
    confidence: str
    failure_hint: str = ""

    def prompt(self) -> str:
        if self.domain == "chat":
            return "V5 DECISION: Plain conversation; answer directly and do not invent computer observations."
        tools = ", ".join(self.available_tools) or "none available"
        missing = ", ".join(self.missing_tools) or "none"
        return (f"V5 DECISION (bounded discovery recommendation; not permissions): "
                f"domain={self.domain}; role={self.role}; certainty={self.confidence}. "
                f"Reason: {self.reason}. Available observation/discovery tools: {tools}. "
                f"Unavailable/unloaded suggested tools: {missing}. "
                "If required tools are not loaded, use tool_search and check their real availability; "
                "never claim a tool ran from this plan. "
                + (f"Prior failure: {self.failure_hint}. " if self.failure_hint else "")
                + "Observe -> act within permissions -> verify independent outcome.")


def _domains(goal: str) -> list[str]:
    text = str(goal or "")[:1600].casefold()
    matches = []
    for domain, patterns in PATTERNS.items():
        if any(re.search(p, text, re.IGNORECASE) for p in patterns):
            matches.append(domain)
    return matches


def decide(goal: str, available_tools: Iterable[str] = (),
           failures: Iterable[str] = (), tool_status: dict | None = None) -> Decision:
    """Deterministic, no side effects, no model/cost/permission changes.

    Status values must be real booleans. Unknown status counts as unavailable.
    """
    domains = _domains(goal)
    domain = domains[0] if domains else "chat"
    available = set(str(x) for x in available_tools)
    statuses = tool_status or {}
    expected = CATEGORY_TOOLS.get(domain, ())
    ready = tuple(x for x in expected if x in available and statuses.get(x) is True)
    missing = tuple(x for x in expected if x not in ready)
    failed = set(str(x) for x in failures)
    hint = ""
    if domain != "chat" and ready:
        affected = [x for x in ready if x in failed]
        if affected:
            hint = "Previous attempt failed using " + ", ".join(affected) + "; refresh observation and vary the approach"
    # Only an exact, available observation/discovery tool is recommended.
    return Decision(
        domain=domain, role=ROLE_FOR_DOMAIN[domain],
        reason=OBSERVE_REASON[domain], proposed_tools=expected,
        available_tools=ready, missing_tools=missing,
        confidence="heuristic" if domains else "no_task_signal",
        failure_hint=hint,
    )


def compare_strategies(cases: Iterable[dict]) -> dict:
    """Comparable fixed-case A/B evaluation. Missing outcomes never count as wins."""
    rows = list(cases)
    if not rows:
        return {"cases": 0, "baseline_verified": 0, "candidate_verified": 0,
                "regressions": 0, "promote": False}
    baseline = candidate = regressions = 0
    for row in rows:
        b = row.get("baseline") is True
        c = row.get("candidate") is True
        baseline += int(b)
        candidate += int(c)
        regressions += int(b and not c)
    return {"cases": len(rows), "baseline_verified": baseline,
            "candidate_verified": candidate, "regressions": regressions,
            "promote": bool(candidate > baseline and regressions == 0)}
