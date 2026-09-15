#!/usr/bin/env python3
"""Negative tests for check_backload_budget.py.

Every rule in that gate is broken here ON A THROWAWAY COPY of the tree and the
gate must FAIL for the stated reason. Nothing under the real repo is written.

This exists because a gate that has never been seen to fail is not a gate. Two
of the rules below were genuinely wrong when first written and only this harness
caught it: the in-loop budget check was originally satisfied by the check in the
FAMILY loop (so the mutation that removed the in-loop one passed), and the arity
rule read the whole file rather than the verb's own callTool list.
"""
from __future__ import annotations

import importlib.util
import io
import json
import re
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "check_backload_budget.py"
SKILL_DIR = HERE.parent
REPO = SKILL_DIR.parent.parent.parent


def load_gate():
    spec = importlib.util.spec_from_file_location("bl_gate", GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


REL = {
    "proc": ".cortex/skills/routing-agent/references/deploy-agent.sql",
    "verb": ".cortex/skills/install-fleet-apps/fleet_tools/user/src/procs/backload_solve.ts",
    "route": ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/app/api/tool/route.ts",
    "config": ".cortex/skills/install-fleet-apps/fleet_sa_app/app/app-config.json",
    "spec": ".cortex/skills/install-fleet-apps/fleet_sa_app/app/agent-spec.json",
    "superspec": ".cortex/skills/install-fleet-apps/fleet_sa_app/app/super-agent-spec.json",
}


def stage(tmp: Path) -> dict[str, Path]:
    out = {}
    for key, rel in REL.items():
        src = REPO / rel
        dst = tmp / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        out[key] = dst
    (tmp / ".cortex").mkdir(exist_ok=True)
    return out


def point_gate_at(mod, tmp: Path, paths: dict[str, Path]) -> None:
    mod.REPO = tmp
    mod.SKILL_DIR = tmp / ".cortex" / "skills" / "install-fleet-apps"
    mod.PROC_SQL = paths["proc"]
    mod.VERB_TS = paths["verb"]
    mod.TOOL_ROUTE = paths["route"]
    mod.APP_CONFIG = paths["config"]
    mod.AGENT_SPECS = [paths["spec"], paths["superspec"]]


def sub_in_proc(path: Path, old: str, new: str, *, count: int = 1) -> None:
    src = path.read_text(encoding="utf-8")
    if old not in src:
        raise AssertionError(f"mutation anchor not found in {path.name}: {old[:70]!r}")
    path.write_text(src.replace(old, new, count), encoding="utf-8")


def edit_bullet(path: Path, fn) -> None:
    spec = json.loads(path.read_text(encoding="utf-8"))
    node = spec["instructions"] if isinstance(spec.get("instructions"), dict) else spec
    orch = node["orchestration"]
    lines = orch.split("\n")
    for i, line in enumerate(lines):
        if line.lstrip().startswith("-") and "-> backload_solve" in line:
            lines[i] = fn(line)
            break
    else:
        raise AssertionError("no backload_solve bullet to mutate")
    node["orchestration"] = "\n".join(lines)
    path.write_text(json.dumps(spec, indent=2), encoding="utf-8")


# ---------------------------------------------------------------- mutations
def m_drop_trailer_arg(p):
    sub_in_proc(p["proc"], "    P_TRAILER_ID   VARCHAR DEFAULT NULL,\n", "")


def m_drop_budget_arg(p):
    sub_in_proc(p["proc"], "    P_TIME_BUDGET_S FLOAT  DEFAULT NULL\n", "")


def m_remove_stale_drop(p):
    sub_in_proc(
        p["proc"],
        "DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_BACKLOAD_SOLVE"
        "(VARCHAR, FLOAT, FLOAT, VARCHAR, FLOAT, VARCHAR);\n",
        "",
    )


def m_remove_inloop_budget(p):
    """Delete ONLY the in-loop check, leaving the per-family one intact.

    This is the mutation that matters: the surviving family-loop check makes the
    proc look guarded while a single family can still run for over 90 minutes.
    """
    src = p["proc"].read_text(encoding="utf-8")
    m = re.search(
        r"\n            if \(budgetExhausted\(\)\) \{\n                budgetHit = true;\n"
        r"                return \{ result: null, excluded: excluded,\n.*?\n            \}\n",
        src,
        re.DOTALL,
    )
    if not m:
        raise AssertionError("in-loop budget block not found")
    p["proc"].write_text(src.replace(m.group(0), "\n"), encoding="utf-8")


def m_budget_check_after_call(p):
    """Move the in-loop check to AFTER solveOnce - reports, cannot prevent."""
    src = p["proc"].read_text(encoding="utf-8")
    m = re.search(
        r"\n(            if \(budgetExhausted\(\)\) \{\n                budgetHit = true;\n"
        r"                return \{ result: null, excluded: excluded,\n.*?\n            \}\n)"
        r"(            var res = solveOnce\(workV, workS\);\n)",
        src,
        re.DOTALL,
    )
    if not m:
        raise AssertionError("in-loop budget block + solveOnce not found")
    p["proc"].write_text(src.replace(m.group(0), "\n" + m.group(2) + m.group(1)), encoding="utf-8")


def m_remove_budget_reason(p):
    src = p["proc"].read_text(encoding="utf-8")
    p["proc"].write_text(src.replace("TIME_BUDGET_EXCEEDED", "SOME_OTHER_REASON"), encoding="utf-8")


def m_unscope_trailer_feed(p):
    sub_in_proc(
        p["proc"],
        '          + (trailerId ? "AND g.TRAILER_ID = ? " : "")\n',
        "",
    )
    sub_in_proc(
        p["proc"],
        "            trailerId ? [region, trailerId] : [region],\n"
        "            ['TRAILER_ID', 'OPERATING_COUNTRY', 'EMPTY_CITY', 'EMPTY_LON', 'EMPTY_LAT',",
        "            [region],\n"
        "            ['TRAILER_ID', 'OPERATING_COUNTRY', 'EMPTY_CITY', 'EMPTY_LON', 'EMPTY_LAT',",
    )


def m_remove_vehicle_not_found(p):
    src = p["proc"].read_text(encoding="utf-8")
    p["proc"].write_text(src.replace("VEHICLE_NOT_FOUND", "NO_FEED"), encoding="utf-8")


def m_unscope_eligible(p):
    """Revert the eligible read to the account-wide form."""
    src = p["proc"].read_text(encoding="utf-8")
    m = re.search(r"        eligible = rowsOf\(\n(.*?)\n            \[", src, re.DOTALL)
    if not m:
        raise AssertionError("eligible read not found")
    old_form = (
        '            "SELECT TRAILER_ID, LOAD_ID, DIST_CHECK, TIME_CHECK, HORIZON_CHECK, '
        'CAP_CHECK, HAZMAT_CHECK "\n'
        '          + "FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_CANDIDATES_SCORED '
        'WHERE ELIGIBLE = TRUE",'
    )
    src = src.replace(m.group(1), old_form)
    src = src.replace(
        "            trailerId ? [region, trailerId] : [region],\n"
        "            ['TRAILER_ID', 'LOAD_ID', 'DIST_CHECK',",
        "            [],\n            ['TRAILER_ID', 'LOAD_ID', 'DIST_CHECK',",
    )
    p["proc"].write_text(src, encoding="utf-8")


def m_stale_arity(p):
    src = p["route"].read_text(encoding="utf-8")
    p["route"].write_text(src.replace("backload_solve: 8,", "backload_solve: 6,"), encoding="utf-8")


def m_verb_drops_arg(p):
    """Declare trailer_id but pass a literal null in its slot.

    Arity is PRESERVED on purpose. Deleting the line instead trips the arity
    rule, which convicts for the wrong reason and leaves the "declared but never
    forwarded" clause untested - that is exactly what happened on the first run
    of this harness. This is also the realistic shape of the defect: the arg
    survives a refactor in the schema and quietly stops being forwarded.
    """
    src = p["verb"].read_text(encoding="utf-8")
    p["verb"].write_text(src.replace("      args.trailer_id,\n", "      null,\n"), encoding="utf-8")


def m_bullet_no_trailer(p):
    edit_bullet(p["spec"], lambda l: l.replace("trailer_id", "some_other_arg"))


def m_bullet_no_warning(p):
    edit_bullet(p["spec"], lambda l: l.replace("max_vehicles=1", "that approach"))


def m_bullet_far_away(p):
    """Move the guidance OUT of the bullet but keep it in the document.

    Proves rule F is an adjacency check. Without adjacency this passes, and the
    agent reads trailer_id advice attached to an unrelated verb.
    """
    spec = json.loads(p["spec"].read_text(encoding="utf-8"))
    node = spec["instructions"]
    lines = node["orchestration"].split("\n")
    for i, line in enumerate(lines):
        if line.lstrip().startswith("-") and "-> backload_solve" in line:
            lines[i] = re.sub(r"WHEN THE USER NAMES ONE VEHICLE.*?without saying so\. ", "", line)
            lines.insert(0, "- Note: pass trailer_id and never max_vehicles=1 for a named vehicle.")
            break
    node["orchestration"] = "\n".join(lines)
    p["spec"].write_text(json.dumps(spec, indent=2), encoding="utf-8")


def m_rename_proc(p):
    """Make the proc unfindable. Must FAIL loudly, never pass vacuously."""
    src = p["proc"].read_text(encoding="utf-8")
    p["proc"].write_text(
        src.replace(
            "CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_BACKLOAD_SOLVE(",
            "CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_BACKLOAD_SOLVE_V2(",
        ),
        encoding="utf-8",
    )


CASES = [
    ("[A] trailer arg removed", m_drop_trailer_arg, "P_TRAILER_ID"),
    ("[A] budget arg removed", m_drop_budget_arg, "P_TIME_BUDGET_S"),
    ("[A] stale 6-arg DROP removed", m_remove_stale_drop, "ambiguous PROCEDURE overloading"),
    ("[B] in-loop budget check removed (family check survives)", m_remove_inloop_budget, "shear retry loop"),
    ("[B] budget checked AFTER the engine call", m_budget_check_after_call, "AFTER calling"),
    ("[B] TIME_BUDGET_EXCEEDED reason removed", m_remove_budget_reason, "TIME_BUDGET_EXCEEDED"),
    ("[C] trailer feed no longer narrows", m_unscope_trailer_feed, "does not narrow"),
    ("[C] VEHICLE_NOT_FOUND removed", m_remove_vehicle_not_found, "VEHICLE_NOT_FOUND"),
    ("[D] eligible read unscoped to account-wide", m_unscope_eligible, "NOT region-scoped"),
    ("[E] app arity map left at 6", m_stale_arity, "arity 6"),
    ("[E] verb stops passing trailer_id", m_verb_drops_arg, "does not forward"),
    ("[F] bullet drops trailer_id", m_bullet_no_trailer, "never mentions"),
    ("[F] bullet drops max_vehicles=1 warning", m_bullet_no_warning, "does not warn"),
    ("[F] guidance moved out of the bullet", m_bullet_far_away, "backload_solve bullet"),
    ("[vacuity] proc renamed so nothing is found", m_rename_proc, "could not locate"),
]


def main() -> int:
    mod = load_gate()
    failures = []

    # Control: the real tree must PASS, else every negative below is meaningless.
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = mod.main()
    if rc != 0:
        print("CONTROL FAILED: the gate does not pass on the unmutated tree.\n")
        print(buf.getvalue())
        return 1
    print("control: gate PASSES on the real tree")

    for name, mutate, expect in CASES:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            paths = stage(tmp)
            try:
                mutate(paths)
            except AssertionError as e:
                failures.append(f"{name}: could not apply mutation ({e})")
                print(f"  ERROR  {name}: {e}")
                continue
            fresh = load_gate()
            point_gate_at(fresh, tmp, paths)
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = fresh.main()
            out = buf.getvalue()
            if rc == 0:
                failures.append(f"{name}: gate PASSED on a broken tree")
                print(f"  MISS   {name}: gate passed despite the mutation")
            elif expect not in out:
                failures.append(f"{name}: failed for the wrong reason (no {expect!r})")
                print(f"  WRONG  {name}: failed but never mentioned {expect!r}")
            else:
                print(f"  caught {name}")

    print()
    if failures:
        print(f"FAIL: {len(failures)} of {len(CASES)} mutations not correctly convicted")
        for f in failures:
            print(f"  {f}")
        return 1
    print(f"PASS: all {len(CASES)} mutations convicted, each for its own stated reason")
    return 0


if __name__ == "__main__":
    sys.exit(main())
