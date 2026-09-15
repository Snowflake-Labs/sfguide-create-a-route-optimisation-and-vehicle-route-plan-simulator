#!/usr/bin/env python3
"""Negative tests for check_backload_rehydrate_geometry.py.

A gate never seen to fail is documentation. Each mutation below is a shape the
bug could plausibly take - including the ORIGINAL bug (M1: the geometry pass
inside `solve`, reachable from one entry point only) and the near misses that a
lazier gate would wave through (M4: a second call site that has nothing to do
with the rehydrated plan; M5: a second, unshared fetch path).

Run: python3 .cortex/skills/install-fleet-apps/scripts/check_backload_rehydrate_geometry_negative.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
REL_VIEW = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching.tsx"
REL_REH = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/lib/backload-rehydrate.ts"
REL_HELP = ".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/areas/backload-matching/helpers.ts"
REL_GATE = ".cortex/skills/install-fleet-apps/scripts/check_backload_rehydrate_geometry.py"


def sub(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"mutation {label} could not be applied: anchor not found:\n  {old[:110]}")
    return text.replace(old, new, 1)


# Each mutation: (label, description, {relative path: mutate(text) -> text})
MUTATIONS: list[tuple[str, str, dict[str, object]]] = [
    ("M1", "the original bug: the geometry pass reachable only from solve",
     {REL_VIEW: lambda s: sub(s, "    enrichGeometry(pending, vehicleClass.ORS_PROFILE, cfg.region).then(() => {",
                              "    Promise.resolve().then(() => {", "M1")}),
    ("M2", "the shared producer is removed entirely",
     {REL_VIEW: lambda s: sub(s, "  const enrichGeometry = useCallback(async (",
                              "  const enrichGeometryDisabled = useCallback(async (", "M2")}),
    ("M3", "the producer is moved back inside solve",
     {REL_VIEW: lambda s: _nest_in_solve(s)}),
    ("M4", "a second call site exists but has nothing to do with the collected plan",
     {REL_VIEW: lambda s: sub(s, "      (a) => a.REHYDRATED && !a.ROUTE_GEOJSON",
                              "      (a) => !a.ROUTE_GEOJSON", "M4")}),
    ("M5", "a second, unshared fetch path writes the tour geometry",
     {REL_VIEW: lambda s: sub(
         s,
         "        setAssignments(rebuilt as unknown as Assignment[]);",
         "        for (const a of rebuilt as unknown as Assignment[]) { a.ROUTE_GEOJSON = null; }\n"
         "        setAssignments(rebuilt as unknown as Assignment[]);", "M5")}),
    ("M6", "collected assignments are no longer marked REHYDRATED",
     {REL_REH: lambda s: sub(s, "    REHYDRATED: true,", "    // REHYDRATED: true,", "M6")}),
    ("M7", "the Assignment type drops the marker, so it never reaches the page",
     {REL_HELP: lambda s: sub(s, "  REHYDRATED?: boolean;", "  // REHYDRATED dropped", "M7")}),
    ("M8", "the producer is declared after solve (temporal dead zone at render)",
     {REL_VIEW: lambda s: _move_after_solve(s)}),
    ("M11", "the channel label is derived from `source` again",
     {REL_REH: lambda s: sub(
         s,
         "    const channel = resolveChannel(p.is_internal, p.source);\n    const source = channel.label;",
         "    const channel = resolveChannel(p.is_internal, p.source);\n"
         "    const source = p.is_internal ? 'INTERNAL' : String(p.source ?? 'EXTERNAL');", "M11")}),
    ("M12", "the authoritative flag is dropped from the collected assignment",
     {REL_REH: lambda s: sub(s, "      IS_INTERNAL: channel.internal,",
                             "      // IS_INTERNAL dropped", "M12")}),
]


def _extract(src: str, start_anchor: str) -> tuple[str, str]:
    i = src.find(start_anchor)
    if i < 0:
        raise SystemExit(f"anchor not found: {start_anchor}")
    depth, started = 0, False
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
            started = True
        elif src[j] == "}":
            depth -= 1
            if started and depth == 0:
                end = src.find("\n", j)
                return src[i:end + 1], src[:i] + src[end + 1:]
    raise SystemExit("unbalanced braces while extracting block")


def _nest_in_solve(src: str) -> str:
    block, rest = _extract(src, "  const enrichGeometry = useCallback(async (")
    anchor = "  const solve = useCallback(async () => {\n"
    if anchor not in rest:
        raise SystemExit("M3: solve anchor not found")
    return rest.replace(anchor, anchor + block, 1)


def _move_after_solve(src: str) -> str:
    block, rest = _extract(src, "  const enrichGeometry = useCallback(async (")
    anchor = "  // Auto-select the top assignment after a solve."
    if anchor not in rest:
        raise SystemExit("M8: post-solve anchor not found")
    return rest.replace(anchor, block + "\n" + anchor, 1)


def run_gate(root: Path) -> tuple[int, str]:
    r = subprocess.run([sys.executable, str(root / REL_GATE)], capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def main() -> int:
    code, out = run_gate(REPO)
    if code != 0:
        print(f"FAILED: the gate does not pass on the CURRENT tree, so no mutation result is meaningful:\n{out}")
        return 1

    bad = 0
    for label, desc, edits in MUTATIONS:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            # Copy only what the gate reads; the gate resolves paths from its own
            # location, so the tree shape must be preserved.
            for rel in (REL_VIEW, REL_REH, REL_HELP, REL_GATE):
                dst = root / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(REPO / rel, dst)
            for rel, fn in edits.items():
                p = root / rel
                p.write_text(fn(p.read_text()))  # type: ignore[operator]
            code, out = run_gate(root)
            if code == 0:
                print(f"FALSE PASS {label}: {desc}\n  gate said: {out}")
                bad += 1
            else:
                first = next((l for l in out.splitlines() if l.strip().startswith("[")), out.splitlines()[0])
                print(f"convicted {label}: {desc}\n  -> {first.strip()}")

    if bad:
        print(f"\nFAILED: {bad} of {len(MUTATIONS)} mutations were not caught")
        return 1
    print(f"\nPASSED: all {len(MUTATIONS)} mutations convicted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
