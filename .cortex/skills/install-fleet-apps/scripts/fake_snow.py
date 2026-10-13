#!/usr/bin/env python3
"""A record/replay stand-in for the `snow` CLI, so LIVE gates get negative tests
that run offline (in CI, with no account).

Why: a live gate's decision logic - "is this account healthy?" - is code, and
code that has never been seen to fail is not a gate. The decision can only be
exercised against an account that is BROKEN in a specific way, which a real
account rarely is on demand. So each live gate's responses are recorded once
from a healthy install (a cassette), and its negative test replays them with ONE
response altered to re-create a defect; the gate must then fail with the right
cause.

  record:  FAKE_SNOW_MODE=record FAKE_SNOW_CASSETTE=c.json FAKE_SNOW_REAL=$(command -v snow)
  replay:  FAKE_SNOW_MODE=replay FAKE_SNOW_CASSETTE=c.json [FAKE_SNOW_OVERRIDES='<json>']

Install by putting a directory holding an executable named `snow` (a copy of
this file) first on PATH; `fake_snow_bin()` does that. A request the cassette
does not hold FAILS LOUDLY (exit 99, "UNRECORDED") - a gate whose queries
changed must have its cassette re-recorded, never be passed by a guess.

Keys ignore the connection name (`-c X`) and replace a `-f FILE` with the
SHA-256 of the file's content, so a cassette is portable across connections
and checkouts. Recorded output is scrubbed of the recording account's locator,
organization, account name and user (see SCRUB); the cassette is committed.

Overrides (FAKE_SNOW_OVERRIDES, a JSON list; the first entry whose `match` is a
substring of the request key applies):
  {"match": "<substring of the key>", "rc": 1, "stdout": "...", "stderr": "..."}
  {"match": "...", "replace": [["old", "new"], ...]}   # edit recorded stdout
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile

SCRUB_ENV = "FAKE_SNOW_SCRUB"  # "A=>B;C=>D" applied to recorded text


def key_of(argv: list[str]) -> str:
    out, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a in ("-c", "--connection") and i + 1 < len(argv):
            i += 2
            continue
        if a in ("-f", "--filename") and i + 1 < len(argv):
            data = pathlib.Path(argv[i + 1]).read_bytes()
            out += [a, "sha256:" + hashlib.sha256(data).hexdigest()]
            i += 2
            continue
        out.append(a)
        i += 1
    return "\x1f".join(out)


def scrub(text: str) -> str:
    for pair in filter(None, os.environ.get(SCRUB_ENV, "").split(";")):
        old, _, new = pair.partition("=>")
        if old:
            text = text.replace(old, new)
    return text


def main(argv: list[str]) -> int:
    mode = os.environ.get("FAKE_SNOW_MODE", "replay")
    cassette = pathlib.Path(os.environ["FAKE_SNOW_CASSETTE"])
    key = key_of(argv)
    tape = json.loads(cassette.read_text()) if cassette.exists() else {}

    if mode == "record":
        p = subprocess.run([os.environ["FAKE_SNOW_REAL"], *argv], capture_output=True,
                           text=True)
        tape[key] = {"rc": p.returncode, "stdout": scrub(p.stdout), "stderr": scrub(p.stderr)}
        cassette.write_text(json.dumps(tape, indent=1, sort_keys=True) + "\n")
        sys.stdout.write(p.stdout)
        sys.stderr.write(p.stderr)
        return p.returncode

    rec = tape.get(key)
    for o in json.loads(os.environ.get("FAKE_SNOW_OVERRIDES") or "[]"):
        if o["match"] in key:
            rec = dict(rec or {"rc": 0, "stdout": "", "stderr": ""})
            for old, new in o.get("replace", []):
                rec["stdout"] = rec["stdout"].replace(old, new)
            for f in ("rc", "stdout", "stderr"):
                if f in o:
                    rec[f] = o[f]
            break
    if rec is None:
        sys.stderr.write("fake_snow: UNRECORDED request - re-record this gate's cassette "
                         f"(see fake_snow.py). key:\n{key[:2000]}\n")
        return 99
    sys.stdout.write(rec["stdout"])
    sys.stderr.write(rec["stderr"])
    return int(rec["rc"])


def fake_snow_bin() -> str:
    """A temp dir holding `snow` -> this script; prepend it to PATH."""
    d = tempfile.mkdtemp(prefix="fake_snow_")
    exe = pathlib.Path(d) / "snow"
    shutil.copy2(__file__, exe)
    exe.write_text(exe.read_text().replace("#!/usr/bin/env python3",
                                           f"#!{sys.executable}", 1))
    exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return d


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
