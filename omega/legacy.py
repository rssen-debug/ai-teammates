"""Legacy encapsulation — exporting a digital context so it can outlive its owner.

What this is
------------
`buddy legacy build` writes everything the product has learned about its owner
into one self-describing, checksummed bundle: memories, the longitudinal profile,
verified skills, level history, and a redacted copy of the settings. `buddy legacy
import` reads one back into another installation. Between those two sits the part
the request was actually about: designating an heir, recording that the owner is
still alive, and deciding when the bundle may be handed over.

What this is not
----------------
The bundle is a **record of a person, not the person**. Every manifest carries an
`identity` of `memorial_record` and a `notice` that any consumer is required to
display. Nothing here builds something that presents itself as the owner, and
`release` never transmits anything: it unlocks a copy and writes an audit row, and
a human decides what happens next. Handing a deceased person's context to another
human being is a third-party action, and third-party actions confirm in every
trust mode — full autonomy over your own machine does not extend to the people who
inherit it.

Secrets are excluded by construction, not by filtering. The vault is never opened,
and settings are exported from an allowlist, so a new setting added tomorrow
cannot leak by accident. Redaction that depends on remembering what is sensitive
is redaction that eventually fails.

Crypto is deliberately NOT rolled here, and the platform keyset is deliberately
NOT used. Python's standard library has no AES, and a home-grown cipher is worse
than an honestly plaintext file because it looks like protection. Windows DPAPI is
the wrong tool for a *different* reason, and an obvious one in hindsight: it binds
ciphertext to the account that created it, so a bundle sealed that way could never
be opened by the heir after the owner is gone. Sealing with the platform key would
make the bundle perfectly safe and permanently useless, which is the exact opposite
of what this feature is for.

So the bundle is written in plaintext, records `sealed: false`, and tells the owner
to seal it with a passphrase-based tool whose passphrase they escrow with the heir
or a lawyer — `gpg --symmetric` or `age -p`. The protection has to survive the
person who created it, which only a secret held by someone else can do.

Nothing imports `buddy` at module level; collaborators are injected.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

__all__ = ["SCHEMA", "NOTICE", "IDENTITY", "SETTINGS_ALLOWLIST", "SECRET_KEYS",
           "LegacyManifest", "LegacyBundle", "unsealed_warning", "is_secret_key"]

SCHEMA = "studdybuddy.omega.legacy-bundle/v1"
IDENTITY = "memorial_record"
NOTICE = ("This bundle is a record of a person's digital context, assembled by their own "
          "assistant. It is not that person, and it is not a substitute for them. Anything "
          "built from it must say so, in those terms, before it is shown to anyone.")

#: Exported settings. An allowlist, not a denylist: a key added tomorrow is
#: excluded until someone decides it belongs here.
SETTINGS_ALLOWLIST = (
    "models", "escalation_ladder", "retention_days", "protected_keywords",
    "observe_enabled", "private_mode", "poll_seconds", "autostart",
    "voice_enabled", "tts_engine", "stt_model", "trust_mode",
    "observation", "companion",
)

#: Never exported, whatever table they are found in.
SECRET_KEYS = frozenset({
    "kilo_api_key", "api_key", "apikey", "token", "access_token", "refresh_token",
    "secret", "client_secret", "password", "passphrase", "private_key", "vault",
    "credentials", "authorization", "cookie", "session_token",
})


def _now() -> float:
    return time.time()


def _iso(ts: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts or _now()))


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def is_secret_key(key: str) -> bool:
    """True if a key name looks like a credential. Matched on the lowered name."""
    k = str(key or "").lower()
    return any(s in k for s in SECRET_KEYS)


def unsealed_warning(bundle: Path) -> str:
    """What to tell an owner whose bundle is sitting there in plaintext."""
    return (f"  {bundle} is NOT encrypted.\n"
            f"  Python's standard library has no AES, and a hand-rolled cipher would be worse\n"
            f"  than an honest plaintext file, because it would look like protection.\n"
            f"  Seal it yourself before it leaves this machine:\n"
            f"      gpg --symmetric --cipher-algo AES256 {bundle}\n"
            f"  or:  age -p -o {bundle}.age {bundle}\n"
            f"  The manifest records sealed=false so this cannot be forgotten silently.")


@dataclass
class LegacyManifest:
    """The bundle's self-description. Read this and you know what you are holding."""
    schema: str = SCHEMA
    version: int = 1
    identity: str = IDENTITY
    notice: str = NOTICE
    created: str = ""
    product_version: str = ""
    platform: str = ""
    sealed: bool = False
    seal_method: str = ""
    contents: dict[str, Any] = field(default_factory=dict)
    checksums: dict[str, str] = field(default_factory=dict)
    heir: dict[str, Any] = field(default_factory=dict)
    heartbeat: dict[str, Any] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in (
            "schema", "version", "identity", "notice", "created", "product_version",
            "platform", "sealed", "seal_method", "contents", "checksums", "heir",
            "heartbeat", "counts", "warnings")}

    @classmethod
    def from_dict(cls, d: dict) -> "LegacyManifest":
        known = {k: v for k, v in (d or {}).items() if k in cls().__dict__}
        return cls(**known)


class LegacyBundle:
    """Builds, verifies and reads a legacy bundle.

    Every read path is explicit about provenance and every write path records
    what it did, because a bundle that cannot be audited cannot be trusted by the
    person who inherits it.
    """

    #: Files written into a bundle. Anything not listed here is not exported.
    FILES = ("memories.jsonl", "profile.json", "skills.jsonl",
             "level_history.jsonl", "settings.json", "README.txt")

    def __init__(self, store: Any, *, profile_builder: Optional[Callable[[float], dict]] = None,
                 product_version: str = "", log: Optional[Callable[..., None]] = None) -> None:
        self.s = store
        self._profile = profile_builder
        self.version = product_version
        self._log = log or (lambda *a, **k: None)

    # ── reading the owner's data ──────────────────────────────────────────
    def _q(self, sql: str, params: tuple = ()) -> list[dict]:
        try:
            return [dict(r) for r in (self.s.q(sql, params) or [])]
        except Exception as e:
            # A failed read must not silently produce a smaller bundle: an heir
            # would receive an incomplete record that looks complete.
            raise RuntimeError(f"could not read for the legacy bundle: {e}") from e

    def export_settings(self) -> dict:
        out: dict[str, Any] = {}
        for key in SETTINGS_ALLOWLIST:
            row = None
            with contextlib.suppress(Exception):
                row = self.s.one("SELECT value FROM settings WHERE key=?", (key,))
            if row is None:
                continue
            if is_secret_key(key):
                continue                      # belt and braces behind the allowlist
            with contextlib.suppress(Exception):
                out[key] = json.loads(row["value"])
        return {"allowlist": list(SETTINGS_ALLOWLIST), "values": out,
                "excluded": "the credential vault is never opened, and settings are exported "
                            "from an allowlist so a new key cannot leak by accident"}

    # ── build ─────────────────────────────────────────────────────────────
    def build(self, dest: Path, *, profile_days: float = 365.0, seal: bool = True) -> dict:
        """Write a bundle to `dest`. Returns the manifest as a dict.

        `dest` may be a directory (files are written into it) or a .tar path (the
        directory is built, archived, and removed).
        """
        dest = Path(dest)
        as_tar = dest.suffix in (".tar", ".tgz") or dest.name.endswith(".tar.gz")
        work = dest.parent / (dest.stem + "-build") if as_tar else dest
        if work.exists():
            shutil.rmtree(work)
        work.mkdir(parents=True)

        man = LegacyManifest(created=_iso(), product_version=self.version or "unknown",
                             platform=os.name)

        memories = self._q("SELECT id, kind, title, content, tags, status, created, updated, uses "
                           "FROM memories ORDER BY id")
        self._write_jsonl(work / "memories.jsonl", memories)

        skills = self._q("SELECT name, version, status, description, schema, test_result, risk, created "
                         "FROM skills ORDER BY name, version")
        self._write_jsonl(work / "skills.jsonl", skills)

        history = self._q("SELECT ts, level, score, measured_events, tier FROM level_history ORDER BY ts")
        self._write_jsonl(work / "level_history.jsonl", history)

        profile: dict[str, Any] = {"error": "no profile builder was supplied"}
        if self._profile is not None:
            try:
                profile = self._profile(profile_days)
            except Exception as e:
                profile = {"error": f"{type(e).__name__}: {e}"}
                man.warnings.append(f"the profile could not be built: {profile['error']}")
        (work / "profile.json").write_text(json.dumps(profile, ensure_ascii=False, indent=2, default=str),
                                           encoding="utf-8")

        settings = self.export_settings()
        (work / "settings.json").write_text(json.dumps(settings, ensure_ascii=False, indent=2, default=str),
                                            encoding="utf-8")

        (work / "README.txt").write_text(self._readme(man, len(memories), len(skills)), encoding="utf-8")

        man.counts = {"memories": len(memories), "skills": len(skills),
                      "level_history": len(history), "settings": len(settings["values"])}
        if not memories:
            man.warnings.append("no memories were exported — this bundle records an almost empty relationship")

        # Checksums are computed over the payload files and stored in the manifest,
        # which is itself excluded from the checksum set so it can describe them.
        for name in self.FILES:
            f = work / name
            if f.is_file():
                man.contents[name] = f.stat().st_size
                man.checksums[name] = _sha256(f)
        man.contents["manifest.json"] = 0      # filled in after writing

        # `seal` is accepted for call compatibility and deliberately does nothing
        # to the files. There is no correct way for this process to encrypt a
        # bundle meant to outlive its owner: the platform keyset dies with the
        # account, and a passphrase it chose itself would be a secret nobody has.
        man.sealed, man.seal_method = False, ""
        man.warnings.append(
            "this bundle is NOT encrypted. Seal it with a passphrase tool and give the "
            "passphrase to your heir or lawyer — `gpg --symmetric --cipher-algo AES256` or "
            "`age -p`. DPAPI/BitLocker-to-account would seal it so only YOUR account could "
            "open it, which defeats handing it to anyone.")

        (work / "manifest.json").write_text(json.dumps(man.to_dict(), ensure_ascii=False, indent=2),
                                            encoding="utf-8")
        man.contents["manifest.json"] = (work / "manifest.json").stat().st_size

        out_path = work
        if as_tar:
            with tarfile.open(dest, "w:gz") as tf:
                for f in sorted(work.iterdir()):
                    tf.add(f, arcname=f.name)
            shutil.rmtree(work, ignore_errors=True)
            out_path = dest

        self._log("legacy_build", path=str(out_path), memories=len(memories), skills=len(skills))
        result = man.to_dict()
        result["path"] = str(out_path)
        result["archive"] = str(dest) if as_tar else ""
        return result

    def _write_jsonl(self, path: Path, rows: list[dict]) -> None:
        with path.open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")

    def _readme(self, man: LegacyManifest, memories: int, skills: int) -> str:
        return f"""STUDDY BUDDY OMEGA — LEGACY BUNDLE
{man.schema}

{NOTICE}

Created          {man.created}
Product version  {man.product_version}
Platform         {man.platform}
Encrypted        {'yes (' + man.seal_method + ')' if man.sealed else 'NO — seal it yourself, see manifest.warnings'}

Contents
  memories.jsonl        {memories} record(s) — everything it was told to remember
  profile.json          the longitudinal model of the owner, observed vs inferred
  skills.jsonl          {skills} verified procedure(s)
  level_history.jsonl   the capability level over time, with its evidence counts
  settings.json         an ALLOWLIST of settings; the credential vault is never exported
  manifest.json         schema, checksums, heir, heartbeat

Deliberately absent
  * every credential, API key and token — excluded by construction
  * raw screen captures and keystrokes — this product does not store them
  * anything the owner marked private while private mode was on

Verifying a bundle
  buddy legacy verify PATH
Each payload file's SHA-256 is listed in manifest.json. A bundle whose checksums
do not match has been altered or truncated, and must not be imported.

Sealing it — do this before handing it to anyone
  This bundle is PLAINTEXT and it describes a real person. The manifest records
  sealed=false so that fact cannot be forgotten silently. Encrypt it with a
  passphrase and give the passphrase to your heir or your lawyer:
      gpg --symmetric --cipher-algo AES256 -o bundle.tar.gz.gpg bundle.tar.gz
      age -p -o bundle.tar.gz.age bundle.tar.gz
  Do NOT rely on DPAPI, BitLocker-to-account or any platform keyring. Those bind
  the ciphertext to YOUR account, so the bundle could never be opened by the
  person you are leaving it to — perfectly safe and permanently useless. The
  protection has to survive you, and only a secret that somebody else also holds
  can do that.

Handing it over
  buddy legacy heir set ...      who inherits this
  buddy legacy heartbeat         record that the owner is alive
  buddy legacy check             is the grace period over?
  buddy legacy release --yes     unlock a copy. This never transmits anything:
                                 a human decides what happens next.
"""

    # ── verify / inspect ──────────────────────────────────────────────────
    @staticmethod
    def _extract(archive: Path, work: Path) -> Path:
        """Return a directory holding the bundle's files, unpacking if needed."""
        if archive.is_dir():
            return archive
        work.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "r:*") as tf:
            # Never trust a tar's paths: an absolute or ../ member would write
            # outside the destination, which is how an imported bundle becomes a
            # way to overwrite the importer's own files.
            for member in tf.getmembers():
                target = (work / member.name).resolve()
                if not str(target).startswith(str(work.resolve())):
                    raise RuntimeError(f"refusing archive member with an unsafe path: {member.name!r}")
                if member.isfile():
                    with tf.extractfile(member) as src, target.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        return work

    def verify(self, archive: Path) -> dict:
        """Checksum and schema verification. Returns a report; raises nothing."""
        archive = Path(archive)
        report: dict[str, Any] = {"path": str(archive), "ok": False, "checks": {}, "problems": []}
        if not archive.exists():
            report["problems"].append(f"no such bundle: {archive}")
            return report
        # Unpack into a temporary directory, never beside the bundle: the person
        # verifying this may be reading it off read-only media, and a failure to
        # create a scratch directory would look like a corrupted bundle.
        work = Path(tempfile.mkdtemp(prefix="legacy-verify-"))
        try:
            root = self._extract(archive, work) if not archive.is_dir() else archive
            mpath = root / "manifest.json"
            if not mpath.is_file():
                report["problems"].append("manifest.json is missing — this is not a legacy bundle")
                return report
            man = LegacyManifest.from_dict(json.loads(mpath.read_text(encoding="utf-8")))
            report["manifest"] = man.to_dict()
            report["checks"]["schema_matches"] = man.schema == SCHEMA
            if man.schema != SCHEMA:
                report["problems"].append(f"expected schema {SCHEMA}, found {man.schema!r}")
            report["checks"]["identity_is_a_record_not_a_person"] = man.identity == IDENTITY
            report["checks"]["carries_the_notice"] = bool(man.notice)

            for name, want in (man.checksums or {}).items():
                f = root / name
                if not f.is_file():
                    report["checks"][f"present:{name}"] = False
                    report["problems"].append(f"{name} is listed in the manifest but missing")
                    continue
                got = _sha256(f)
                report["checks"][f"sha256:{name}"] = got == want
                if got != want:
                    report["problems"].append(f"{name} has been altered or truncated "
                                              f"(manifest {want[:12]}…, actual {got[:12]}…)")
            leaked = [k for k in man.checksums if is_secret_key(k)]
            report["checks"]["no_secret_named_payload"] = not leaked
            if leaked:
                report["problems"].append(f"bundle contains credential-shaped files: {leaked}")
            report["ok"] = not report["problems"] and all(report["checks"].values())
            return report
        except Exception as e:
            report["problems"].append(f"verification failed: {type(e).__name__}: {e}")
            return report
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def inspect(self, archive: Path) -> dict:
        """What is in a bundle, without importing any of it."""
        rep = self.verify(archive)
        man = rep.get("manifest") or {}
        archive = Path(archive)
        out: dict[str, Any] = {"path": str(archive), "verified": rep["ok"], "problems": rep["problems"],
                               "counts": man.get("counts", {}), "created": man.get("created", ""),
                               "sealed": man.get("sealed", False),
                               "heir": man.get("heir", {}), "heartbeat": man.get("heartbeat", {}),
                               "warnings": man.get("warnings", []), "sample_titles": []}
        if not rep["ok"]:
            # A bundle that does not verify is not unpacked at all. Reading payloads
            # out of it would invite someone to act on content that may be altered.
            return out
        work = Path(tempfile.mkdtemp(prefix="legacy-inspect-"))
        try:
            root = self._extract(archive, work) if not archive.is_dir() else archive
            f = root / "memories.jsonl"
            if f.is_file():
                for i, line in enumerate(f.read_text(encoding="utf-8").splitlines()):
                    if i >= 5:
                        break
                    with contextlib.suppress(Exception):
                        out["sample_titles"].append(json.loads(line).get("title", ""))
            p = root / "profile.json"
            if p.is_file():
                with contextlib.suppress(Exception):
                    prof = json.loads(p.read_text(encoding="utf-8"))
                    out["profile_coverage"] = prof.get("coverage", {})
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return out

    # ── heir and heartbeat, held in settings so they travel with the bundle ──
    def set_heir(self, name: str, contact: str = "", relationship: str = "",
                 note: str = "") -> dict:
        heir = {"name": name.strip(), "contact": contact.strip(),
                "relationship": relationship.strip(), "note": note.strip(),
                "designated": _iso()}
        self.s.x("INSERT INTO settings(key,value) VALUES('legacy_heir',?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (json.dumps(heir, ensure_ascii=False),))
        self._log("legacy_heir_set", name=heir["name"])
        return heir

    def heir(self) -> dict:
        row = self.s.one("SELECT value FROM settings WHERE key='legacy_heir'")
        if not row:
            return {}
        with contextlib.suppress(Exception):
            return json.loads(row["value"])
        return {}

    def heartbeat(self) -> dict:
        """Record that the owner is alive. Cheap, and the whole switch depends on it."""
        hb = {"last": _now(), "at": _iso(),
              "grace_days": float(self._grace_days())}
        self.s.x("INSERT INTO settings(key,value) VALUES('legacy_heartbeat',?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (json.dumps(hb),))
        return hb

    def _grace_days(self) -> Any:
        row = self.s.one("SELECT value FROM settings WHERE key='legacy_grace_days'")
        if row:
            with contextlib.suppress(Exception):
                return float(json.loads(row["value"]))
        return 90.0

    def set_grace_days(self, days: float) -> float:
        days = max(1.0, float(days))
        self.s.x("INSERT INTO settings(key,value) VALUES('legacy_grace_days',?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(days),))
        return days

    def last_heartbeat(self) -> dict:
        row = self.s.one("SELECT value FROM settings WHERE key='legacy_heartbeat'")
        if not row:
            return {}
        with contextlib.suppress(Exception):
            return json.loads(row["value"])
        return {}

    def check(self) -> dict:
        """Is the grace period over? Reports; decides nothing and sends nothing."""
        hb = self.last_heartbeat()
        grace = float(self._grace_days())
        if not hb:
            return {"state": "never_recorded", "releasable": False, "grace_days": grace,
                    "detail": "no heartbeat has ever been recorded, so nothing can be concluded. "
                              "Run `buddy legacy heartbeat` — and note that a bundle is never "
                              "released automatically in any state."}
        age_days = (_now() - float(hb.get("last") or 0)) / 86400.0
        releasable = age_days >= grace
        return {"state": "grace_elapsed" if releasable else "owner_recently_active",
                "releasable": releasable, "grace_days": grace,
                "days_since_heartbeat": round(age_days, 1),
                "last_heartbeat": hb.get("at", ""),
                "detail": (f"{age_days:.1f} day(s) since the last heartbeat, grace is {grace:.0f}."
                           + (" The grace period has elapsed." if releasable else
                              " The owner is still active."))
                          + " Nothing is ever transmitted automatically: `buddy legacy release` "
                            "unlocks a copy and a human decides what happens next."}

    # ── release / import ────────────────────────────────────────────────────
    RELEASE_PHRASE = "release to my heir"

    def release(self, archive: Path, *, phrase: str = "") -> dict:
        """Mark a verified bundle as released, so a human can hand it over.

        This is the one action here that reaches another person: the recipient gets
        a working model of someone who is not in the room to object. So it takes the
        confirmation phrase typed in, never as a command-line flag — a flag lands in
        shell history, in the process list, and in any supervisor's logs, which turns
        a deliberate decision into a string that can be replayed by anyone who can
        read them.

        It writes nothing outside the bundle and transmits nothing to anyone. There
        is no network path in this module at all.
        """
        archive = Path(archive)
        out: dict[str, Any] = {"ok": False, "released": False, "path": str(archive), "problems": []}
        rep = self.verify(archive)
        if not rep["ok"]:
            out["problems"] = [f"refusing to release a bundle that does not verify: {p}" for p in rep["problems"]]
            return out
        if (phrase or "").strip() != self.RELEASE_PHRASE:
            out["problems"] = [
                f"not released. Type exactly {self.RELEASE_PHRASE!r} to accept that this bundle "
                "describes a person and will be read by someone else."]
            out["hint"] = f'echo "{self.RELEASE_PHRASE}" | buddy legacy release PATH'
            return out

        record = {"at": _iso(), "path": str(archive),
                  "checksums": (rep.get("manifest") or {}).get("checksums", {}),
                  "released_with": "a typed confirmation phrase; no argv flag"}
        self.s.x("INSERT INTO settings(key,value) VALUES('legacy_release',?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(record),))
        self._log("legacy_release", path=str(archive))
        out.update(ok=True, released=True, record=record,
                   seal_warning=unsealed_warning(archive),
                   detail="released for hand-over. Nothing was transmitted and nothing left this machine: "
                          "a human decides what happens next. The bundle is still plaintext — seal it before "
                          "it goes anywhere.")
        return out

    def released(self) -> dict:
        row = self.s.one("SELECT value FROM settings WHERE key='legacy_release'")
        if not row:
            return {}
        try:
            return json.loads(row["value"])
        except Exception:
            return {}

    def import_bundle(self, archive: Path, *, valid_kinds: tuple = (), dedupe_key: Optional[Callable] = None,
                      dry_run: bool = False) -> dict:
        """The receiving half: load a bundle into THIS installation.

        A bundle is only worth importing if it is intact, so verification is not
        optional here — an altered bundle is refused rather than partially applied.
        Original created/updated timestamps are preserved, because a memory dated
        today would silently rewrite the history it is supposed to carry.
        """
        archive = Path(archive)
        out: dict[str, Any] = {"ok": False, "path": str(archive), "imported": 0,
                               "skipped_existing": 0, "rejected_kinds": [], "problems": [],
                               "dry_run": dry_run}
        rep = self.verify(archive)
        out["verified"] = rep["ok"]
        if not rep["ok"]:
            out["problems"] = [f"refusing to import a bundle that does not verify: {p}" for p in rep["problems"]]
            return out

        work = Path(tempfile.mkdtemp(prefix="legacy-import-"))
        try:
            root = self._extract(archive, work / "unpacked")
            try:
                man = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
            except Exception as e:
                out["problems"] = [f"manifest unreadable: {type(e).__name__}: {e}"]
                return out
            out["bundle"] = {"schema": man.get("schema"), "created": man.get("created"),
                             "product_version": man.get("product_version"),
                             "identity": man.get("identity")}

            rows: list[dict] = []
            src = root / "memories.jsonl"
            if src.is_file():
                for line in src.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rows.append(json.loads(line))
                    except Exception:
                        out["problems"].append("a memories.jsonl line was not valid JSON and was skipped")

            if not valid_kinds:
                out["problems"].append("kinds were not validated — pass valid_kinds so an unknown kind "
                                       "cannot be written into the store")
            prov_base = {"source": "legacy-bundle", "bundle_schema": man.get("schema"),
                         "bundle_created": man.get("created"), "bundle_product_version": man.get("product_version")}

            for r in rows:
                kind = str(r.get("kind") or "fact")
                title = str(r.get("title") or "").strip()
                content = str(r.get("content") or "")
                if valid_kinds and kind not in valid_kinds:
                    out["rejected_kinds"].append(kind)
                    continue
                if not title:
                    out["problems"].append("a row had no title and was skipped")
                    continue
                ex = self.s.one("SELECT id FROM memories WHERE kind=? AND lower(title)=lower(?)", (kind, title))
                if ex:
                    out["skipped_existing"] += 1
                    continue
                if dry_run:
                    out["imported"] += 1
                    continue
                tags = ",".join(dict.fromkeys(
                    [t.strip() for t in str(r.get("tags") or "").split(",") if t.strip()] + ["legacy"]))
                prov = json.dumps({**prov_base, "original_id": r.get("id")}, ensure_ascii=False, default=str)
                created = float(r.get("created") or _now())
                updated = float(r.get("updated") or created)
                ded = dedupe_key(kind, title, content) if dedupe_key else None
                self.s.x("INSERT INTO memories(kind,title,content,tags,status,source_run,created,updated,"
                         "dedupe,provenance,scope) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                         (kind, title, content, tags, "migrated", "", created, updated, ded, prov, ""))
                out["imported"] += 1

            if not dry_run:
                self._log("legacy_import", path=str(archive), imported=out["imported"],
                          skipped=out["skipped_existing"])
            out["ok"] = not out["problems"]
            return out
        finally:
            shutil.rmtree(work, ignore_errors=True)
