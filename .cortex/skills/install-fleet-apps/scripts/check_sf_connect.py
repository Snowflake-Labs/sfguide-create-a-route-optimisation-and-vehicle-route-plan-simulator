#!/usr/bin/env python3
"""Gate: installer Python helpers open Snowflake sessions without connector noise.

Defect it pins: snowflake-connector-python 5.x (what a fresh .venv installs)
printed two FutureWarnings into every install console - keep-alive
auto-detection left unset, and a connection never closed - because four helpers
each called snowflake.connector.connect() directly.

Behavioural: sf_connect.connect() against fake connector modules.
  5.x-style (ConnectionConfig knows the field): option passed as False.
  3.x-style (no connection_config module, rejects unknown kwargs): not passed.
  Either way the connection is closed at interpreter exit.
Static: no other script calls snowflake.connector.connect() except the
standalone-staged STANDALONE files, which must carry the same guard and close().
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tempfile
import textwrap

HERE = pathlib.Path(__file__).resolve().parent
FIELD = "enable_server_session_keep_alive_auto_detection"
# Staged and run without its sibling modules (provision_engine.sh), so it
# cannot import sf_connect.
STANDALONE = {"download_map.py"}

FAKE_PKG = {
    "new": {
        "snowflake/__init__.py": "",
        # Mirrors 5.x: connect() registers its OWN atexit hook (after the caller's,
        # so LIFO runs it first) which warns on a still-open connection, unless
        # auto_cleanup=False.
        "snowflake/connector/__init__.py": textwrap.dedent('''
            import atexit, json, os
            class _Con:
                def __init__(self, kw):
                    self.kw, self.closed = kw, False
                    if kw.get("auto_cleanup", True):
                        atexit.register(self._at_exit)
                def _at_exit(self):
                    if not self.closed:
                        open(os.environ["FAKE_LOG"], "a").write("warned\\n")
                def close(self):
                    self.closed = True
                    open(os.environ["FAKE_LOG"], "a").write("closed\\n")
            def connect(**kw):
                open(os.environ["FAKE_LOG"], "a").write(json.dumps(sorted(kw.items())) + "\\n")
                return _Con(kw)
        '''),
        "snowflake/connector/connection_config.py": textwrap.dedent(f'''
            import dataclasses
            @dataclasses.dataclass
            class ConnectionConfig:
                {FIELD}: object = None
                auto_cleanup: object = None
        '''),
    },
    "old": {
        "snowflake/__init__.py": "",
        "snowflake/connector/__init__.py": textwrap.dedent(f'''
            import json, os
            class _Con:
                def close(self):
                    open(os.environ["FAKE_LOG"], "a").write("closed\\n")
            def connect(**kw):
                if "{FIELD}" in kw or "auto_cleanup" in kw:
                    raise TypeError("unknown parameter " + ",".join(sorted(kw)))
                open(os.environ["FAKE_LOG"], "a").write(json.dumps(sorted(kw.items())) + "\\n")
                return _Con()
        '''),
    },
}


LABEL = {"new": "5.x-style", "old": "3.x-style"}


def behave(kind: str) -> tuple[bool, str]:
    lab = LABEL[kind]
    with tempfile.TemporaryDirectory() as d:
        root = pathlib.Path(d)
        for rel, body in FAKE_PKG[kind].items():
            p = root / "pkg" / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body)
        log = root / "log"
        code = "import sf_connect; sf_connect.connect('c', session_parameters={'QUERY_TAG': 't'})"
        r = subprocess.run(
            [sys.executable, "-c", code], capture_output=True, text=True,
            env={"PYTHONPATH": f"{root / 'pkg'}:{HERE}", "FAKE_LOG": str(log),
                 "PYTHONDONTWRITEBYTECODE": "1", "PATH": "/usr/bin:/bin"})
        out = log.read_text() if log.exists() else ""
        if r.returncode != 0:
            return False, f"{lab} connector: connect raised: {r.stderr.strip()[-200:]}"
        lines = out.splitlines()
        if not lines:
            return False, f"{lab} connector: connect() never reached the connector"
        if kind == "new" and f'["{FIELD}", false]' not in lines[0]:
            return False, f"5.x-style connector: {FIELD}=False not passed ({lines[0]})"
        if kind == "old" and FIELD in lines[0]:
            return False, f"3.x-style connector: {FIELD} passed to a connector that rejects it"
        if '["connection_name", "c"]' not in lines[0]:
            return False, f"{lab} connector: connection_name not forwarded ({lines[0]})"
        if "closed" not in lines[1:]:
            return False, f"{lab} connector: connection not closed at exit"
        if "warned" in lines[1:]:
            return False, f"{lab} connector: connector's own exit hook warned before sf_connect closed"
        return True, f"{lab} connector ok"


CONNECT = re.compile(r"snowflake\.connector\.connect\(")


def static() -> list[str]:
    errs = []
    for f in sorted(HERE.glob("*.py")):
        if f.name in {"sf_connect.py", pathlib.Path(__file__).name} or f.name.startswith("check_"):
            continue
        src = "\n".join(l for l in f.read_text().splitlines() if not l.lstrip().startswith("#"))
        if not CONNECT.search(src):
            continue
        if f.name not in STANDALONE:
            errs.append(f"{f.name} calls snowflake.connector.connect() directly; use sf_connect.connect()")
        elif not re.search(r"""\[["']""" + FIELD + r"""["']\]\s*=\s*False|""" + FIELD + r"""\s*=\s*False""", src) \
                or ".close()" not in src:
            errs.append(f"{f.name} (standalone) lacks the {FIELD} guard or close()")
    return errs


def main() -> int:
    fails = []
    for kind in ("new", "old"):
        ok, msg = behave(kind)
        print(f"  {'ok  ' if ok else 'FAIL'} {msg}")
        if not ok:
            fails.append(msg)
    for e in static():
        print(f"  FAIL {e}")
        fails.append(e)
    if fails:
        print(f"sf_connect: {len(fails)} failure(s)")
        return 1
    print("sf_connect: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
