#!/usr/bin/env python3
"""Negative tests for check_dash_units.py.

Every rule is broken here ON A THROWAWAY COPY of the tree and the gate must FAIL
for the stated reason. Nothing under the real repo is written.

This exists because a gate that has never been seen to fail is not a gate, and
rule A had a specific false-pass shape to rule out: an earlier draft looked for
pixel units within a few lines of the extension, which a NEIGHBOURING layer that
happened to set `widthUnits: 'pixels'` satisfied. Case `a_neighbour_only` pins
that: the units are present in the file, on another layer, and the gate must
still fail. Case `a_min_pixels_only` pins the other one - `lineWidthMinPixels`
clamps the stroke and does nothing to the dash period, and that prop is exactly
what made the original bug look handled.

Run: python3 .cortex/skills/install-fleet-apps/scripts/check_dash_units_negative.py
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
GATE = HERE / "check_dash_units.py"
REPO = HERE.parents[3]

SKILL_REL = ".cortex/skills/install-fleet-apps"
MATCHING_REL = f"{SKILL_REL}/fleet_sa_app/ui/src/components/views/areas/backload-matching.tsx"
PROPOSAL_REL = (
    f"{SKILL_REL}/fleet_sa_app/ui/src/components/views/areas/backload-proposals/ProposalMap.tsx"
)
RESULT_REL = f"{SKILL_REL}/fleet_admin_app/ui/src/components/function-tester/ResultMap.tsx"
CONSTANTS_REL = (
    f"{SKILL_REL}/fleet_sa_app/ui/src/components/views/areas/backload-proposals/constants.ts"
)
REL = [MATCHING_REL, PROPOSAL_REL, RESULT_REL, CONSTANTS_REL]


def load_gate():
    spec = importlib.util.spec_from_file_location("dash_gate", GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def stage(tmp: Path) -> None:
    for rel in REL:
        dst = tmp / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / rel, dst)


def point_gate_at(mod, tmp: Path) -> None:
    skill = tmp / SKILL_REL
    mod.REPO = tmp
    mod.SKILL = skill
    mod.CONSTANTS = tmp / CONSTANTS_REL
    mod.ROOTS = (
        skill / "fleet_sa_app/ui/src",
        skill / "fleet_admin_app/ui/src",
        tmp / "packages/fleet-kit/src",
    )


def run_gate(tmp: Path) -> tuple[int, str]:
    mod = load_gate()
    point_gate_at(mod, tmp)
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = mod.main()
    return rc, buf.getvalue()


def patch(tmp: Path, rel: str, old: str, new: str) -> None:
    p = tmp / rel
    src = p.read_text(encoding="utf-8")
    if old not in src:
        raise SystemExit(f"harness is stale: {old!r} not found in {rel}")
    p.write_text(src.replace(old, new, 1), encoding="utf-8")


# Each case: (name, mutate(tmp), expected rule tag, expected substring)
CASES: list[tuple[str, object, str, str]] = [
    (
        "a_units_dropped",
        lambda tmp: patch(tmp, MATCHING_REL, "lineWidthUnits: 'pixels', ", ""),
        "[A]",
        "METRES",
    ),
    (
        "a_min_pixels_only",
        lambda tmp: patch(
            tmp,
            MATCHING_REL,
            "lineWidthUnits: 'pixels', getLineWidth: 4, lineWidthMinPixels: 4,",
            "getLineWidth: 4, lineWidthMinPixels: 6,",
        ),
        "[A]",
        "renders solid when zoomed out",
    ),
    (
        "a_neighbour_only",
        # Units removed from the dashed layer, but still present on the loaded
        # path layer a few lines above it. A proximity check would pass here.
        lambda tmp: patch(tmp, PROPOSAL_REL, "widthUnits: 'pixels' as const, widthMinPixels: 3,", "widthMinPixels: 3,"),
        "[A]",
        "ProposalMap.tsx",
    ),
    (
        "b_dashjustified_dropped",
        lambda tmp: patch(tmp, PROPOSAL_REL, " dashJustified: true,", ""),
        "[B]",
        "without dashJustified",
    ),
    (
        # Rule C's original false-pass shape: the props are gone but the layer's
        # own explanatory comment still contains the words `getDashArray` and
        # `widthUnits`, so an uncommented-source check passed on the prose that
        # documents the bug.
        "c_dasharray_dropped",
        lambda tmp: patch(tmp, RESULT_REL, "      getDashArray: [6, 4],\n", ""),
        "[C]",
        "no getDashArray",
    ),
    (
        # The baseline pulled back next to the empty leg. Note the mutation
        # moves BASELINE, not EMPTY: with the baseline at 190 grey, reverting
        # the empty leg to its old 110 is 80 levels apart and genuinely does
        # read as two lines, so convicting that would have meant tightening the
        # rule until it flagged something that is not a defect.
        "d_colours_collapse",
        lambda tmp: patch(
            tmp,
            CONSTANTS_REL,
            "COLOR_LEG_BASELINE: [number, number, number] = [190, 190, 190]",
            "COLOR_LEG_BASELINE: [number, number, number] = [70, 80, 95]",
        ),
        "[D]",
        "read as the same line",
    ),
    (
        "d_baseline_removed",
        lambda tmp: patch(
            tmp,
            CONSTANTS_REL,
            "export const COLOR_LEG_BASELINE: [number, number, number] = [190, 190, 190];",
            "",
        ),
        "[D]",
        "COLOR_LEG_BASELINE",
    ),
    (
        "vacuity_no_sites",
        # Every dash site deleted: the scan finds nothing and must NOT report a
        # clean pass. This is the shape a moved tree or a broken regex takes.
        lambda tmp: [
            patch(tmp, rel, "PathStyleExtension({ dash: true })", "PathStyleExtension({})")
            for rel in (MATCHING_REL, PROPOSAL_REL, RESULT_REL)
        ],
        "vacuously",
        "dash site",
    ),
]


def main() -> int:
    bad = 0
    with tempfile.TemporaryDirectory() as td:
        base = Path(td) / "base"
        base.mkdir()
        stage(base)
        rc, out = run_gate(base)
        if rc != 0:
            print(f"FAILED: unmutated copy does not pass - harness is broken\n{out}")
            return 1
        print(f"  control PASSes: {out.strip()}")

        for name, mutate, tag, needle in CASES:
            work = Path(td) / name
            shutil.copytree(base, work)
            mutate(work)
            rc, out = run_gate(work)
            if rc == 0:
                print(f"FALSE PASS: {name} - gate accepted the mutation\n{out}")
                bad += 1
            elif tag not in out or needle not in out:
                print(f"WRONG REASON: {name} - expected {tag} mentioning {needle!r}\n{out}")
                bad += 1
            else:
                print(f"  convicted: {name} ({tag})")

    if bad:
        print(f"FAILED: {bad} negative case(s) did not behave")
        return 1
    print(f"PASSED: dash units negative suite ({len(CASES)} mutations convicted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
