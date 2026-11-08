"""The always-on layer — STUDDY BUDDY OMEGA companion.

Until now the product was a conversation you start. This is the part that runs
whether or not you are looking at it: it watches what you do, builds a model of
you, thinks on a schedule inside a hard budget, and can act without being asked.

Four pieces, in the order they depend on each other:

    TrustPolicy        may it act without asking?
    ObservationPolicy  what is it allowed to see?
    UserModel          what has it learned about you?
    CompanionLoop      the 24/7 scheduler tying them together

Rules that are not policy knobs
-------------------------------
1. Full trust is an owner decision, made once, out loud, and revocable. It is
   never a default and never inferred: `activate()` requires a typed phrase and
   writes an audit row every time it is used.
2. Third-party actions confirm in EVERY mode, including full. Sending a message
   as you, paying, or submitting an application affects someone who never agreed
   to be affected by an autonomous agent. Owning the machine does not extend to
   the people at the other end of it.
3. Observation has a visible indicator and a working off switch. Capture that
   cannot be seen cannot be trusted, not even by its owner.
4. The reflection budget is enforced, not advisory. "Thinking 24/7" against a
   hosted model is a metered cost; the loop must run indefinitely without being
   able to produce an unbounded bill.
5. Anything this host cannot do reports BLOCKED with the real reason. This module
   is developed on Linux with no display and no API key. It says so rather than
   simulating success — the level system already treats a silent gap as a lie.

Talking to other models
-----------------------
`CompanionLoop.consult()` gets a second opinion from another model role through
the gateway the product already uses. It does not drive claude.ai or
chatgpt.com in a browser: that breaks those vendors' terms, breaks again at every
one of their redeploys, and cannot be audited. The API gives the same
conversation, stably, with usage accounted for.

Nothing here imports `buddy` at module level. Every collaborator is injected, so
the whole layer is testable with fakes and cannot create an import cycle.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

__all__ = [
    "THIRD_PARTY_ACTIONS", "DESTRUCTIVE_ACTIONS", "TrustDecision", "TrustPolicy",
    "ObservationPolicy", "ScreenBackend", "UserModel", "ReflectionBudget",
    "CompanionLoop", "BLOCKED_NO_DISPLAY", "BLOCKED_NO_KEY",
]


def _now() -> float:
    return time.time()


async def _await(coro: Any) -> Any:
    return await coro


def _jdump(o: Any) -> str:
    return json.dumps(o, ensure_ascii=False, default=str)


BLOCKED_NO_DISPLAY = "no screen-capture backend on this host"
BLOCKED_NO_KEY = "no API key configured, so reflection cannot call a model"


# ════════════════════════════════════════════════════════════════════════════
# Trust — may it act without asking?
# ════════════════════════════════════════════════════════════════════════════

#: Confirm in every trust mode. These reach other people or other people's money.
THIRD_PARTY_ACTIONS = frozenset({
    "send_message", "send_email", "reply_as_owner", "post_public", "comment_public",
    "submit_application", "payment", "transfer", "purchase", "subscribe",
    "chat_as_owner", "contact_person",
})

#: Irreversible on the owner's own machine. Full trust does not refuse these — it
#: routes them to a recoverable equivalent, because the cost of that is one extra
#: step and the cost of being wrong is everything.
DESTRUCTIVE_ACTIONS = frozenset({"delete_permanent", "format", "wipe", "shred", "drop_database"})

#: Where a destructive action goes instead, when one exists.
RECOVERABLE_REDIRECT = {
    "delete_permanent": "trash",
    "wipe": "trash",
    "shred": "trash",
    "drop_database": "backup_then_drop",
    "format": "",          # no recoverable equivalent — this one still confirms
}


@dataclass
class TrustDecision:
    """What the trust layer decided about one action.

    `allowed` is whether it may happen at all. `ask_first` is whether a human has
    to say yes first. They are separate because the interesting cases are the ones
    where an action is allowed but must still be confirmed.
    """
    allowed: bool
    ask_first: bool
    reason: str
    redirect: str = ""

    def to_dict(self) -> dict:
        return {"allowed": self.allowed, "ask_first": self.ask_first,
                "reason": self.reason, "redirect": self.redirect}


class TrustPolicy:
    """Owner-set autonomy level, with a floor that autonomy cannot remove.

    Two modes:
      normal — the existing behaviour. Scopes ask until you set them to 'always'.
      full   — acts on your own machine without asking.

    `full` is deliberately awkward to turn on: it needs the exact phrase, and it
    records who asked and when. That is not ceremony. A setting that can be
    flipped by accident is a setting that will be, and the audit row is the only
    way to answer "why did it do that" afterwards.
    """

    MODES = ("normal", "full")
    CONFIRM_PHRASE = "I take responsibility"
    SETTING = "trust_mode"

    def __init__(self, settings: Any, perms: Any = None,
                 audit: Optional[Callable[[str, str, str], None]] = None) -> None:
        self.cfg = settings
        self.perms = perms
        self._audit = audit

    # ── state ──
    @property
    def mode(self) -> str:
        m = str(self.cfg.get(self.SETTING, "normal") or "normal").lower()
        return m if m in self.MODES else "normal"

    @mode.setter
    def mode(self, value: str) -> None:
        if value not in self.MODES:
            raise ValueError(f"trust mode must be one of {self.MODES}, not {value!r}")
        self.cfg.set(self.SETTING, value)

    def activate(self, phrase: str) -> tuple[bool, str]:
        """Turn full trust on. Requires the owner to type the phrase themselves."""
        if (phrase or "").strip() != self.CONFIRM_PHRASE:
            return False, (f"not activated. Type exactly {self.CONFIRM_PHRASE!r} to accept that Buddy will act "
                           f"on your machine without asking. Third-party actions still confirm.")
        if self.mode == "full":
            return True, "full trust was already on"
        self.mode = "full"
        self._record("trust_activate", "sensitive", "allow",
                     "owner typed the confirmation phrase; full trust enabled")
        return True, ("full trust ON. Buddy now acts on your own machine without asking. "
                      "Permanent deletion is redirected to the trash, and anything that reaches "
                      "another person — messages, payments, applications — still confirms.")

    def deactivate(self, why: str = "") -> tuple[bool, str]:
        was = self.mode
        self.mode = "normal"
        if was != "normal":
            self._record("trust_deactivate", "sensitive", "allow", why or "owner turned full trust off")
            return True, "full trust OFF — everything asks again according to your grants"
        return True, "full trust was already off"

    # ── the decision ──
    def decide(self, action: str, *, risk: str = "", affects_third_party: bool = False,
               scope: str = "") -> TrustDecision:
        """Decide one action. Called before anything happens, never after."""
        a = (action or "").strip().lower()

        # The floor. Checked first and in every mode, on purpose: nothing below
        # this point is allowed to talk itself out of it.
        if affects_third_party or a in THIRD_PARTY_ACTIONS:
            return TrustDecision(True, True,
                                 "this reaches another person or their money, so it confirms in every "
                                 "trust mode — owning the machine is not owning the people at the other end")

        destructive = a in DESTRUCTIVE_ACTIONS
        redirect = RECOVERABLE_REDIRECT.get(a, "") if destructive else ""

        if self.mode == "full":
            if destructive and not redirect:
                return TrustDecision(True, True,
                                     f"'{a}' has no recoverable equivalent, so it confirms even in full trust")
            if destructive:
                self._record(a, "sensitive", "allow", f"full trust; redirected to {redirect}")
                return TrustDecision(True, False, f"full trust; redirected to {redirect} so it can be undone",
                                     redirect=redirect)
            self._record(a, risk or "low", "allow", "full trust")
            return TrustDecision(True, False, "full trust: acting without asking")

        # normal mode: defer to the standing grants the owner already set
        if self.perms is not None and scope:
            mode = self.perms.mode(scope)
            if mode == "deny":
                return TrustDecision(False, False, f"scope '{scope}' is denied")
            if mode == "always" and not destructive and risk != "sensitive":
                return TrustDecision(True, False, f"scope '{scope}' is granted 'always'")
        if destructive:
            return TrustDecision(True, True, f"'{a}' is irreversible; confirming"
                                             + (f" (would be redirected to {redirect} in full trust)" if redirect else ""))
        return TrustDecision(True, True, "normal trust: asking first")

    def state(self) -> dict:
        grants = {}
        if self.perms is not None:
            with contextlib.suppress(Exception):
                grants = dict(self.perms.all())
        return {"mode": self.mode, "grants": grants,
                "always_confirms": sorted(THIRD_PARTY_ACTIONS),
                "redirects_when_full": {k: v for k, v in RECOVERABLE_REDIRECT.items() if v},
                "confirm_phrase": self.CONFIRM_PHRASE}

    def _record(self, action: str, risk: str, decision: str, detail: str) -> None:
        if self._audit is not None:
            with contextlib.suppress(Exception):
                self._audit(action, risk, decision, detail)
        elif self.perms is not None:
            with contextlib.suppress(Exception):
                self.perms.audit("trust", action, risk, decision, detail)


# ════════════════════════════════════════════════════════════════════════════
# Observation — what is it allowed to see?
# ════════════════════════════════════════════════════════════════════════════

class ScreenBackend:
    """Captures and reads the screen.

    Deliberately an interface, not an implementation: the policy layer above it
    has to be testable on a machine with no display at all, which is every CI
    runner and every sandbox this project is developed in. buddy.py supplies a
    real Windows backend; anything else reports unavailable and the loop says
    BLOCKED instead of pretending to have looked.

    Hooks may be sync or async. The real ones in buddy.py are async, because they
    go through the same `exec_tool` path as every other tool call and therefore
    inherit its permission gate, risk classification and audit row — a capture
    that bypassed those would be the one action in the product nobody could
    account for afterwards.
    """

    def __init__(self, capture: Optional[Callable[[], Any]] = None,
                 read_text: Optional[Callable[[Any], str]] = None,
                 acapture: Optional[Callable[[], Any]] = None,
                 aread_text: Optional[Callable[[Any], Any]] = None,
                 why_unavailable: str = BLOCKED_NO_DISPLAY) -> None:
        self._capture = capture
        self._read_text = read_text
        self._acapture = acapture
        self._aread_text = aread_text
        self._why = why_unavailable

    @property
    def available(self) -> tuple[bool, str]:
        if (self._capture is None and self._acapture is None) or \
           (self._read_text is None and self._aread_text is None):
            return False, self._why
        return True, ""

    def capture(self) -> Optional[Any]:
        return self._capture() if self._capture is not None else None

    def text(self, image: Any) -> str:
        return (self._read_text(image) or "") if self._read_text is not None else ""

    async def acapture(self) -> Optional[Any]:
        if self._acapture is not None:
            return await self._acapture()
        return self.capture()

    async def atext(self, image: Any) -> str:
        if self._aread_text is not None:
            return str(await self._aread_text(image) or "")
        return self.text(image)


class ObservationPolicy:
    """How much the companion is allowed to see, and what it must never see.

    Depth is cumulative:
      off         nothing recorded
      titles      app + window title + duration (the level that already shipped)
      capture     periodic screen capture, read to text locally, stored encrypted
      continuous  a rolling buffer of captures, searchable backwards in time

    Exclusions come from the product's existing protected-keyword list — banking,
    password managers, private browsing. They are applied BEFORE capture, not as a
    filter afterwards: a frame that was never taken cannot leak.
    """

    DEPTHS = ("off", "titles", "capture", "continuous")
    SETTING = "observation"

    DEFAULTS = {
        "depth": "titles",
        "capture_seconds": 30.0,
        "buffer_minutes": 60.0,
        "retention_days": 30,
        "store_text_only": True,     # keep the OCR text, not the pixels
        "indicator": True,           # must the user be able to see it is recording
        "extra_exclusions": [],
    }

    def __init__(self, settings: Any, privacy: Any = None, backend: Optional[ScreenBackend] = None) -> None:
        self.cfg = settings
        self.privacy = privacy
        self.backend = backend or ScreenBackend()

    def _o(self) -> dict:
        v = self.cfg.get(self.SETTING, None)
        base = dict(self.DEFAULTS)
        if isinstance(v, dict):
            base.update(v)
        return base

    def _set(self, key: str, value: Any) -> None:
        o = self._o()
        o[key] = value
        self.cfg.set(self.SETTING, o)

    @property
    def depth(self) -> str:
        d = str(self._o().get("depth") or "off").lower()
        return d if d in self.DEPTHS else "off"

    def set_depth(self, depth: str) -> tuple[bool, str]:
        if depth not in self.DEPTHS:
            return False, f"depth must be one of {', '.join(self.DEPTHS)}, not {depth!r}"
        if depth in ("capture", "continuous"):
            ok, why = self.backend.available
            if not ok:
                return False, f"cannot enable '{depth}' here: {why}"
            if not self._o().get("indicator", True):
                return False, ("capture requires the recording indicator to be on. Capture nobody can see "
                               "is capture nobody can consent to.")
        self._set("depth", depth)
        return True, f"observation depth = {depth}"

    def exclusions(self) -> list[str]:
        o = self._o()
        out = []
        if self.privacy is not None:
            with contextlib.suppress(Exception):
                out += list(self.cfg.get("protected_keywords") or [])
        out += [str(x) for x in (o.get("extra_exclusions") or [])]
        seen, uniq = set(), []
        for x in out:
            if x.lower() not in seen:
                seen.add(x.lower())
                uniq.append(x)
        return uniq

    def may_capture(self, title: str, app: str) -> tuple[bool, str]:
        """Checked before every capture. Private mode and protected windows win."""
        if self.depth not in ("capture", "continuous"):
            return False, f"observation depth is '{self.depth}', which does not capture the screen"
        if self.privacy is not None:
            with contextlib.suppress(Exception):
                if self.privacy.private:
                    return False, "private mode is on — nothing is recorded"
                if self.privacy.protected_window(title, app):
                    return False, "window matches an exclusion (banking, password manager, private browsing…)"
        for kw in self._o().get("extra_exclusions") or []:
            if kw and kw.lower() in f"{title} {app}".lower():
                return False, f"window matches your exclusion {kw!r}"
        ok, why = self.backend.available
        if not ok:
            return False, why
        return True, ""

    def indicator(self) -> dict:
        """What the UI must show. A capture that happened while this was off is a bug."""
        o = self._o()
        recording = self.depth in ("capture", "continuous")
        suppressed = False
        if self.privacy is not None:
            with contextlib.suppress(Exception):
                suppressed = bool(self.privacy.private)
        return {"recording": recording and not suppressed, "depth": self.depth,
                "required": bool(o.get("indicator", True)),
                "label": "● recording your screen" if (recording and not suppressed)
                         else ("○ private mode" if suppressed else "○ not capturing")}

    def state(self) -> dict:
        o = self._o()
        ok, why = self.backend.available
        return {**o, "backend_available": ok, "backend_note": why,
                "exclusions": self.exclusions(), "indicator": self.indicator()}


# ════════════════════════════════════════════════════════════════════════════
# UserModel — what has it learned about you?
# ════════════════════════════════════════════════════════════════════════════

class UserModel:
    """A longitudinal model of the owner, built from data the product already keeps.

    Read-only over the existing schema — memories, activity, media_samples,
    conversation, runs. It adds no new collection of its own, so turning
    observation off really does stop the model from growing.

    Every field carries its evidence count, and observed facts are kept strictly
    separate from inferences. That is not decoration: a profile that says "likes
    jazz" without saying it is a guess drawn from four media samples will be
    believed, and it will sometimes be wrong. `render()` marks the difference.
    """

    def __init__(self, store: Any) -> None:
        self.s = store
        self.errors: list[str] = []

    def _q(self, sql: str, params: tuple = ()) -> list[dict]:
        """Query, recording failures instead of hiding them.

        A swallowed SQL error here would return no rows, and `build()` would then
        report an empty profile that looks like "this person has no history"
        rather than "I could not read it". Those are opposite claims, so the error
        is kept and surfaced in the output.
        """
        try:
            return list(self.s.q(sql, params) or [])
        except Exception as e:
            self.errors.append(f"{type(e).__name__}: {e}")
            return []

    def _one(self, sql: str, params: tuple = ()) -> Optional[dict]:
        try:
            return self.s.one(sql, params)
        except Exception as e:
            self.errors.append(f"{type(e).__name__}: {e}")
            return None

    def build(self, days: float = 30) -> dict:
        self.errors = []
        since = _now() - float(days) * 86400.0
        out: dict[str, Any] = {"window_days": days, "observed": {}, "inferred": {},
                               "evidence": {}, "errors": []}

        mem = self._q("SELECT kind, status, COUNT(*) AS n FROM memories GROUP BY kind, status")
        out["observed"]["memory_by_kind"] = {r["kind"]: int(r["n"]) for r in mem}
        out["evidence"]["memories"] = sum(int(r["n"]) for r in mem)

        # GROUP BY matters here: without it SQLite returns ONE row whose COUNT(*)
        # spans every memory and whose `tags` is an arbitrary row's value, so the
        # "recurring topics" would silently be whatever the first record happened
        # to be tagged. Valid SQL, fabricated answer.
        tags = self._q("SELECT tags, COUNT(*) AS n FROM memories "
                       "WHERE tags IS NOT NULL AND tags<>'' GROUP BY tags")
        counter: dict[str, int] = {}
        for r in tags:
            for t in str(r["tags"]).replace(";", ",").split(","):
                t = t.strip().lower()
                if t:
                    counter[t] = counter.get(t, 0) + int(r["n"])
        top = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:12]
        out["inferred"]["recurring_topics"] = [{"topic": k, "mentions": v} for k, v in top]
        out["evidence"]["tagged_memories"] = sum(int(r["n"]) for r in tags)

        apps = self._q("SELECT app, SUM(end-start) AS secs, COUNT(*) AS n FROM activity "
                       "WHERE start>=? AND app IS NOT NULL AND app<>'' GROUP BY app "
                       "ORDER BY secs DESC LIMIT 15", (since,))
        out["observed"]["apps_by_time"] = [{"app": r["app"], "seconds": round(float(r["secs"] or 0), 1),
                                            "samples": int(r["n"])} for r in apps]
        out["evidence"]["activity_samples"] = sum(int(r["n"]) for r in apps)

        observed_screen = self._q(
            "SELECT content, updated FROM memories WHERE kind='episodic' "
            "AND tags LIKE '%screen,observation%' AND updated>=? "
            "ORDER BY updated DESC LIMIT 12", (since,))
        out["observed"]["recent_screen_activity"] = [
            {"description": str(r["content"] or "")[:240], "at": round(float(r["updated"]), 0),
             "confidence": "unverified", "source": "screen_vision"}
            for r in observed_screen]
        out["evidence"]["screen_observations"] = len(observed_screen)

        hours = self._q("SELECT CAST(strftime('%H', start, 'unixepoch', 'localtime') AS INTEGER) AS h, "
                        "SUM(end-start) AS secs FROM activity WHERE start>=? GROUP BY h", (since,))
        by_hour = {int(r["h"]): round(float(r["secs"] or 0), 1) for r in hours if r["h"] is not None}
        if by_hour:
            peak = max(by_hour.items(), key=lambda kv: kv[1])
            out["inferred"]["most_active_hour"] = {"hour": peak[0], "seconds": peak[1]}
            active = sorted((h for h, s in by_hour.items() if s > 0))
            out["inferred"]["active_hours"] = {"first": active[0], "last": active[-1], "distinct": len(active)}

        media = self._q("SELECT app, title, COUNT(*) AS n, SUM(dt) AS secs FROM media_samples "
                        "WHERE ts>=? GROUP BY app, title ORDER BY secs DESC LIMIT 15", (since,))
        out["observed"]["media"] = [{"app": r["app"], "title": r["title"], "plays": int(r["n"]),
                                     "seconds": round(float(r["secs"] or 0), 1)} for r in media]
        out["evidence"]["media_samples"] = sum(int(r["n"]) for r in media)

        conv = self._one("SELECT COUNT(*) AS n, AVG(LENGTH(content)) AS avg_len FROM conversation "
                         "WHERE role='user' AND ts>=?", (since,))
        if conv and int(conv["n"] or 0):
            out["observed"]["messages_to_buddy"] = int(conv["n"])
            out["observed"]["avg_message_chars"] = round(float(conv["avg_len"] or 0), 1)
            out["evidence"]["conversation_rows"] = int(conv["n"])

        runs = self._one("SELECT COUNT(*) AS n, SUM(CASE WHEN verified=1 THEN 1 ELSE 0 END) AS v "
                         "FROM runs WHERE ts>=?", (since,))
        if runs and int(runs["n"] or 0):
            out["observed"]["tasks_asked"] = int(runs["n"])
            out["observed"]["tasks_verified"] = int(runs["v"] or 0)
            out["evidence"]["runs"] = int(runs["n"])

        out["coverage"] = self._coverage(out)
        if self.errors:
            # Never let a read failure masquerade as an empty life.
            out["errors"] = list(self.errors)
            out["coverage"]["verdict"] = (f"UNRELIABLE — {len(self.errors)} read(s) failed: "
                                          + "; ".join(self.errors[:3]))
        return out

    @staticmethod
    def _coverage(out: dict) -> dict:
        """How much of this profile rests on real data. A thin profile must say so."""
        ev = out["evidence"]
        total = sum(int(v or 0) for v in ev.values())
        parts = {"activity": bool(ev.get("activity_samples")), "media": bool(ev.get("media_samples")),
                 "memory": bool(ev.get("memories")), "conversation": bool(ev.get("conversation_rows")),
                 "tasks": bool(ev.get("runs"))}
        return {"total_evidence_rows": total, "sources_present": sum(1 for v in parts.values() if v),
                "sources": parts,
                "verdict": ("no evidence yet — this profile is empty, not neutral" if total == 0 else
                            "thin — treat every inference below as a guess" if total < 25 else
                            "usable" if total < 250 else "substantial")}

    def render(self, profile: dict, width: int = 78) -> str:
        cov = profile["coverage"]
        lines = [f"  what Buddy knows about you  (last {int(profile['window_days'])} days, "
                 f"{cov['total_evidence_rows']} evidence row(s) → {cov['verdict']})"]
        obs = profile["observed"]
        if obs.get("apps_by_time"):
            lines.append("  observed · where your time went")
            for a in obs["apps_by_time"][:6]:
                h, m = divmod(int(a["seconds"]), 3600)
                lines.append(f"    {h:>3}h {m:02d}m  {a['app']}")
        if obs.get("media"):
            lines.append("  observed · what you watched or listened to")
            for x in obs["media"][:5]:
                lines.append(f"    {x['plays']:>3}× {str(x['title'])[:width - 12]}")
        if obs.get("memory_by_kind"):
            lines.append("  observed · what it has been told to remember")
            lines.append("    " + ", ".join(f"{k}={v}" for k, v in sorted(obs["memory_by_kind"].items())))
        inf = profile["inferred"]
        if inf.get("recurring_topics"):
            lines.append("  inferred · recurring topics (guesses, weighted by how often they appear)")
            lines.append("    " + ", ".join(f"{t['topic']} ({t['mentions']})" for t in inf["recurring_topics"][:8]))
        if inf.get("active_hours"):
            ah, peak = inf["active_hours"], inf.get("most_active_hour") or {}
            lines.append(f"  inferred · rhythm: active {ah['first']:02d}:00–{ah['last']:02d}:00, "
                         f"peak at {peak.get('hour', '?'):02d}:00" if isinstance(peak.get("hour"), int)
                         else f"  inferred · rhythm: active {ah['first']:02d}:00–{ah['last']:02d}:00")
        if cov["total_evidence_rows"] == 0:
            lines.append("  nothing observed yet. Turn on observation, or just use Buddy — the model")
            lines.append("  fills in from real activity, and it will not invent a personality for you.")
        return "\n".join(lines)


# ════════════════════════════════════════════════════════════════════════════
# Reflection budget — "thinks 24/7" must not mean "bills 24/7"
# ════════════════════════════════════════════════════════════════════════════

class ReflectionBudget:
    """A hard daily token ceiling on autonomous thinking, enforced in the store.

    Kept in the existing `stats` table under a dated key so it survives restarts:
    a loop that resets its own budget when the process dies is not a budget.
    Old keys are pruned so this cannot grow without bound.
    """

    def __init__(self, store: Any, max_tokens_per_day: int = 250_000, keep_days: int = 14) -> None:
        self.s = store
        self.max = int(max_tokens_per_day)
        self.keep_days = int(keep_days)

    def _key(self, when: Optional[float] = None) -> str:
        return "reflect_tokens_" + time.strftime("%Y%m%d", time.localtime(when or _now()))

    def spent(self) -> int:
        with contextlib.suppress(Exception):
            return int(self.s.stat_get(self._key()) or 0)
        return 0

    def remaining(self) -> int:
        return max(0, self.max - self.spent())

    def allows(self, estimate: int = 1) -> bool:
        return self.remaining() >= max(1, int(estimate))

    def spend(self, tokens: int) -> int:
        n = max(0, int(tokens))
        if n:
            with contextlib.suppress(Exception):
                self.s.stat_add(self._key(), n)
        self.prune()
        return self.spent()

    def prune(self) -> int:
        """Drop dated keys older than the retention window."""
        cut = _now() - self.keep_days * 86400.0
        removed = 0
        with contextlib.suppress(Exception):
            for r in self.s.q("SELECT key FROM stats WHERE key LIKE 'reflect_tokens_%'"):
                try:
                    day = time.mktime(time.strptime(str(r["key"])[-8:], "%Y%m%d"))
                except ValueError:
                    continue
                if day < cut:
                    self.s.x("DELETE FROM stats WHERE key=?", (r["key"],))
                    removed += 1
        return removed

    def state(self) -> dict:
        return {"max_tokens_per_day": self.max, "spent_today": self.spent(),
                "remaining_today": self.remaining(), "key": self._key()}


# ════════════════════════════════════════════════════════════════════════════
# The loop
# ════════════════════════════════════════════════════════════════════════════

@dataclass
class TickReport:
    """One cycle of the companion loop. Honest about what it could not do."""
    observed: bool = False
    observation_note: str = ""
    reflected: bool = False
    reflection: str = ""
    stored: bool = False
    store_note: str = ""
    tokens_used: int = 0
    consulted: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    duration_s: float = 0.0

    def to_dict(self) -> dict:
        return {"observed": self.observed, "observation_note": self.observation_note,
                "reflected": self.reflected, "reflection": self.reflection, "stored": self.stored,
                "store_note": self.store_note,
                "tokens_used": self.tokens_used, "consulted": self.consulted,
                "blocked": self.blocked, "duration_s": round(self.duration_s, 3)}


class CompanionLoop:
    """The 24/7 scheduler: observe → think when idle → be interruptible.

    "Thinking all the time" is implemented as cheap local work continuously plus
    expensive model work only when the machine is idle AND the daily budget allows
    it. That is the honest version of the request: an unconditional inference call
    on every tick is a metered bill that grows whether or not anything interesting
    happened, and it competes with the user for the CPU they are actually using.

    The loop never blocks a reply to the owner. Reflection yields to any pending
    user input, checked before the model call and again before anything is stored.
    """

    SETTING = "companion"
    DEFAULTS = {
        "enabled": False,
        "idle_seconds": 180.0,      # only reflect once the owner has stepped away
        "tick_seconds": 30.0,
        "max_tokens_per_day": 250_000,
        "consult_role": "deep",     # which model role gives the second opinion
        "window_days": 30,          # how far back the user model looks
        # At most one STORED reflection per cooldown. Without this a loop ticking
        # every 30s would write ~2900 memories a day, which is noise that buries
        # the ones that matter. The loop still thinks every tick; it just does not
        # write down every single thought.
        "store_cooldown_seconds": 900.0,
        "capture_seconds": 30.0,  # live capture cadence when owner enables capture observation
    }

    def __init__(self, settings: Any, *, observation: ObservationPolicy, model: UserModel,
                 store: Any, memory: Any = None, budget: Optional[ReflectionBudget] = None,
                 chat: Optional[Callable[..., Any]] = None,
                 idle_probe: Optional[Callable[[], float]] = None,
                 pending_input: Optional[Callable[[], bool]] = None,
                 capture_context: Optional[Callable[[], dict]] = None,
                 on_observation: Optional[Callable[[str, str, str], Any]] = None,
                 log_fn: Optional[Callable[..., None]] = None) -> None:
        self.cfg = settings
        self.obs = observation
        self.model = model
        self.store = store
        self.memory = memory
        o = self.options()
        self.budget = budget or ReflectionBudget(store, int(o["max_tokens_per_day"]))
        self._chat = chat
        self._idle_probe = idle_probe
        self._pending = pending_input or (lambda: False)
        self._capture_context = capture_context or (lambda: {})
        self._on_observation = on_observation
        self.last_capture_at = 0.0
        self.last_capture_text = ""
        self.last_capture_note = "not captured yet"
        self.captures = 0
        self._log = log_fn or (lambda *a, **k: None)
        self._stop = threading.Event()
        self.last: Optional[TickReport] = None
        self.ticks = 0
        self.errors: list[str] = []

    def options(self) -> dict:
        v = self.cfg.get(self.SETTING, None)
        base = dict(self.DEFAULTS)
        if isinstance(v, dict):
            base.update(v)
        return base

    def set_option(self, key: str, value: Any) -> tuple[bool, str]:
        if key not in self.DEFAULTS:
            return False, f"unknown option {key!r}; known: {', '.join(sorted(self.DEFAULTS))}"
        o = self.options()
        if key in ("idle_seconds", "tick_seconds") and float(value) < 5:
            return False, f"{key} must be at least 5s, or the loop spins and burns budget for nothing"
        o[key] = value
        self.cfg.set(self.SETTING, o)
        if key == "max_tokens_per_day":
            self.budget.max = int(value)
        return True, f"{key} = {value}"

    @property
    def enabled(self) -> bool:
        return bool(self.options().get("enabled"))

    def enable(self, on: bool) -> tuple[bool, str]:
        o = self.options()
        o["enabled"] = bool(on)
        self.cfg.set(self.SETTING, o)
        if on and self.obs.depth == "off":
            return True, ("companion loop ON, but observation depth is 'off' so there is nothing to "
                          "think about. Set a depth: buddy companion observe titles|capture|continuous")
        return True, f"companion loop {'ON' if on else 'OFF'}"

    def store_cooldown_ok(self) -> tuple[bool, str]:
        """Has enough time passed since the last stored reflection?"""
        cd = float(self.options().get("store_cooldown_seconds", 900.0))
        if cd <= 0:
            return True, ""
        row = None
        with contextlib.suppress(Exception):
            row = self.store.one("SELECT MAX(updated) AS u FROM memories "
                                 "WHERE kind='episodic' AND tags LIKE '%companion%'")
        if row and row["u"]:
            age = _now() - float(row["u"])
            if age < cd:
                return False, (f"a reflection was stored {int(age)}s ago and the cooldown is "
                               f"{int(cd)}s — thought kept, not written down")
        return True, ""

    def idle_seconds(self) -> float:
        if self._idle_probe is not None:
            with contextlib.suppress(Exception):
                return float(self._idle_probe())
        return 0.0

    def can_reflect(self) -> tuple[bool, str]:
        """Every reason reflection will not happen right now, checked in order."""
        if not self.enabled:
            return False, "the companion loop is off"
        if self._pending():
            return False, "the owner is waiting for an answer — replies come first"
        idle, need = self.idle_seconds(), float(self.options()["idle_seconds"])
        if idle < need:
            return False, f"the owner is active (idle {idle:.0f}s < {need:.0f}s)"
        if not self.budget.allows(1):
            return False, (f"daily reflection budget exhausted "
                           f"({self.budget.spent()}/{self.budget.max} tokens)")
        if self._chat is None:
            return False, BLOCKED_NO_KEY
        return True, ""

    def observe(self) -> tuple[bool, str]:
        """Is observation possible right now? Titles always are; capture needs a backend."""
        if self.obs.depth == "off":
            return False, "observation is off"
        return self.backend_check()

    def backend_check(self) -> tuple[bool, str]:
        if self.obs.depth in ("capture", "continuous"):
            return self.obs.backend.available
        return True, ""

    async def capture_once(self, title: str = "", app_name: str = "") -> tuple[bool, str, str]:
        """Take one capture and read it to text. Returns (ok, note, text).

        Policy is checked BEFORE the frame is taken, so an excluded window is
        never captured at all — there is no frame to leak and nothing to redact
        afterwards.
        """
        ok, why = self.obs.may_capture(title, app_name)
        if not ok:
            return False, why, ""
        if self._pending():
            return False, "the owner is waiting for an answer — capture skipped", ""
        try:
            image = await self.obs.backend.acapture()
            if image is None:
                return False, "capture returned nothing", ""
            text = await self.obs.backend.atext(image)
        except Exception as e:
            return False, f"capture failed: {type(e).__name__}: {e}", ""
        return True, f"captured and read {len(text)} characters", text

    async def observe_tick(self) -> None:
        """Observe while owner is active too; reflection has a separate idle gate."""
        if self.obs.depth not in ("capture", "continuous") or self._pending():
            return
        now_at = _now()
        if now_at - self.last_capture_at < float(self.options().get("capture_seconds", 30.0)):
            return
        self.last_capture_at = now_at
        try:
            ctx = self._capture_context() or {}
            title, app_name = str(ctx.get("title", "")), str(ctx.get("app", ""))
            if not title and not app_name:
                self.last_capture_note = "no eligible foreground app"
                return
            ok, note, text = await self.capture_once(title, app_name)
            self.last_capture_note = note
            if ok and text.strip():
                self.last_capture_text = text[:2000]
                self.captures += 1
                if self._on_observation is not None:
                    try:
                        result = self._on_observation(title, app_name, text)
                        if inspect.isawaitable(result):
                            result = await result
                        if isinstance(result, str) and result:
                            self.last_capture_note += "; " + result[:150]
                    except Exception as exc:
                        self.errors.append("observation memory: " + type(exc).__name__)
                        self.last_capture_note += "; memory write failed"
                self._log("companion_screen_observed", chars=len(text), captures=self.captures)
        except Exception as e:
            self.last_capture_note = f"capture failed: {type(e).__name__}: {e}"
            self.errors.append(self.last_capture_note)

    async def reflect(self, estimate: int = 4000) -> TickReport:
        """One thinking cycle. Returns what it did, or precisely why it did not."""
        t0 = _now()
        rep = TickReport()
        ok, why = self.can_reflect()
        if not ok:
            rep.blocked.append(why)
            rep.duration_s = _now() - t0
            self.last = rep
            return rep

        profile = self.model.build(days=float(self.options().get("window_days", 30)))
        obs_ok, obs_why = self.observe()
        rep.observed, rep.observation_note = obs_ok, obs_why
        if not obs_ok:
            rep.blocked.append(obs_why)

        # The loop yields to the owner again here: building the profile can take a
        # moment, and a question asked during it outranks the reflection.
        if self._pending():
            rep.blocked.append("the owner asked something mid-reflection — abandoning it")
            rep.duration_s = _now() - t0
            self.last = rep
            return rep

        prompt = ("You are the background reflection of a personal assistant. Below is what it has "
                  "observed about its owner. Write at most 120 words: one durable, useful insight that "
                  "is NOT already stored, or the single line 'nothing new'. Do not speculate about "
                  "health, relationships or anything not directly evidenced.\n\n"
                  + _jdump(profile) + ("\n\nLatest observed screen (unverified visual description): " + self.last_capture_text if self.last_capture_text else ""))
        try:
            out = self._chat(prompt, max_tokens=min(estimate, self.budget.remaining()))
            if inspect.isawaitable(out):
                # The real gateway chat is a coroutine; a test's fake is not. Both
                # work, because reflect() is itself async and can await either.
                out = await out
        except Exception as e:
            rep.blocked.append(f"reflection call failed: {type(e).__name__}: {e}")
            rep.duration_s = _now() - t0
            self.last = rep
            return rep

        text = (out or "").strip() if isinstance(out, str) else str((out or {}).get("content", "")).strip()
        used = int((out or {}).get("tokens", 0)) if isinstance(out, dict) else estimate
        rep.tokens_used = used
        self.budget.spend(used)
        rep.reflection = text[:2000]
        rep.reflected = bool(text) and "nothing new" not in text.lower()

        if rep.reflected and self.memory is not None and not self._pending():
            # Stored as `episodic` and UNVERIFIED. Memory.save validates the kind
            # against Memory.KINDS and raises on an unknown one, so a typo here is
            # a hard error, not a silent no-op — and it is reported rather than
            # swallowed, because "I thought about it but stored nothing" and "I
            # stored nothing worth storing" are different claims.
            #
            # The title carries seconds on purpose. Memory.save upserts on
            # (kind, lower(title)), so a minute-granularity title made every
            # reflection inside the same minute overwrite the one before it: a
            # loop ticking every 30s produced seven thoughts and one memory.
            ok, why = self.store_cooldown_ok()
            if not ok:
                rep.store_note = why
            else:
                try:
                    self.memory.save("episodic",
                                     f"reflection {time.strftime('%Y-%m-%d %H:%M:%S')}",
                                     text, tags="companion,reflection", status="unverified")
                    rep.stored = True
                except Exception as e:
                    rep.blocked.append(f"reflection could not be stored: {type(e).__name__}: {e}")
        rep.duration_s = _now() - t0
        self.last = rep
        self._log("companion_reflect", tokens=used, stored=rep.reflected)
        return rep

    async def aconsult(self, question: str, role: Optional[str] = None) -> tuple[bool, str]:
        """`consult` for callers that are already inside an event loop."""
        blocked, why = self._consult_gate()
        if blocked:
            return False, why
        try:
            out = self._chat(question, role=role or self.options().get("consult_role", "deep"),
                             max_tokens=min(4000, self.budget.remaining()))
            if inspect.isawaitable(out):
                out = await out
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"
        return self._consult_result(out)

    def _consult_gate(self) -> tuple[bool, str]:
        if self._chat is None:
            return True, BLOCKED_NO_KEY
        if not self.budget.allows(1):
            return True, f"daily budget exhausted ({self.budget.spent()}/{self.budget.max} tokens)"
        return False, ""

    def _consult_result(self, out: Any) -> tuple[bool, str]:
        text = out if isinstance(out, str) else str((out or {}).get("content", ""))
        used = int((out or {}).get("tokens", 0)) if isinstance(out, dict) else 0
        self.budget.spend(used)
        return True, text

    def consult(self, question: str, role: Optional[str] = None) -> tuple[bool, str]:
        """A second opinion from another model, through the gateway.

        This is the supported way to "talk to Claude or ChatGPT": the gateway
        already routes to whichever models it is given, with usage accounted for.
        Driving those vendors' websites in a browser would break their terms and
        break again at every redeploy, for no capability this does not have.
        """
        blocked, why = self._consult_gate()
        if blocked:
            return False, why
        try:
            out = self._chat(question, role=role or self.options().get("consult_role", "deep"),
                             max_tokens=min(4000, self.budget.remaining()))
            if inspect.isawaitable(out):
                # Cannot block on a coroutine from inside a running loop. Say so
                # rather than deadlocking or silently returning nothing.
                try:
                    asyncio.get_running_loop()
                except RuntimeError:
                    out = asyncio.run(_await(out))
                else:
                    return False, ("consult() was called from inside a running event loop; "
                                   "await aconsult() instead")
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"
        return self._consult_result(out)

    def status(self) -> dict:
        o = self.options()
        ok, why = self.can_reflect()
        return {"enabled": self.enabled, "ticks": self.ticks,
                "idle_seconds": round(self.idle_seconds(), 1),
                "idle_threshold": o["idle_seconds"], "tick_seconds": o["tick_seconds"],
                "budget": self.budget.state(), "can_reflect_now": ok,
                "why_not": "" if ok else why,
                "observation": self.obs.state(),
                "errors": list(self.errors[-5:]),
                "capture_count": self.captures, "last_capture_note": self.last_capture_note,
                "last_capture_at": self.last_capture_at,
                "last": self.last.to_dict() if self.last else None}

    def request_stop(self) -> None:
        self._stop.set()

    async def run(self, max_ticks: Optional[int] = None) -> list[TickReport]:
        """Run until stopped. `max_ticks` exists so tests do not need real time."""
        out: list[TickReport] = []
        o = self.options()
        while not self._stop.is_set():
            try:
                await self.observe_tick()
                rep = await self.reflect()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # A loop that runs for weeks will hit something nobody predicted.
                # Dying silently would leave the owner believing it was still
                # thinking, so the failure is recorded and the loop carries on.
                rep = TickReport(blocked=[f"tick failed: {type(e).__name__}: {e}"])
                self.errors.append(str(e))
                self._log("companion_tick_error", err=str(e))
            out.append(rep)
            # Long-lived companions must not retain every tick forever.
            if len(out) > 120:
                del out[:len(out) - 120]
            self.ticks += 1
            if max_ticks is not None and self.ticks >= max_ticks:
                break
            with contextlib.suppress(Exception):
                await asyncio.sleep(float(o["tick_seconds"]))
        return out
