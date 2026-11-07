#!/usr/bin/env python3
"""
Bygger EN Python-fil som innehåller hela repot plus den färdigbyggda CLI:n.

Varför inte skriva om koden till Python? Då hade det varit en annan produkt.
Det här är samma projekt, packat: källkoden byte-för-byte i ett gzip-arkiv, och
CLI:n som redan är byggd, så att filen går att köra utan npm install.

Användning:
    python3 scripts/make_python_bundle.py            # -> dist/studdy-buddy-all.py
    python3 scripts/make_python_bundle.py --out X.py

Kräver att `npm run build` är körd först (dist/cli/studdy.mjs).
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import os
import gzip
import io
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent            # ai-teammates/
TEMPLATE = ROOT / "scripts" / "python-bundle-template.py.in"
CLI_BUNDLE = ROOT / "dist" / "cli" / "studdy.mjs"
VERSION_FILE = ROOT / "package.json"

# Ska aldrig med: det är genererat, installerat eller för stort.
# "bundles" får aldrig vara med: filen skulle då innehålla sig själv och växa
# för varje bygge (2,8 MB -> 5,7 MB upptäcktes genom att titta på storleken).
EXCLUDE_DIRS = {"node_modules", ".git", "dist", "build", "coverage", ".next",
                ".turbo", ".vitest", ".cache", "__pycache__", "bundles"}


def version() -> str:
    import json
    return json.loads(VERSION_FILE.read_text(encoding="utf-8"))["version"]


def tracked_files() -> list[str]:
    """Git-spårade filer, relativt repo-roten. Slipper node_modules och skräp."""
    out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO,
                         capture_output=True, check=True).stdout
    return [p for p in out.decode("utf-8").split("\0") if p]


def build_repo_tar(files: list[str]) -> tuple[bytes, list[str], list[str], int, list[str]]:
    """Returnerar (tar.gz-bytes, med-tagna filer, överhoppade, antal byte rått)."""
    raw = io.BytesIO()
    included: list[str] = []
    skipped: list[str] = []
    links: list[str] = []
    raw_bytes = 0

    with tarfile.open(fileobj=raw, mode="w") as tar:
        for rel in files:
            src = REPO / rel
            if set(Path(rel).parts) & EXCLUDE_DIRS:
                skipped.append(rel)
                continue
            if src.is_symlink():
                # Symlänkar bevaras som symlänkar. De pekar på .agents/skills,
                # som ligger i samma arkiv, så de fungerar efter uppackning.
                link = tarfile.TarInfo(rel)
                link.type = tarfile.SYMTYPE
                link.linkname = os.readlink(src)
                link.mtime = 0
                link.uid = link.gid = 0
                link.uname = link.gname = "root"
                tar.addfile(link)
                included.append(rel)
                links.append(f"{rel} -> {link.linkname}")
                continue
            if not src.is_file():
                skipped.append(rel)          # trasig länk eller submodul
                continue
            data = src.read_bytes()
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                # Behåll binärer också, men räkna dem så vi kan rapportera ärligt.
                pass
            raw_bytes += len(data)
            info = tarfile.TarInfo(rel)
            info.size = len(data)
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mode = 0o755 if rel.endswith((".sh", ".ps1", ".py")) else 0o644
            tar.addfile(info, io.BytesIO(data))
            included.append(rel)

    packed = gzip.compress(raw.getvalue(), compresslevel=9, mtime=0)
    return packed, included, skipped, raw_bytes, links


def wrap(b64: bytes, width: int = 100) -> str:
    text = base64.b64encode(b64).decode("ascii")
    return "\n".join(text[i:i + width] for i in range(0, len(text), width))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist" / "studdy-buddy-all.py"))
    args = ap.parse_args()

    if not CLI_BUNDLE.is_file():
        print("dist/cli/studdy.mjs saknas — kör `npm run build` först.", file=sys.stderr)
        return 2

    ver = version()
    files = tracked_files()
    repo_gz, included, skipped, raw_bytes, links = build_repo_tar(files)

    cli_raw = CLI_BUNDLE.read_bytes()
    cli_gz = gzip.compress(cli_raw, compresslevel=9, mtime=0)

    template = TEMPLATE.read_text(encoding="utf-8")
    substitutions = {
        "@@VERSION@@": ver,
        "@@BUILT@@": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "@@FILE_COUNT@@": str(len(included)),
        "@@RAW_BYTES@@": str(raw_bytes),
        "@@SKIPPED@@": str(len(skipped)),
        "@@GIT_SHA@@": subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO,
                                      capture_output=True, text=True).stdout.strip() or "okänd",
        "@@REPO_GZ_LEN@@": str(len(repo_gz)),
        "@@CLI_GZ_LEN@@": str(len(cli_gz)),
        "@@REPO_B64@@": wrap(repo_gz),
        "@@CLI_B64@@": wrap(cli_gz),
    }
    for key, value in substitutions.items():
        if key not in template:
            print(f"Mallen saknar platshållaren {key}", file=sys.stderr)
            return 2
        template = template.replace(key, value)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(template, encoding="utf-8", newline="\n")

    size = out.stat().st_size
    print(f"Skrev {out}")
    print(f"  filer i arkivet : {len(included)} (varav {len(links)} symlänkar, överhoppade {len(skipped)})")
    print(f"  rå källkod      : {raw_bytes/1e6:.2f} MB")
    print(f"  repo gzip       : {len(repo_gz)/1e3:.0f} kB")
    print(f"  cli gzip        : {len(cli_gz)/1e3:.0f} kB")
    print(f"  filstorlek      : {size/1e6:.2f} MB")
    for rel in skipped:
        print(f"  överhoppad      : {rel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
