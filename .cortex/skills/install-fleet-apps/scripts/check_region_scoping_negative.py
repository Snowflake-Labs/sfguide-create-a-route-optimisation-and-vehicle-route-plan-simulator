#!/usr/bin/env python3
"""Negative tests for RULE 5 and RULE 6 of check_region_scoping.py.

Every rule is broken here ON A THROWAWAY COPY of the tree and the gate must FAIL
for the stated reason. Nothing under the real repo is written.

This exists because a gate that has never been seen to fail is not a gate, and
one of these rules was genuinely wrong when first written: RULE 6 case-folded
both halves of the comparison, so it flagged `filters.source === 'internal'` - a
UI filter token, on a line whose row test already reads p.isInternal - and would
have been "fixed" by loosening the rule rather than by scoping the column half.

The PASS cases matter as much as the FAIL cases. Three of them exist to pin the
rule's boundaries: a proc with no region argument has nothing better than CONFIG
to read; the idempotent IFF remap compares SOURCE to 'INTERNAL' precisely in
order to remove the value; and DECISION_SOURCE legitimately carries INTERNAL as
the reserved own-fleet token.
"""
from __future__ import annotations

import importlib.util
import io
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "check_region_scoping.py"
REPO = HERE.parents[3]

PROC_REL = ".cortex/skills/routing-agent/references/deploy-agent.sql"
OFFERS_REL = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/studio/engine/offers.ts"
LIST_REL = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching/AssignmentList.tsx"
SEED_REL = ".cortex/skills/backload-matching/references/backfill-freight-offers.sql"
PROPOSALS_REL = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-proposals.tsx"
REL = [PROC_REL, OFFERS_REL, LIST_REL, SEED_REL, PROPOSALS_REL]


def load_gate():
    spec = importlib.util.spec_from_file_location("rs_gate", GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def stage(tmp: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for rel in REL:
        dst = tmp / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / rel, dst)
        out[rel] = dst
    # The gate asserts REPO_ROOT has an AGENTS.md; the copy must look like a repo.
    (tmp / "AGENTS.md").write_text("staged copy\n", encoding="utf-8")
    return out


def point_gate_at(mod, tmp: Path) -> None:
    mod.REPO_ROOT = tmp
    mod.RULE5_GLOBS = [(tmp / ".cortex" / "skills", "**/*.sql")]
    mod.RULE6_GLOBS = [(tmp / ".cortex" / "skills", "**/*.ts"),
                       (tmp / ".cortex" / "skills", "**/*.tsx")]
    mod.RULE6_SQL_GLOBS = [(tmp / ".cortex" / "skills", "**/*.sql")]
    # Silence the unrelated rules: they glob the real skill dir, which is not
    # staged here, so they would report on files this harness does not mutate.
    mod.RULE1_GLOBS = []
    mod.TWIN_ONLY_GLOBS = []
    mod.RULE4_GLOBS = []
    mod.SEMANTIC_GLOBS = []


def sub(path: Path, old: str, new: str, *, count: int = 1) -> None:
    src = path.read_text(encoding="utf-8")
    if old not in src:
        raise AssertionError(f"mutation anchor not found in {path.name}: {old[:80]!r}")
    path.write_text(src.replace(old, new, count), encoding="utf-8")


REGION_VT_READ = (
    '            "SELECT CURRENT_LOAD AS VEHICLE_TYPE, COUNT(*) AS N "\n'
    '          + "FROM FLEET_APP.BACKLOAD_MATCHING.VW_TRAILERS "\n'
    '          + "WHERE REGION = ? AND CURRENT_LOAD IS NOT NULL "\n'
    '          + "GROUP BY 1 ORDER BY N DESC, VEHICLE_TYPE",\n'
)
CONFIG_VT_READ = 'q("SELECT VEHICLE_TYPE FROM FLEET_APP.BACKLOAD_MATCHING.VW_CONFIG LIMIT 1")'


# ------------------------------------------------------------------ mutations
def m5_drop_region_read(p):
    """Remove the region-scoped resolution, leaving only the CONFIG singleton.

    This is the original defect verbatim: the proc still takes P_REGION, still
    scopes its feeds with it, and still describes the wrong fleet.
    """
    sub(p[PROC_REL], REGION_VT_READ, '            "SELECT 1",\n')


def m5_config_first(p):
    """Keep BOTH reads but let CONFIG win.

    The false-pass shape: a co-presence check sees a region read and a CONFIG
    fallback and is satisfied, while the singleton still decides the answer and
    the region read is dead code.
    """
    src = p[PROC_REL].read_text(encoding="utf-8")
    i = src.index(CONFIG_VT_READ)
    # Hoist a copy of the CONFIG read ABOVE the region read.
    j = src.index(REGION_VT_READ)
    hoisted = "    var vrEarly = " + CONFIG_VT_READ + ";\n"
    src = src[:j] + hoisted + src[j:]
    p[PROC_REL].write_text(src, encoding="utf-8")
    assert i > 0


def m6_vocab_ts(p):
    sub(p[OFFERS_REL],
        "'PARTNER_APP', 'BROKER']",
        "'PARTNER_APP', 'INTERNAL']")


def m6_vocab_sql(p):
    sub(p[SEED_REL], "3,'BROKER') AS SOURCE", "3,'INTERNAL') AS SOURCE")


def m6_compare(p):
    sub(p[LIST_REL], "a.IS_INTERNAL ?", "a.SOURCE === 'INTERNAL' ?")


def m_vacuity_rule5(p):
    """Point RULE 5 at a directory with no procs - it must not pass silently."""
    return "glob"


# ------------------------------------------------------------------- pass cases
def pass_no_region_proc(p):
    """A proc with NO region argument reading CONFIG is in scope for nothing.

    Strips P_REGION out of the solve proc entirely; the CONFIG read then has no
    better alternative available and must not be reported.
    """
    src = p[PROC_REL].read_text(encoding="utf-8")
    src = src.replace(REGION_VT_READ, '            "SELECT 1",\n')
    src = src.replace("P_REGION", "P_NOREGION")
    p[PROC_REL].write_text(src, encoding="utf-8")


def pass_lowercase_filter_token(p):
    """`filters.source === 'internal'` is a UI select value, not a data column.

    This is the real false positive the first draft of RULE 6 produced.
    """
    sub(p[PROPOSALS_REL],
        "if (filters.source === 'internal' && !p.isInternal) return false;",
        "if (filters.source === 'internal' && !p.isInternal) return false;\n"
        "    if (filters.source === 'internal') return true;")


def pass_decision_source(p):
    """DECISION_SOURCE keeps INTERNAL as the reserved own-fleet token."""
    sub(p[LIST_REL], "a.IS_INTERNAL ?", "a.DECISION_SOURCE === 'INTERNAL' ?")


MUTATIONS = [
    ("RULE 5: region-scoped vehicle-type read removed", m5_drop_region_read,
     "resolves the vehicle type from the CONFIG singleton only"),
    ("RULE 5: CONFIG read hoisted above the region read", m5_config_first,
     "BEFORE its region-scoped vehicle-type read"),
    ("RULE 6: 'INTERNAL' re-added to the TS channel vocabulary", m6_vocab_ts,
     "EXTERNAL source vocabulary"),
    ("RULE 6: 'INTERNAL' re-added to the SQL channel DECODE", m6_vocab_sql,
     "EXTERNAL source vocabulary"),
    ("RULE 6: badge colour reads provenance from SOURCE", m6_compare,
     "provenance read out of the SOURCE channel column"),
]

PASS_CASES = [
    ("a proc with no region argument may read CONFIG", pass_no_region_proc),
    ("a lowercase UI filter token is not the data column", pass_lowercase_filter_token),
    ("DECISION_SOURCE may carry the reserved INTERNAL token", pass_decision_source),
]


def run_gate(mod) -> tuple[int, str]:
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = mod.main()
    return rc, buf.getvalue()


def main() -> int:
    failures: list[str] = []

    # Baseline: the staged copy must PASS, or nothing below means anything.
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        stage(tmp)
        mod = load_gate()
        point_gate_at(mod, tmp)
        rc, out = run_gate(mod)
        if rc != 0:
            failures.append(f"BASELINE: staged copy does not pass:\n{out}")

    for label, mutate, expect in MUTATIONS:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            paths = stage(tmp)
            mod = load_gate()
            point_gate_at(mod, tmp)
            mutate(paths)
            rc, out = run_gate(mod)
            if rc == 0:
                failures.append(f"NOT CAUGHT: {label}\n    gate said: {out.strip()[:200]}")
            elif expect not in out:
                failures.append(
                    f"CAUGHT FOR THE WRONG REASON: {label}\n"
                    f"    expected text: {expect!r}\n    got: {out.strip()[:300]}"
                )
            else:
                print(f"  caught: {label}")

    for label, mutate in PASS_CASES:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            paths = stage(tmp)
            mod = load_gate()
            point_gate_at(mod, tmp)
            mutate(paths)
            rc, out = run_gate(mod)
            if rc != 0:
                failures.append(
                    f"FALSE POSITIVE: {label}\n    gate said: {out.strip()[:300]}"
                )
            else:
                print(f"  allowed: {label}")

    # Vacuity: point the rules at an empty tree. The counters must fire rather
    # than let an inspect-nothing run report OK.
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        stage(tmp)
        mod = load_gate()
        point_gate_at(mod, tmp)
        mod.RULE5_GLOBS = [(tmp / "nowhere", "**/*.sql")]
        mod.RULE6_GLOBS = [(tmp / "nowhere", "**/*.ts")]
        mod.RULE6_SQL_GLOBS = [(tmp / "nowhere", "**/*.sql")]
        rc, out = run_gate(mod)
        if rc == 0:
            failures.append("NOT CAUGHT: empty globs reported OK (vacuity counters dead)")
        elif "inspected ZERO" not in out:
            failures.append(f"vacuity fired for the wrong reason:\n{out.strip()[:300]}")
        else:
            print("  caught: empty globs (vacuity counters)")

    if failures:
        print("\ncheck_region_scoping_negative: FAILED\n")
        for f in failures:
            print(f"  {f}\n")
        return 1
    print(f"\ncheck_region_scoping_negative: OK "
          f"({len(MUTATIONS)} mutation(s) caught, {len(PASS_CASES)} boundary case(s) allowed, "
          f"vacuity counters live)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
