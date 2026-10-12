"""Shared harness for gate negative tests ("a gate never seen to fail is not a gate").

Every gate in gates.yaml must carry a negative test that re-introduces the defect
it exists to catch and asserts the gate convicts it with the RIGHT cause. This
module makes each such test a short list of mutations:

    from negtest import Harness
    h = Harness("check_warehouse_ddl.py")
    h.replace("path/to/warehouses.sql", "AUTO_SUSPEND = 60", "AUTO_SUSPEND = 600",
              expect="AUTO_SUSPEND")
    h.add("path/to/new.sql", "CREATE WAREHOUSE X;\\n", expect="X")
    sys.exit(h.finish())

Guarantees, so a negative test cannot pass vacuously:
  * the gate runs from a COPY of the tracked tree (files under 2 MB; the
    checkout is never touched), set up once as a git repo for git-based gates
  * the UNMODIFIED copy must pass first - a red baseline proves nothing
  * every mutation must change its file (a drifted anchor is an error, not a
    silent no-op), the gate must exit non-zero, and its output must contain
    `expect` - failing for the wrong reason does not count
  * each mutation is undone before the next, so cases cannot mask each other

Gates find the repo from their own path (parents[N]) or `git rev-parse`; both
resolve to the copy because the gate script itself runs from inside it.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[4]
SCRIPTS_REL = ".cortex/skills/install-fleet-apps/scripts"
MAX_BYTES = 2_000_000


class Harness:
    def __init__(self, gate: str, args: list[str] | None = None,
                 env: dict[str, str] | None = None, interpreter: str | None = None):
        self.gate, self.args = gate, list(args or [])
        self.env = dict(os.environ, **(env or {}))
        self.interpreter = interpreter or ("bash" if gate.endswith(".sh") else sys.executable)
        self.cases = self.passed = 0
        self.failures: list[str] = []
        self._tmp = tempfile.TemporaryDirectory(prefix="negtest_")
        self.root = pathlib.Path(self._tmp.name) / "repo"
        self._copy_tree()
        rc, out = self.run()
        self.baseline_ok = rc == 0
        print(f"{gate}: negative tests")
        print(f"  {'ok  ' if self.baseline_ok else 'FAIL'} baseline passes on the unmodified tree")
        if not self.baseline_ok:
            self.failures.append(f"baseline is red (rc={rc}) - nothing below proves anything:\n"
                                 + out[-2000:])

    def _copy_tree(self) -> None:
        files = subprocess.run(["git", "-C", str(REPO), "ls-files", "-z"], capture_output=True,
                               text=True, check=True).stdout.split("\0")
        for rel in filter(None, files):
            src = REPO / rel
            if not src.is_file() or src.stat().st_size > MAX_BYTES:
                continue
            dst = self.root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        git = ["git", "-C", str(self.root), "-c", "user.email=n@t", "-c", "user.name=negtest",
               "-c", "core.hooksPath=/dev/null"]
        subprocess.run(git[:3] + ["init", "-q"], check=True)
        subprocess.run(git + ["add", "-A"], check=True)
        subprocess.run(git + ["commit", "-qm", "negtest baseline"], check=True)

    def path(self, rel: str) -> pathlib.Path:
        return self.root / rel

    def run(self) -> tuple[int, str]:
        gate = self.root / SCRIPTS_REL / self.gate
        p = subprocess.run([self.interpreter, str(gate), *self.args], cwd=self.root,
                           capture_output=True, text=True, env=self.env, timeout=600)
        return p.returncode, p.stdout + p.stderr

    # ── mutation primitives ──────────────────────────────────────────────────
    def _case(self, name: str, apply, undo, expect: str) -> None:
        self.cases += 1
        if not self.baseline_ok:
            return
        try:
            apply()
        except AssertionError as e:
            self.failures.append(f"{name}: {e}")
            print(f"  FAIL {name} (mutation did not apply)")
            return
        try:
            rc, out = self.run()
        finally:
            undo()
        ok = rc != 0 and expect in out
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
        if ok:
            self.passed += 1
        else:
            why = "gate PASSED" if rc == 0 else f"gate failed (rc={rc}) but not with {expect!r}"
            self.failures.append(f"{name}: {why}\n{out[-1500:]}")

    def replace(self, rel: str, old: str, new: str, expect: str, name: str | None = None,
                count: int = 1) -> None:
        p = self.path(rel)
        original = p.read_text() if p.exists() else None

        def apply():
            assert original is not None, f"{rel} does not exist in the tree"
            assert old in original, f"anchor not found in {rel}: {old[:80]!r}"
            changed = original.replace(old, new, count)
            assert changed != original, f"mutation leaves {rel} unchanged"
            p.write_text(changed)

        self._case(name or f"{rel}: {old[:40]!r} -> {new[:40]!r}", apply,
                   lambda: original is not None and p.write_text(original), expect)

    def add(self, rel: str, content: str, expect: str, name: str | None = None) -> None:
        p = self.path(rel)

        def apply():
            assert not p.exists(), f"{rel} already exists - pick a new path"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)

        self._case(name or f"add {rel}", apply, lambda: p.unlink(missing_ok=True), expect)

    def delete(self, rel: str, expect: str, name: str | None = None) -> None:
        p = self.path(rel)
        original = p.read_bytes() if p.exists() else None

        def apply():
            assert original is not None, f"{rel} does not exist in the tree"
            p.unlink()

        self._case(name or f"delete {rel}", apply,
                   lambda: original is not None and p.write_bytes(original), expect)

    def custom(self, name: str, apply, undo, expect: str) -> None:
        """Escape hatch: apply() must change the tree, undo() must restore it."""
        self._case(name, apply, undo, expect)

    def finish(self) -> int:
        self._tmp.cleanup()
        if not self.failures and self.cases == 0:
            self.failures.append("no mutation cases - a negative test must convict something")
        if self.failures:
            print(f"FAIL: {self.gate} - {len(self.failures)} problem(s):")
            for f in self.failures:
                print("  ---- " + f.replace("\n", "\n       "))
            return 1
        print(f"OK: {self.gate} - {self.passed}/{self.cases} mutations convicted with the right cause")
        return 0
