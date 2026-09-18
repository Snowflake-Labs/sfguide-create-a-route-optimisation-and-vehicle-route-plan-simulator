#!/usr/bin/env python3
"""Negative tests for RULES G and H of check_map_guidance.py.

Every mutation below is applied to a THROWAWAY COPY of the app directory and the
gate must FAIL. Nothing under the real repo is written.

This exists because a gate that has never been seen to fail is not a gate, and
because the rules being protected here are about PHRASING - the defect they catch
was guidance that named both tools correctly and still lost the argument. A rule
that merely checks both names appear would pass on the exact text that produced
three map-less answers, so the mutations deliberately include that shape (M4) and
the two "the words are present but the rule is gone" shapes (M2, M3).

M6 exists because RULE H's first draft matched only the literal old sentence. A
paraphrase of a false claim is still a false claim.
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
GATE = HERE / "check_map_guidance.py"
APP_SRC = HERE.parent / "fleet_sa_app" / "app"

SURFACE_MARKER = "SURFACE FIRST: LOOK AT YOUR OWN TOOL LIST"
FALSE_CLAUSE = (
    "CoWork's data_to_map is host-injected and unavailable to you, so for a question "
    "that is really about a map, give the figures you can retrieve."
)
FALSE_CLAUSE_PARAPHRASE = (
    "You have no map tool out here - data_to_map is not available to you - so give the "
    "figures you can retrieve."
)


def load_gate():
    spec = importlib.util.spec_from_file_location("map_gate", GATE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def stage(tmp: Path) -> Path:
    """Copy the whole app dir so the semantic-view rules (A-C) still have input."""
    dst = tmp / "app"
    shutil.copytree(APP_SRC, dst)
    return dst


def run_gate(app_dir: Path, *, specs: list[str] | None = None) -> tuple[int, str]:
    mod = load_gate()
    mod.APP_DIR = app_dir
    if specs is not None:
        mod.AGENT_SPECS = specs
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = mod.main()
    return rc, buf.getvalue()


def edit_specs(app_dir: Path, fn) -> None:
    """Apply fn(orchestration, response) -> (orchestration, response) to both specs."""
    for name in ("agent-spec.json", "super-agent-spec.json"):
        p = app_dir / name
        spec = json.loads(p.read_text())
        orch, resp = fn(
            spec["instructions"]["orchestration"], spec["instructions"]["response"]
        )
        spec["instructions"]["orchestration"] = orch
        spec["instructions"]["response"] = resp
        p.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")


def surface_bullet(orch: str) -> tuple[int, int]:
    """Character span of the SURFACE bullet, so a mutation cannot leak into its
    neighbours and fail the gate for an unrelated reason."""
    start = orch.index("- " + SURFACE_MARKER)
    end = orch.index("\n-", start)
    return start, end


def mutate_in_bullet(orch: str, old: str, new: str, *, flags: int = 0) -> str:
    start, end = surface_bullet(orch)
    bullet = orch[start:end]
    out = re.sub(old, new, bullet, flags=flags)
    assert out != bullet, f"mutation {old!r} did not change the surface bullet"
    return orch[:start] + out + orch[end:]


# --- the mutations -------------------------------------------------------------
# Each returns a callable applied to a staged copy, plus what the failure must say.

def m1_delete_surface_bullet(app_dir: Path) -> None:
    def fn(orch, resp):
        start, end = surface_bullet(orch)
        return orch[:start] + orch[end + 1:], resp
    edit_specs(app_dir, fn)


def m2_drop_consequence(app_dir: Path) -> None:
    edit_specs(app_dir, lambda o, r: (
        mutate_in_bullet(o, r"NO\s+MAP\s+APPEARS", "it will not help"), r))


def m3_drop_tool_list_signal(app_dir: Path) -> None:
    edit_specs(app_dir, lambda o, r: (
        mutate_in_bullet(o, r"tool list", "situation", flags=re.IGNORECASE), r))


def m4_both_names_no_rule(app_dir: Path) -> None:
    """The shape that actually shipped: both tools named, no actionable rule.

    Rewrites the bullet into the v2 wording - render_map championed, data_to_map
    hedged as "when available" - which is exactly the text the agent read before it
    called render_map three times in CoWork.
    """
    def fn(orch, resp):
        start, end = surface_bullet(orch)
        weak = (
            "- Maps: render_map draws inline in your answer and is the path here. "
            "data_to_map is a host-injected CoWork tool and is not always available, so "
            "prefer render_map."
        )
        return orch[:start] + weak + orch[end:], resp
    edit_specs(app_dir, fn)


def m5_restore_false_claim(app_dir: Path) -> None:
    edit_specs(app_dir, lambda o, r: (o, r + " " + FALSE_CLAUSE))


def m6_paraphrase_false_claim(app_dir: Path) -> None:
    edit_specs(app_dir, lambda o, r: (o, r + " " + FALSE_CLAUSE_PARAPHRASE))


def m7_discriminator_only_in_cowork_block(app_dir: Path) -> None:
    """Move the rule out of the render_map block into the CoWork block below it.

    Block scope is the point: an agent reading the render_map instructions and
    deciding whether to call render_map does not get there. This is the adjacency
    failure RULE A and RULE D each learned once already.
    """
    def fn(orch, resp):
        start, end = surface_bullet(orch)
        bullet = orch[start:end]
        orch = orch[:start] + orch[end + 1:]
        anchor = "DRAWING A MAP IN COWORK"
        i = orch.index(anchor)
        j = orch.index("\n", i) + 1
        return orch[:j] + bullet + "\n" + orch[j:], resp
    edit_specs(app_dir, fn)


MUTATIONS = [
    ("M1 surface bullet deleted", m1_delete_surface_bullet,
     "the agent has no way to tell the surfaces apart"),
    ("M2 consequence dropped (no 'no map appears')", m2_drop_consequence,
     "'use data_to_map' with no reason is ignorable"),
    ("M3 observable signal dropped (no 'tool list')", m3_drop_tool_list_signal,
     "'you are in CoWork' is not a rule if nothing says how to tell"),
    ("M4 both tools named, rule reduced to a preference", m4_both_names_no_rule,
     "this is the exact text that shipped and failed"),
    ("M5 false 'unavailable to you' claim restored", m5_restore_false_claim,
     "response outranks orchestration when composing the answer"),
    ("M6 false claim paraphrased", m6_paraphrase_false_claim,
     "RULE H must not be pinned to the old wording"),
    ("M7 rule moved to the CoWork block", m7_discriminator_only_in_cowork_block,
     "it must be where the render_map decision is made"),
]


def main() -> int:
    failures: list[str] = []
    print("Negative tests for check_map_guidance.py RULES G and H\n")

    # Positive control. If a clean staged copy does not PASS, every FAIL below is
    # meaningless - it would only prove the staging is broken.
    with tempfile.TemporaryDirectory() as td:
        app = stage(Path(td))
        rc, out = run_gate(app)
        if rc != 0:
            print("  FAIL  positive control: a clean staged copy does not pass")
            print("\n".join("        " + ln for ln in out.strip().split("\n")))
            return 1
        print("  ok    positive control: clean staged copy passes")

    for label, mutate, why in MUTATIONS:
        with tempfile.TemporaryDirectory() as td:
            app = stage(Path(td))
            mutate(app)
            rc, out = run_gate(app)
            if rc == 0:
                failures.append(f"{label}: gate PASSED on a mutated tree - {why}")
                print(f"  FAIL  {label} (gate passed)")
            else:
                print(f"  ok    {label}")

    # The vacuity guard: no specs in scope must FAIL rather than pass silently.
    with tempfile.TemporaryDirectory() as td:
        app = stage(Path(td))
        rc, out = run_gate(app, specs=[])
        if rc == 0:
            failures.append(
                "M8 empty spec list: gate PASSED having inspected zero specs - a rule "
                "with an empty scope checks nothing"
            )
            print("  FAIL  M8 empty spec list (gate passed with zero specs)")
        elif "inspected nothing" not in out:
            failures.append(
                "M8 empty spec list: gate failed, but not via the vacuity guard - "
                "the reason reported was something else"
            )
            print("  FAIL  M8 empty spec list (failed for the wrong reason)")
        else:
            print("  ok    M8 empty spec list (vacuity guard fired)")

    print()
    if failures:
        print(f"FAIL: {len(failures)} mutation(s) were not caught:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"PASSED: all {len(MUTATIONS) + 1} mutations rejected, "
          f"clean copy accepted")
    return 0


if __name__ == "__main__":
    sys.exit(main())
