#!/usr/bin/env python3
"""Negative tests for check_forced_region_refusal.py.

A gate that has never been seen to FAIL is not a gate. Each mutation below
reintroduces one real shape of the 2026-09-18 defect (or one plausible
half-fix) and the driver asserts the gate exits non-zero AND names the right
rule. Every file is restored in a `finally`, and the gate is run with a
timeout so a mutation cannot hang the driver.

Run: python3 mutate_forced_region_refusal.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / "check_forced_region_refusal.py"
REPO = HERE.parents[3]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
TOOLS_SQL = REPO / ".cortex/skills/routing-agent/references/deploy-agent.sql"
CHAT_ROUTE = SKILL / "fleet_sa_app/ui/src/app/api/chat/route.ts"
VERB_TS = SKILL / "fleet_tools/user/src/procs/get_directions.ts"
SPEC = SKILL / "fleet_sa_app/app/agent-spec.json"


def run_gate() -> tuple[int, str]:
    p = subprocess.run(
        [sys.executable, str(GATE)], capture_output=True, text=True, timeout=120
    )
    return p.returncode, p.stdout + p.stderr


# ---- mutations: each takes the original text and returns the mutated text ----


def m1_restore_default_region(src: str) -> str:
    """The shipped prefix: tell the agent to default a routing region."""
    return src.replace(
        "`The region above scopes fleet DATA, not routing: routing verbs resolve "
        "their own region from the places named, so pass region = null to them and "
        "never force this one. ` +\n      `Pass the routing profile shown above when "
        "the user does not name a travel type. ` +",
        "`When a routing tool needs a region or profile and the user did not name "
        "one, default to this region and pass the routing profile shown above (or "
        "null to use the active vehicle). ` +",
    )


def m2_bare_is_null(src: str) -> str:
    """Half-fix: the entry IS tested, but with the JSON-null-blind operator."""
    return src.replace(
        "IS_NULL_VALUE(m.R:destinations[s.INDEX]) AS UNSNAPPED",
        "m.R:destinations[s.INDEX] IS NULL AS UNSNAPPED",
    )


def _swap_blocks(src: str) -> str:
    """Move the unsnapped refusal BELOW the leg refusal (both still present)."""
    def block(start_pat: str) -> tuple[int, int]:
        m = re.search(start_pat, src)
        assert m, start_pat
        end = src.index("END IF;", m.start()) + len("END IF;")
        return m.start(), end

    u0, u1 = block(r"        -- Ordered BEFORE the leg check on purpose\.")
    unsnapped = src[u0:u1]
    rest = src[:u0] + src[u1:]
    l0, l1 = (lambda m: (m.start(), rest.index("END IF;", m.start()) + len("END IF;")))(
        re.search(r"        IF \(v_unroutable_legs IS NOT NULL", rest)
    )
    return rest[:l1] + "\n\n" + unsnapped + rest[l1:]


def m3_reorder(src: str) -> str:
    return _swap_blocks(src)


def m4_drop_one_suggested_region(src: str) -> str:
    """Only the UNROUTABLE_LEG branch loses the suggestion."""
    i = src.index("'error_code', 'UNROUTABLE_LEG'")
    head, tail = src[:i], src[i:]
    return head + tail.replace("                'suggested_region', v_suggested_region,\n", "", 1)


def m5_spec_keeps_blanket_ban(src: str) -> str:
    d = json.loads(src)
    o = d["instructions"]["orchestration"]
    d["instructions"]["orchestration"] = re.sub(
        r" - the ONE exception is a result carrying retry_without_region.*?never treat"
        r" that case as final\.",
        ".",
        o,
        flags=re.S,
    )
    assert "retry_without_region" not in d["instructions"]["orchestration"]
    return json.dumps(d, indent=2)


def m6_comment_only(src: str) -> str:
    """The rule is present, but as a COMMENT - so it never reaches the agent."""
    src = src.replace(
        " - unless the result ' +\n    'carries retry_without_region, which means the "
        "region was forced and ' +\n    'suggested_region covers every place: then "
        "retry exactly once with region null.',",
        ".',",
    )
    return src.replace(
        "export const get_directions = defineProc({",
        "// retry_without_region means the region was forced: retry exactly once with\n"
        "// region null when suggested_region covers every place.\n"
        "export const get_directions = defineProc({",
    )


def m7_rename_prefix(src: str) -> str:
    """Rule A's subject disappears - the vacuity counter must catch it."""
    return src.replace("activeContextPrefix", "ctxHiddenTurnPrefix")


MUTATIONS = [
    ("M1 prefix defaults a routing region", CHAT_ROUTE, m1_restore_default_region, "RULE A"),
    ("M2 destination entry tested with bare IS NULL", TOOLS_SQL, m2_bare_is_null, "RULE B"),
    ("M3 unsnapped branch moved after the leg branch", TOOLS_SQL, m3_reorder, "RULE C"),
    ("M4 one refusal loses suggested_region", TOOLS_SQL, m4_drop_one_suggested_region, "RULE D"),
    ("M5 agent spec keeps the blanket ban", SPEC, m5_spec_keeps_blanket_ban, "RULE E"),
    ("M6 retry rule demoted to a comment", VERB_TS, m6_comment_only, "RULE E"),
    ("M7 prefix renamed, rule A unreachable", CHAT_ROUTE, m7_rename_prefix, "RULE A"),
]


def main() -> int:
    rc, out = run_gate()
    if rc != 0:
        print("BASELINE FAILED - fix the tree before running mutations:\n" + out)
        return 1
    print("baseline: PASS\n")

    failures = 0
    for label, path, mutate, expect in MUTATIONS:
        original = path.read_text()
        try:
            mutated = mutate(original)
            if mutated == original:
                print(f"  {label}: SKIPPED-BROKEN - mutation changed nothing")
                failures += 1
                continue
            path.write_text(mutated)
            rc, out = run_gate()
        except Exception as exc:  # noqa: BLE001 - report, never leave the tree dirty
            print(f"  {label}: DRIVER ERROR {exc!r}")
            failures += 1
            continue
        finally:
            path.write_text(original)

        if rc == 0:
            print(f"  {label}: NOT CONVICTED (gate passed) <- gate is blind here")
            failures += 1
        elif expect not in out:
            print(f"  {label}: convicted but by the wrong rule (wanted {expect})")
            failures += 1
        else:
            print(f"  {label}: convicted by {expect}")

    rc, _ = run_gate()
    if rc != 0:
        print("\nTREE NOT RESTORED - gate fails after the run")
        return 1
    print(f"\n{len(MUTATIONS) - failures}/{len(MUTATIONS)} mutations convicted")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
