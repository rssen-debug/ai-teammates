"""Tests for omega/legacy.py — encapsulating a context so it can outlive its owner.

The bundle is handed to another human being after the owner is gone, and nobody
will be around to ask what it was supposed to contain. So the properties that
matter are the ones a recipient cannot check for themselves: that the checksums
detect alteration, that credentials are absent by construction rather than by
filtering, that a hostile archive cannot write outside its destination, and that
nothing about the state is ambiguous — `sealed: false` must be recorded, not merely
true by omission.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

_SCRATCH = tempfile.mkdtemp(prefix="omega-legacy-test-")
os.environ.setdefault("BUDDY_HOME", _SCRATCH)

HERE = Path(__file__).resolve().parent
OMEGA = HERE.parent
for p in (str(OMEGA), str(HERE)):
    if p not in sys.path:
        sys.path.insert(0, p)

import buddy  # noqa: E402
import legacy as lg  # noqa: E402

_REAL_HOME = (Path(os.environ.get("APPDATA", str(Path.home()))) / "StuddyBuddy"
              if os.name == "nt" else Path.home() / ".studdybuddy")
assert Path(buddy.HOME) != _REAL_HOME, (
    f"buddy resolved HOME to the owner's real data directory ({buddy.HOME}). "
    "Refusing to run legacy tests against real user data.")


def tearDownModule() -> None:
    shutil.rmtree(_SCRATCH, ignore_errors=True)


class LegacyCase(unittest.TestCase):
    TABLES = ("memories", "skills", "runs", "level_history", "activity", "effects", "stats")

    def setUp(self) -> None:
        self.app = buddy.Buddy(headless=True)
        self.addCleanup(lambda: __import__("asyncio").run(self.app.close()))
        self.tmp = Path(tempfile.mkdtemp(prefix="legacy-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        for key in ("legacy_heir", "legacy_heartbeat", "legacy_grace_days", "legacy_release"):
            self.app.store.x("DELETE FROM settings WHERE key=?", (key,))
        # The DB outlives a test method; exported counts must not depend on which
        # test happened to run first.
        for t in self.TABLES:
            self.app.store.x(f"DELETE FROM {t}")
        self.bundle = lg.LegacyBundle(self.app.store, product_version="test",
                                     profile_builder=lambda d: {"window_days": d, "observed": {},
                                                                "inferred": {}, "evidence": {},
                                                                "coverage": {"total_evidence_rows": 0}})

    def seed(self) -> None:
        self.app.memory.save("preference", "favourite editor", "Neovim with the omega keymap", tags="editor")
        self.app.memory.save("fact", "studies in Kista", "KTH campus Kista", tags="study")
        self.app.memory.save("procedure", "fix WSL DNS", "1. edit resolv.conf\n2. restart", tags="wsl")


# ════════════════════════════════════════════════════════════════════════════
class TestBuild(LegacyCase):
    def test_builds_a_self_describing_bundle(self) -> None:
        self.seed()
        dest = self.tmp / "bundle"
        man = self.bundle.build(dest)
        self.assertTrue((dest / "manifest.json").is_file())
        for name in lg.LegacyBundle.FILES:
            self.assertTrue((dest / name).is_file(), f"{name} was not written")
        self.assertEqual(man["schema"], lg.SCHEMA)
        self.assertEqual(man["identity"], lg.IDENTITY)
        self.assertIn("not that person", man["notice"].lower())
        self.assertEqual(man["counts"]["memories"], 3)
        self.assertEqual(man["path"], str(dest))

    def test_every_payload_file_is_checksummed(self) -> None:
        self.seed()
        man = self.bundle.build(self.tmp / "bundle")
        for name in lg.LegacyBundle.FILES:
            self.assertIn(name, man["checksums"], f"{name} has no checksum")
            self.assertEqual(len(man["checksums"][name]), 64, "expected a sha256 hex digest")

    def test_credentials_are_absent_by_construction(self) -> None:
        """Not filtered out — never read. A denylist fails the day someone adds a key."""
        self.seed()
        self.app.settings.set("models", {"chat": "kilo-auto/free"})
        self.app.settings.set("some_new_secret_token", "hunter2")     # not in the allowlist
        self.app.settings.set("kilo_api_key", "should-never-appear")   # named like a secret too
        man = self.bundle.build(self.tmp / "bundle")
        raw = (self.tmp / "bundle" / "settings.json").read_text(encoding="utf-8")
        self.assertNotIn("hunter2", raw)
        self.assertNotIn("should-never-appear", raw)
        self.assertNotIn("kilo_api_key", raw)
        exported = json.loads(raw)["values"]
        self.assertIn("models", exported, "an allowlisted key must still be exported")
        self.assertNotIn("some_new_secret_token", exported)
        self.assertEqual(man["counts"]["settings"], len(exported))

    def test_secret_shaped_keys_are_recognised(self) -> None:
        for k in ("kilo_api_key", "API_KEY", "oauth_token", "client_secret", "db_password",
                  "Authorization", "session_token", "vault"):
            self.assertTrue(lg.is_secret_key(k), f"{k} must be treated as a secret")
        for k in ("models", "retention_days", "observe_enabled", "trust_mode"):
            self.assertFalse(lg.is_secret_key(k), f"{k} is not a secret")

    def test_the_bundle_records_that_it_is_not_encrypted(self) -> None:
        """Ambiguity here is the danger: an heir who assumes it is sealed will mishandle it."""
        man = self.bundle.build(self.tmp / "bundle")
        self.assertFalse(man["sealed"])
        self.assertEqual(man["seal_method"], "")
        self.assertTrue(any("NOT encrypted" in w for w in man["warnings"]),
                        "the manifest must say out loud that the bundle is plaintext")
        readme = (self.tmp / "bundle" / "README.txt").read_text(encoding="utf-8")
        self.assertIn("gpg", readme, "and tell the owner how to seal it properly")

    def test_dpapi_style_account_sealing_is_not_used(self) -> None:
        """A bundle sealed to the owner's account could never be opened by the heir,
        which would make it perfectly safe and permanently useless."""
        src = (OMEGA / "legacy.py").read_text(encoding="utf-8")
        self.assertNotIn("CryptProtectData", src)

    def test_an_empty_bundle_says_it_is_empty(self) -> None:
        man = self.bundle.build(self.tmp / "bundle")
        self.assertEqual(man["counts"]["memories"], 0)
        self.assertTrue(any("almost empty" in w for w in man["warnings"]))

    def test_a_tar_archive_is_built_and_verifies(self) -> None:
        self.seed()
        arc = self.tmp / "bundle.tar.gz"
        man = self.bundle.build(arc)
        self.assertTrue(arc.is_file())
        self.assertFalse((self.tmp / "bundle-build").exists(), "the staging directory must be cleaned up")
        self.assertEqual(man["counts"]["memories"], 3)
        rep = self.bundle.verify(arc)
        self.assertTrue(rep["ok"], rep["problems"])

    def test_rebuilding_replaces_the_previous_bundle(self) -> None:
        self.seed()
        dest = self.tmp / "bundle"
        self.bundle.build(dest)
        self.app.memory.save("fact", "one more", "content", tags="x")
        man = self.bundle.build(dest)
        self.assertEqual(man["counts"]["memories"], 4)


# ════════════════════════════════════════════════════════════════════════════
class TestVerify(LegacyCase):
    def test_a_fresh_bundle_verifies(self) -> None:
        self.seed()
        dest = self.tmp / "bundle"
        self.bundle.build(dest)
        rep = self.bundle.verify(dest)
        self.assertTrue(rep["ok"], rep["problems"])
        self.assertTrue(rep["checks"]["schema_matches"])
        self.assertTrue(rep["checks"]["identity_is_a_record_not_a_person"])
        self.assertTrue(rep["checks"]["carries_the_notice"])

    def test_altering_a_payload_file_is_detected(self) -> None:
        """The recipient cannot check this themselves, so the checksum has to."""
        self.seed()
        dest = self.tmp / "bundle"
        self.bundle.build(dest)
        f = dest / "memories.jsonl"
        f.write_text(f.read_text(encoding="utf-8") + '{"id":999,"title":"invented"}\n', encoding="utf-8")
        rep = self.bundle.verify(dest)
        self.assertFalse(rep["ok"])
        self.assertFalse(rep["checks"]["sha256:memories.jsonl"])
        self.assertTrue(any("altered or truncated" in p for p in rep["problems"]))

    def test_deleting_a_payload_file_is_detected(self) -> None:
        self.seed()
        dest = self.tmp / "bundle"
        self.bundle.build(dest)
        (dest / "skills.jsonl").unlink()
        rep = self.bundle.verify(dest)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("missing" in p for p in rep["problems"]))

    def test_a_directory_without_a_manifest_is_not_a_bundle(self) -> None:
        d = self.tmp / "notabundle"
        d.mkdir()
        (d / "hello.txt").write_text("hi", encoding="utf-8")
        rep = self.bundle.verify(d)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("not a legacy bundle" in p for p in rep["problems"]))

    def test_a_missing_bundle_is_reported_not_raised(self) -> None:
        rep = self.bundle.verify(self.tmp / "does-not-exist")
        self.assertFalse(rep["ok"])
        self.assertTrue(any("no such bundle" in p for p in rep["problems"]))

    def test_a_foreign_schema_is_rejected(self) -> None:
        self.seed()
        dest = self.tmp / "bundle"
        self.bundle.build(dest)
        m = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
        m["schema"] = "someone.elses.bundle/v9"
        (dest / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
        rep = self.bundle.verify(dest)
        self.assertFalse(rep["ok"])
        self.assertFalse(rep["checks"]["schema_matches"])

    def test_an_archive_member_escaping_the_destination_is_refused(self) -> None:
        """A bundle is imported by someone who trusts it. `../` in a tar member
        would let a crafted bundle overwrite the importer's own files."""
        evil = self.tmp / "evil.tar"
        with tarfile.open(evil, "w") as tf:
            for name in ("../escaped.txt", "/etc/absolute.txt", "nested/../../out.txt"):
                data = b"payload"
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, __import__("io").BytesIO(data))
        rep = self.bundle.verify(evil)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("unsafe path" in p for p in rep["problems"]), rep["problems"])
        self.assertFalse((self.tmp.parent / "escaped.txt").exists())


# ════════════════════════════════════════════════════════════════════════════
class TestInspect(LegacyCase):
    def test_inspect_reports_contents_without_importing_them(self) -> None:
        self.seed()
        arc = self.tmp / "bundle.tar.gz"
        self.bundle.build(arc)
        before = self.app.store.one("SELECT COUNT(*) AS n FROM memories")["n"]
        info = self.bundle.inspect(arc)
        self.assertTrue(info["verified"])
        self.assertEqual(info["counts"]["memories"], 3)
        self.assertIn("favourite editor", info["sample_titles"])
        self.assertEqual(self.app.store.one("SELECT COUNT(*) AS n FROM memories")["n"], before,
                         "inspecting must not write anything")


# ════════════════════════════════════════════════════════════════════════════
class TestHeirAndHeartbeat(LegacyCase):
    def test_heir_roundtrips(self) -> None:
        h = self.bundle.set_heir("Anna Andersson", "anna@example.com", "sister", "ask before reading")
        self.assertEqual(h["name"], "Anna Andersson")
        self.assertEqual(self.bundle.heir()["relationship"], "sister")

    def test_no_heir_is_an_empty_dict_not_an_error(self) -> None:
        self.assertEqual(self.bundle.heir(), {})

    def test_a_fresh_heartbeat_means_the_owner_is_active(self) -> None:
        self.bundle.heartbeat()
        c = self.bundle.check()
        self.assertEqual(c["state"], "owner_recently_active")
        self.assertFalse(c["releasable"])
        self.assertLess(c["days_since_heartbeat"], 1.0)

    def test_no_heartbeat_concludes_nothing(self) -> None:
        c = self.bundle.check()
        self.assertEqual(c["state"], "never_recorded")
        self.assertFalse(c["releasable"], "absence of evidence must not become evidence of death")
        self.assertIn("nothing can be concluded", c["detail"])

    def test_an_elapsed_grace_period_is_reported_as_releasable(self) -> None:
        old = {"last": time.time() - 200 * 86400, "at": "2026-04-01T00:00:00", "grace_days": 90.0}
        self.app.store.x("INSERT INTO settings(key,value) VALUES('legacy_heartbeat',?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(old),))
        c = self.bundle.check()
        self.assertEqual(c["state"], "grace_elapsed")
        self.assertTrue(c["releasable"])
        self.assertGreater(c["days_since_heartbeat"], 199.0)

    def test_releasable_never_means_transmitted(self) -> None:
        """The single most important property: a decision, not an action."""
        old = {"last": time.time() - 400 * 86400, "at": "x", "grace_days": 90.0}
        self.app.store.x("INSERT INTO settings(key,value) VALUES('legacy_heartbeat',?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(old),))
        c = self.bundle.check()
        self.assertTrue(c["releasable"])
        # Pinned verbatim: this sentence is a safety claim, not prose to be
        # prettified later.
        self.assertIn("nothing is ever transmitted automatically", c["detail"].lower())
        self.assertFalse(hasattr(self.bundle, "send"), "there must be no send method at all")
        self.assertFalse(hasattr(self.bundle, "email"))
        self.assertFalse(hasattr(self.bundle, "transmit"))

    def test_grace_period_is_configurable_and_floored(self) -> None:
        self.assertEqual(self.bundle.set_grace_days(30), 30.0)
        self.assertEqual(self.bundle.check()["grace_days"], 30.0)
        self.assertEqual(self.bundle.set_grace_days(0), 1.0, "a zero-day grace is not a grace period")
        self.assertEqual(self.bundle.set_grace_days(-5), 1.0)


# ════════════════════════════════════════════════════════════════════════════
class TestRelease(LegacyCase):
    def setUp(self) -> None:
        super().setUp()
        self.seed()
        self.arc = self.tmp / "bundle.tar.gz"
        self.bundle.build(self.arc)

    def test_release_refuses_without_the_typed_phrase(self) -> None:
        r = self.bundle.release(self.arc)
        self.assertFalse(r["ok"])
        self.assertFalse(r["released"])
        self.assertIn("hint", r, "and it must tell you how to confirm non-interactively")
        self.assertFalse(self.bundle.released())

    def test_the_phrase_is_not_accepted_as_an_argv_flag(self) -> None:
        """A flag lands in shell history and the process list, where anyone who can
        read them can replay a decision that was supposed to be deliberate."""
        src = (OMEGA / "legacy.py").read_text(encoding="utf-8")
        self.assertNotIn("--yes", src.split("def release")[1].split("def released")[0])

    def test_release_refuses_a_bundle_that_does_not_verify(self) -> None:
        (self.tmp / "bundle-build").mkdir(exist_ok=True)
        bad = self.tmp / "broken.tar.gz"
        with tarfile.open(bad, "w:gz") as tf:
            data = b"x"
            info = tarfile.TarInfo("manifest.json")
            info.size = len(data)
            tf.addfile(info, __import__("io").BytesIO(data))
        r = self.bundle.release(bad, phrase=lg.LegacyBundle.RELEASE_PHRASE)
        self.assertFalse(r["ok"])
        self.assertTrue(any("does not verify" in p for p in r["problems"]))

    def test_release_with_the_phrase_records_but_transmits_nothing(self) -> None:
        r = self.bundle.release(self.arc, phrase=lg.LegacyBundle.RELEASE_PHRASE)
        self.assertTrue(r["ok"], r["problems"])
        self.assertTrue(r["released"])
        self.assertIn("gpg", r["seal_warning"], "it must still say the bundle is plaintext")
        rec = self.bundle.released()
        self.assertEqual(rec["path"], str(self.arc))
        self.assertTrue(rec["checksums"], "the release record must pin what was released")
        self.assertIn("Nothing was transmitted", r["detail"])

    def test_a_partial_or_shouted_phrase_is_not_the_phrase(self) -> None:
        for bad in ("release", "RELEASE TO MY HEIR", "", "yes", "release to heir",
                    "release to my heirs"):
            r = self.bundle.release(self.arc, phrase=bad)
            self.assertFalse(r["released"], f"{bad!r} must not release")

    def test_a_piped_phrase_arrives_with_a_newline_and_still_works(self) -> None:
        """`echo "release to my heir" | buddy legacy release PATH` is the documented
        non-interactive path, so trailing whitespace is input, not a wrong answer."""
        r = self.bundle.release(self.arc, phrase=lg.LegacyBundle.RELEASE_PHRASE + "\n")
        self.assertTrue(r["released"], r["problems"])


# ════════════════════════════════════════════════════════════════════════════
class TestImport(LegacyCase):
    """The receiving half. `Store` is constructible on its own, so these run against
    a genuinely separate installation rather than a wiped table."""

    def build_source(self) -> Path:
        self.seed()
        arc = self.tmp / "bundle.tar.gz"
        self.bundle.build(arc)
        return arc

    def fresh(self) -> lg.LegacyBundle:
        store = buddy.Store(self.tmp / "heir.db")
        self.addCleanup(store.db.close)
        return lg.LegacyBundle(store, product_version="heir-test")

    def test_imports_with_original_timestamps_and_provenance(self) -> None:
        arc = self.build_source()
        before = {r["title"]: r["created"] for r in
                  self.app.store.q("SELECT title, created FROM memories")}
        dst = self.fresh()
        rep = dst.import_bundle(arc, valid_kinds=buddy.Memory.KINDS,
                                dedupe_key=buddy.Memory.dedupe_key)
        self.assertTrue(rep["ok"], rep["problems"])
        self.assertEqual(rep["imported"], 3)
        rows = {r["title"]: r for r in dst.s.q("SELECT * FROM memories")}
        self.assertEqual(set(rows), set(before))
        for title, created in before.items():
            self.assertAlmostEqual(rows[title]["created"], created, delta=1.0,
                                   msg=f"{title}: a memory dated today would rewrite the history it carries")
            self.assertEqual(rows[title]["status"], "migrated")
            self.assertIn("legacy", rows[title]["tags"])
            prov = json.loads(rows[title]["provenance"])
            self.assertEqual(prov["source"], "legacy-bundle")
            self.assertEqual(prov["bundle_schema"], lg.SCHEMA)

    def test_a_second_import_adds_nothing(self) -> None:
        arc = self.build_source()
        dst = self.fresh()
        dst.import_bundle(arc, valid_kinds=buddy.Memory.KINDS)
        rep = dst.import_bundle(arc, valid_kinds=buddy.Memory.KINDS)
        self.assertEqual(rep["imported"], 0)
        self.assertEqual(rep["skipped_existing"], 3)
        self.assertEqual(dst.s.one("SELECT COUNT(*) AS n FROM memories")["n"], 3)

    def test_import_refuses_a_tampered_bundle(self) -> None:
        arc = self.build_source()
        d = self.tmp / "dir-bundle"
        self.bundle.build(d)
        (d / "profile.json").write_text('{"injected": true}', encoding="utf-8")
        rep = self.fresh().import_bundle(d, valid_kinds=buddy.Memory.KINDS)
        self.assertFalse(rep["ok"])
        self.assertFalse(rep["verified"])
        self.assertEqual(rep["imported"], 0)
        self.assertEqual(self.fresh().s.one("SELECT COUNT(*) AS n FROM memories")["n"], 0)

    def test_dry_run_reports_without_writing(self) -> None:
        arc = self.build_source()
        dst = self.fresh()
        rep = dst.import_bundle(arc, valid_kinds=buddy.Memory.KINDS, dry_run=True)
        self.assertEqual(rep["imported"], 3)
        self.assertTrue(rep["dry_run"])
        self.assertEqual(dst.s.one("SELECT COUNT(*) AS n FROM memories")["n"], 0,
                         "a dry run must not write")

    def test_unknown_kinds_are_rejected_not_written(self) -> None:
        self.seed()
        self.app.memory.save("fact", "an alien kind", "x", tags="a")
        self.app.store.x("UPDATE memories SET kind='invented_kind' WHERE title='an alien kind'")
        arc = self.tmp / "bundle.tar.gz"
        self.bundle.build(arc)
        dst = self.fresh()
        rep = dst.import_bundle(arc, valid_kinds=buddy.Memory.KINDS)
        self.assertIn("invented_kind", rep["rejected_kinds"])
        self.assertEqual(dst.s.one("SELECT COUNT(*) AS n FROM memories")["n"], 3)

    def test_every_report_names_its_own_path(self) -> None:
        """The CLI renders `rep["path"]` in the header of every one of these. A report
        that omits it turns a readable answer into a KeyError traceback, which is how
        this was actually found — so it is pinned rather than left to smoke tests."""
        arc = self.build_source()
        dst = self.fresh()
        for rep in (dst.import_bundle(arc, valid_kinds=buddy.Memory.KINDS, dry_run=True),
                    dst.import_bundle(self.tmp / "absent.tar.gz", valid_kinds=buddy.Memory.KINDS),
                    dst.verify(arc), dst.inspect(arc),
                    dst.release(arc), dst.release(arc, phrase=lg.LegacyBundle.RELEASE_PHRASE)):
            self.assertIn("path", rep, f"{rep} has no path")
            self.assertTrue(str(rep["path"]), "path must not be empty")

    def test_importing_without_kind_validation_says_so(self) -> None:
        """Silently accepting any kind would let a bundle write rows the rest of the
        product cannot handle, so the omission is reported rather than assumed fine."""
        arc = self.build_source()
        rep = self.fresh().import_bundle(arc)
        self.assertFalse(rep["ok"])
        self.assertTrue(any("kinds were not validated" in p for p in rep["problems"]))
        self.assertEqual(rep["imported"], 3, "it still imports — the note is a warning, not a refusal")


# ════════════════════════════════════════════════════════════════════════════
class TestCli(LegacyCase):
    """Every subcommand, as a real subprocess.

    These exist because two KeyErrors (`inspect` and `import_bundle` both omitted
    `path`, which the CLI renders in its header) survived 36 unit tests and were only
    found by running the commands. Unit tests that call the module directly cannot
    see a rendering contract, so the CLI is tested as the CLI.
    """

    def run_cli(self, *argv: str, home: Path | None = None, stdin: str = "") -> tuple[int, str]:
        env = dict(os.environ, BUDDY_HOME=str(home or Path(buddy.HOME)), NO_COLOR="1")
        r = __import__("subprocess").run([sys.executable, str(OMEGA / "buddy.py"), *argv],
                                         capture_output=True, text=True, input=stdin, env=env,
                                         cwd=str(OMEGA.parent), timeout=180)
        out = (r.stdout or "") + (r.stderr or "")
        self.assertNotIn("Traceback", out,
                         f"`buddy {' '.join(argv)}` raised instead of reporting:\n{out}")
        return r.returncode, out

    def test_status_is_the_default_and_reports(self) -> None:
        for argv in (("legacy",), ("legacy", "status")):
            rc, out = self.run_cli(*argv)
            self.assertEqual(rc, 0, out)
            self.assertIn("LEGACY", out)
            self.assertIn("is ever transmitted automatically", out)

    def test_build_verify_inspect_roundtrip(self) -> None:
        arc = self.tmp / "cli.tar.gz"
        rc, out = self.run_cli("legacy", "build", str(arc), "--days", "30")
        self.assertEqual(rc, 0, out)
        self.assertIn("BUILT", out)
        self.assertTrue(arc.is_file())
        rc, out = self.run_cli("legacy", "verify", str(arc))
        self.assertEqual(rc, 0, out)
        self.assertIn("VERIFIED", out)
        rc, out = self.run_cli("legacy", "inspect", str(arc))
        self.assertEqual(rc, 0, out)
        self.assertIn("INSPECT", out)
        self.assertIn("Nothing was imported", out)

    def test_a_missing_bundle_exits_1_without_raising(self) -> None:
        for argv in (("legacy", "verify"), ("legacy", "inspect"), ("legacy", "import")):
            rc, out = self.run_cli(*argv, str(self.tmp / "absent.tar.gz"))
            self.assertEqual(rc, 1, f"{argv} should report failure, got {rc}: {out}")

    def test_a_flag_value_is_not_absorbed_into_the_heir_name(self) -> None:
        """Regression: `positional` was filtered on `startswith("--")` only, so the
        email and relationship became part of the name."""
        rc, out = self.run_cli("legacy", "heir", "set", "Anna Andersson",
                               "--email", "anna@example.com", "--relation", "sister")
        self.assertEqual(rc, 0, out)
        rc, out = self.run_cli("legacy", "heir", "show")
        self.assertEqual(rc, 0, out)
        self.assertIn("Anna Andersson", out)
        self.assertNotIn("Anna Andersson anna@example.com", out)
        for line in out.splitlines():
            if line.strip().startswith("name"):
                self.assertEqual(line.split("name", 1)[1].strip(), "Anna Andersson",
                                 "the name row must hold the name only")

    def test_heartbeat_and_check(self) -> None:
        rc, out = self.run_cli("legacy", "heartbeat")
        self.assertEqual(rc, 0, out)
        self.assertIn("heartbeat recorded", out)
        rc, out = self.run_cli("legacy", "check")
        self.assertEqual(rc, 0, out)
        self.assertIn("OWNER RECENTLY ACTIVE", out)
        self.assertIn("releasable", out)

    def test_release_needs_the_typed_phrase(self) -> None:
        arc = self.tmp / "rel.tar.gz"
        self.run_cli("legacy", "build", str(arc))
        rc, out = self.run_cli("legacy", "release", str(arc), stdin="yes\n")
        self.assertEqual(rc, 2, out)
        self.assertIn("not released", out)
        rc, out = self.run_cli("legacy", "release", str(arc), stdin="release to my heir\n")
        self.assertEqual(rc, 0, out)
        self.assertIn("RELEASED", out)
        self.assertIn("Nothing was transmitted", out)

    def test_import_reports_counts(self) -> None:
        self.seed()
        arc = self.tmp / "imp.tar.gz"
        self.run_cli("legacy", "build", str(arc))
        rc, out = self.run_cli("legacy", "import", str(arc))
        self.assertEqual(rc, 0, out)
        # Importing into the very installation that built the bundle must find all
        # three already present rather than duplicating them.
        self.assertIn("imported      0", out)
        self.assertIn("already present 3", out)

    def test_unknown_subcommand_prints_usage(self) -> None:
        rc, out = self.run_cli("legacy", "teleport")
        self.assertEqual(rc, 2, out)
        self.assertIn("usage: buddy legacy", out)

    def test_every_documented_subcommand_is_reachable(self) -> None:
        """The standing requirement: everything exists via the CLI. A name in USAGE
        that is not wired is a defect, and one that is wired but undocumented hides."""
        import re
        usage = buddy.USAGE
        documented = set(re.findall(r"^\s*buddy legacy ([a-z][a-z0-9_-]*)", usage, re.M))
        handled = {"status", "show", "build", "verify", "inspect", "heir", "heartbeat",
                   "check", "release", "import"}
        self.assertTrue(documented, "no `buddy legacy X` lines were found in USAGE")
        self.assertEqual(documented - handled, set(),
                         "USAGE documents a legacy subcommand that cmd_legacy does not handle")
        self.assertEqual(handled - documented - {"show"}, set(),
                         "cmd_legacy handles a subcommand USAGE never mentions")


if __name__ == "__main__":
    unittest.main(verbosity=2)
