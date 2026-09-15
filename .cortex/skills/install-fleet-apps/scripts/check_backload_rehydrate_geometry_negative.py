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
REL_CARD = (".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/"
            "areas/backload-matching/AssignmentList.tsx")
REL_STOPS = (".cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/components/views/"
             "areas/backload-matching/StopsPanel.tsx")


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
    ("M9", "the original memo bug: rev/cost coerced with || 0",
     {REL_VIEW: lambda s: sub(
         s,
         # Anchored WITHOUT leading whitespace: this line sits inside the memo
         # builder, which is being restructured on another branch, and an
         # indentation-sensitive anchor turns a live refactor into a harness that
         # ABORTS mid-run rather than one that tests anything.
         "const hasBreakdown = a.REVENUE_USD !== undefined && a.COST_USD !== undefined;",
         "const hasBreakdown = true;", "M9")}),
    ("M10", "the memo prints the breakdown unconditionally via || 0",
     {REL_VIEW: lambda s: sub(
         s,
         "${econ}`;",
         "${econ}, rev $${Math.round(a.REVENUE_USD || 0)} cost $${Math.round(a.COST_USD || 0)}`;",
         "M10")}),
    ("M11", "the channel label is derived from `source` again",
     {REL_REH: lambda s: sub(
         s,
         "    const channel = resolveChannel(p.is_internal, p.source);\n    const source = channel.label;",
         "    const channel = resolveChannel(p.is_internal, p.source);\n"
         "    const source = p.is_internal ? 'INTERNAL' : String(p.source ?? 'EXTERNAL');", "M11")}),
    ("M12", "the authoritative flag is dropped from the collected assignment",
     {REL_REH: lambda s: sub(s, "      IS_INTERNAL: channel.internal,",
                             "      // IS_INTERNAL dropped", "M12")}),

    # ---- RULE G: the baseline pass, which had the SAME shape of bug as the
    # geometry pass and was found only after it was fixed.
    ("M13", "the original baseline bug: computed inside solve only",
     {REL_VIEW: lambda s: sub(
         s,
         "    computeBaselines(rows, vehicleClass.ORS_PROFILE, trailerEndFor, cfg.region, {",
         "    Promise.resolve(new Map()).then(() => {}); void ((rows: unknown) => rows)({",
         "M13")}),
    ("M14", "the collected-plan baseline call exists but is not keyed off REHYDRATED",
     {REL_VIEW: lambda s: sub(
         s,
         "      (a) => a.REHYDRATED && a.BASELINE_EMPTY_KM === undefined",
         "      (a) => a.BASELINE_EMPTY_KM === undefined",
         "M14")}),
    ("M15", "the shared wrapper is bypassed by a second direct call",
     {REL_VIEW: lambda s: sub(
         s,
         "    const baselines = await computeBaselines(",
         "    const baselines = await computeEmptyLegBaselines(profile, [], trailerEnd, cfg.region, {}) ?? await computeBaselines(",
         "M15")}),
    ("M16", "the saved-km rule is re-implemented in the page instead of shared",
     {REL_VIEW: lambda s: sub(
         s,
         "      deriveSavedKm(a);",
         "      if (a.BASELINE_EMPTY_KM !== undefined) a.SAVED_KM = Math.max(0, a.BASELINE_EMPTY_KM - a.EMPTY_KM);",
         "M16")}),

    # ---- RULE H: the blank place name, in each of the three surfaces.
    ("M17", "the card renders the city columns raw again (the reported defect)",
     {REL_CARD: lambda s: sub(
         s,
         "              {placeLabel(a.PICKUP_CITY, a.OFFER_ID)} -&gt; {placeLabel(a.PROPOSAL_DROPOFF_CITY, a.OFFER_ID)}",
         "              {a.PICKUP_CITY} -&gt; {a.PROPOSAL_DROPOFF_CITY}",
         "M17")}),
    ("M18", "the stops panel falls back on a raw city, so 'Destination' reads as a place",
     {REL_STOPS: lambda s: sub(
         s,
         "                <b>{realPlace(s.city) ?? s.label}</b>",
         "                <b>{s.city || s.label}</b>",
         "M18")}),
    ("M19", "the agent memo publishes '?' as a place again",
     {REL_VIEW: lambda s: sub(
         s,
         "          const dest = tour.finalDropoff ?? placeLabel(a.PROPOSAL_DROPOFF_CITY, a.OFFER_ID);",
         "          const dest = tour.finalDropoff ?? realPlace(a.PROPOSAL_DROPOFF_CITY) ?? '?';",
         "M19")}),
    ("M20", "placeLabel is removed from helpers, so each site invents its own fallback",
     {REL_HELP: lambda s: sub(s, "export function placeLabel(", "function placeLabelUnused(", "M20")}),

    # ---- RULE I: the at-end state, and the near miss of surfacing it in only one
    # of the two places, or with wording that does not explain the missing line.
    ("M21", "the card stops checking at-end",
     {REL_CARD: lambda s: sub(s, "            {isAtEndBaseline(a) && (",
                             "            {false && (", "M21")}),
    ("M22", "the readout says 0 km but no longer says a backload adds empty km",
     {REL_VIEW: lambda s: sub(
         s,
         "so there is no reposition to\n                  draw and a backload here adds empty km rather than avoiding any",
         "",
         "M22")}),
    ("M23", "isAtEndBaseline compares coordinates exactly instead of by tolerance",
     {REL_HELP: lambda s: sub(
         s,
         "  return samePlace(\n    [Number(a.TRAILER_DROPOFF_LON), Number(a.TRAILER_DROPOFF_LAT)],\n    [Number(a.END_LON), Number(a.END_LAT)],\n  );",
         "  return Number(a.TRAILER_DROPOFF_LON) === Number(a.END_LON)\n    && Number(a.TRAILER_DROPOFF_LAT) === Number(a.END_LAT);",
         "M23")}),

    # ---- RULE J: the return leg the proposal cannot ask for.
    ("M24", "the original return-leg bug: gated on a km a proposal never carries",
     {REL_VIEW: lambda s: sub(
         s,
         "      const hasReturn = endsKnown\n        && (a.REHYDRATED ? endsDiffer : (a.EMPTY_BACK_KM ?? 0) > 0);",
         "      const hasReturn = endsKnown && (a.EMPTY_BACK_KM ?? 0) > 0;",
         "M24")}),

    # ---- RULE K: the tolerance dedupe.
    ("M25", "waypoints are deduped exactly again, so a 1e-14 twin reaches DIRECTIONS",
     {REL_HELP: lambda s: sub(
         s,
         "    if (prev && samePlace(prev, [Number(lon), Number(lat)])) continue;",
         "    if (prev && prev[0] === Number(lon) && prev[1] === Number(lat)) continue;",
         "M25")}),
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
    # The comment above the auto-select effect has been reworded once already, so
    # anchor on the effect's own code rather than on its prose.
    anchor = "  const totalNetBenefit = useMemo("
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
            for rel in (REL_VIEW, REL_REH, REL_HELP, REL_GATE, REL_CARD, REL_STOPS):
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
