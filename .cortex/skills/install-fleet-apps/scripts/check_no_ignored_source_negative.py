#!/usr/bin/env python3
"""Negative tests for check_no_ignored_source.py - each case leaves a source file
on disk that a fresh clone would not have, and the gate must name the file and
the rule that swallowed it.

The historical defect: the generic `env/` and `build/` rules matched real source
directories by NAME, so api/diagnostics/env/route.ts, api/matrix/build/route.ts
and a synapse tests/unit/build/ test lived only on the machine that wrote them,
and the admin Diagnostics and Matrix Builder pages 404'd on every fresh clone.
The second rule: a .gitignore rule the gate cannot classify fails too."""
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
API = f"{SK}/fleet_admin_app/ui/src/app/api"
SYN = f"{SK}/fleet_tools/vendor/synapse"
DIAG = f"{API}/diagnostics/env/route.ts"
DIAG_UNIGNORE = (f"!{API}/diagnostics/env/\n"
                 f"!{API}/diagnostics/env/**\n")

h = Harness("check_no_ignored_source.py")
gi = h.path(".gitignore")
gi_orig = gi.read_text()


def git(*args: str) -> None:
    subprocess.run(["git", "-C", str(h.root), *args], check=True, capture_output=True)


# The exact historical defect: the Diagnostics route exists on disk, untracked,
# because the scoped un-ignore for it is not there.
def diag_swallowed():
    assert DIAG_UNIGNORE in gi_orig, "diagnostics/env un-ignore anchor drifted"
    gi.write_text(gi_orig.replace(DIAG_UNIGNORE, ""))
    git("rm", "--cached", "-q", DIAG)


h.custom("diagnostics/env/route.ts swallowed by env/ (historical)", diag_swallowed,
         lambda: (gi.write_text(gi_orig), git("add", DIAG)),
         expect=f"{DIAG}\n      swallowed by .gitignore rule 'env/'")

# A new route under a directory named build/ with no un-ignore.
h.add(f"{API}/negtest/build/route.ts", "export async function GET() { return Response.json({}) }\n",
      expect="swallowed by .gitignore rule 'build/'",
      name="new route.ts under a build/ dir")

# A new synapse test dir named build/ (sibling of the un-ignored one).
h.add(f"{SYN}/tests/integration/build/schema.test.ts", "test('x', () => {})\n",
      expect=f"{SYN}/tests/integration/build/schema.test.ts\n      swallowed by .gitignore rule 'build/'",
      name="synapse test under an un-un-ignored build/ dir")

# SQL counts as source too: an env/ dir holding a module, with no pyvenv.cfg.
h.add(f"{SK}/scripts/env/region_defaults.sql", "SELECT 1;\n",
      expect="swallowed by .gitignore rule 'env/'",
      name="sql module under an env/ dir (not a virtualenv)")


# A rule the gate does not know - directory form.
def unclassified_dir():
    gi.write_text(gi_orig + "\nnegtest_scratch/\n")
    p = h.path(f"{SK}/negtest_scratch/notes.txt")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("x\n")


def undo_unclassified_dir():
    gi.write_text(gi_orig)
    h.path(f"{SK}/negtest_scratch/notes.txt").unlink(missing_ok=True)
    h.path(f"{SK}/negtest_scratch").rmdir()


h.custom("unclassified directory rule", unclassified_dir, undo_unclassified_dir,
         expect="matched by unclassified rule 'negtest_scratch/'")


# A rule the gate does not know - file glob form.
def unclassified_glob():
    gi.write_text(gi_orig + "\n*.bak\n")
    h.path(f"{SK}/scripts/seed_data.sql.bak").write_text("SELECT 1;\n")


h.custom("unclassified file-glob rule", unclassified_glob,
         lambda: (gi.write_text(gi_orig), h.path(f"{SK}/scripts/seed_data.sql.bak").unlink()),
         expect="matched by unclassified rule '*.bak'")

sys.exit(h.finish())
