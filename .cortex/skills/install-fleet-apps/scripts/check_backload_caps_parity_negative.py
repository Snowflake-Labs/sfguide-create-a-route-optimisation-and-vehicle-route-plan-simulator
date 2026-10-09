#!/usr/bin/env python3
"""Negative tests for check_backload_caps_parity.py.

Each mutation breaks one rule ON A THROWAWAY COPY and the gate must FAIL with
that rule's tag. Nothing under the real repo is written. M8 re-adds the broken
floor BESIDE the fixed rule and M13 leaves the removed cap behind in a comment:
those are the two shapes a substring-level gate passes.
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
GATE = HERE / "check_backload_caps_parity.py"
REPO = HERE.parent.parent.parent.parent

REL = {
    "PROC": ".cortex/skills/routing-agent/references/deploy-agent.sql",
    "PAGE": ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching.tsx",
    "HELP": ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching/helpers.ts",
    "VERB": ".cortex/skills/install-fleet-apps/fleet_tools/user/src/procs/backload_solve.ts",
}


def sub(s: str, old: str, new: str, name: str, count: int = 1) -> str:
    if old not in s:
        raise RuntimeError(f"{name}: mutation anchor not found: {old!r}")
    return s.replace(old, new) if count == 0 else s.replace(old, new, count)


MUTATIONS = [
    ("M1", "A", "proc drops max_distance",
     {"PROC": lambda s: sub(s, "                max_distance: caps.max_distance,\n", "", "M1")}),
    ("M2", "A", "proc drops max_travel_time",
     {"PROC": lambda s: sub(s, "                max_travel_time: caps.max_travel_time,\n", "", "M2")}),
    ("M3", "B", "proc dispatch cost hardcoded again",
     {"PROC": lambda s: sub(s, "fixed: Math.round(fixedDispatchUsd * COST_SCALE), per_km: Math.round(effPerKm",
                             "fixed: 140 * COST_SCALE, per_km: Math.round(effPerKm", "M3")}),
    ("M4", "A", "page stops spreading vehicleTourCaps",
     {"PAGE": lambda s: sub(s, "        ...vehicleTourCaps(base, { deviationPct, detourSlackHrs, allowanceKm: deviationAllowanceKm, kmh: speedKmh }),\n",
                             "", "M4")}),
    ("M5", "B", "page dispatch cost hardcoded",
     {"PAGE": lambda s: sub(s, "costs: { fixed: Math.round(fixedDispatchUsd * COST_SCALE)",
                             "costs: { fixed: 140", "M5")}),
    ("M6", "C", "helpers distance cap loses the allowance",
     {"HELP": lambda s: sub(s, " * (1 + opts.deviationPct / 100) + allowanceKm * 1000)",
                             " * (1 + opts.deviationPct / 100))", "M6")}),
    ("M7", "C", "helpers time cap loses the allowance",
     {"HELP": lambda s: sub(s, " + (allowanceKm / speed) * 3600)", ")", "M7")}),
    ("M8", "C", "page re-adds the 10 km floor BESIDE the fixed rule",
     {"PAGE": lambda s: sub(s, "        ...vehicleTourCaps(base, {",
                             "        max_distance: Math.max(10_000, Math.round(base.distMeters)),\n"
                             "        ...vehicleTourCaps(base, {", "M8")}),
    ("M9", "D", "proc stops returning applied_caps",
     {"PROC": lambda s: sub(s, "applied_caps: appliedCaps", "applied_caps_x: appliedCaps", "M9", 0)}),
    ("M10", "D", "verb no longer says an absent cap was not enforced",
     {"VERB": lambda s: sub(s, "applied_caps was ' +\n      'NOT enforced", "applied_caps was ' +\n      'not reported", "M10")}),
    ("M11", "E", "zero baseline rejected again",
     {"HELP": lambda s: sub(s, "dur >= 0 && dist >= 0", "dur > 0 && dist > 0", "M11")}),
    ("M12", "E", "only one side accepts zero",
     {"HELP": lambda s: sub(s, "dur >= 0 && dist >= 0", "dur >= 0 && dist > 0", "M12")}),
    ("M13", "A", "proc cap removed but left behind in a comment",
     {"PROC": lambda s: sub(s, "                max_distance: caps.max_distance,\n",
                             "                // max_distance: caps.max_distance,\n", "M13")}),
    ("M14", "vacuity", "proc renamed so nothing is found",
     {"PROC": lambda s: sub(s, "ROUTING_TOOLS.TOOL_BACKLOAD_SOLVE(\n", "ROUTING_TOOLS.TOOL_BACKLOAD_SOLVE_X(\n", "M14")}),
]


def load_gate():
    spec = importlib.util.spec_from_file_location("caps_gate", GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(paths: dict[str, Path]) -> tuple[int, str]:
    mod = load_gate()
    for k, p in paths.items():
        setattr(mod, k, p)
    mod.failures.clear()
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = mod.main()
    return rc, buf.getvalue()


def main() -> int:
    bad = 0
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        paths = {}
        for k, rel in REL.items():
            dst = tmp / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / rel, dst)
            paths[k] = dst
        originals = {k: p.read_text(encoding="utf-8") for k, p in paths.items()}

        rc, out = run(paths)
        if rc != 0:
            print("CONTROL FAILED: gate does not pass on the unmutated copy\n" + out)
            return 1
        print("control: gate PASSES on the real tree")

        for mid, rule, label, edits in MUTATIONS:
            try:
                for k, fn in edits.items():
                    paths[k].write_text(fn(originals[k]), encoding="utf-8")
                rc, out = run(paths)
                if rc == 0:
                    bad += 1
                    print(f"  MISS   {mid} {label}: gate passed on a broken tree")
                elif f"[{rule}]" not in out:
                    bad += 1
                    print(f"  WRONG  {mid} {label}: failed, but not for rule [{rule}]\n{out}")
                else:
                    print(f"  caught {mid} [{rule}] {label}")
            except RuntimeError as e:
                bad += 1
                print(f"  ERROR  {mid} {label}: {e}")
            finally:
                for k, p in paths.items():
                    p.write_text(originals[k], encoding="utf-8")

    if bad:
        print(f"\nFAIL: {bad} of {len(MUTATIONS)} mutations not correctly convicted")
        return 1
    print(f"\nPASS: all {len(MUTATIONS)} mutations convicted, each for its own stated reason")
    return 0


if __name__ == "__main__":
    sys.exit(main())
