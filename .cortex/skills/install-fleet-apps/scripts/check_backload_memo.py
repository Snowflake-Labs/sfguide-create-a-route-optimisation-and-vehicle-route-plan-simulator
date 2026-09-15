#!/usr/bin/env python3
"""
check_backload_memo.py - a backload trip published to the agent must describe
every load it carries, and its destination must be the LAST dropoff.

WHY THIS IS A GATE

A user asked the agent for the workload of one truck. The agent answered "Pickup
origin: Sunoco Gas Station / Final destination: RCA Trucking / 2 deliveries" for
a tour that actually carried TWO loads - INT-00436 handed over at RCA Trucking,
then INT-00376 collected there and delivered onward. The app's own Stops panel
showed the real 6-stop chain on screen at the same time.

The agent was not hallucinating. It re-narrated __memo_backload_matching, and
the memo really did say that. `Assignment.STOPS` holds the complete tour, but
the scalar `OFFER_ID` / `PICKUP_CITY` / `PROPOSAL_DROPOFF_CITY` fields beside it
are read from the FIRST pickup only, and the memo was built from those scalars.
So hop 1 was published as the whole workload, and the second load id appeared
nowhere the agent could see it.

That makes this failure mode invisible by construction:

  - Nothing throws. The memo is well formed and every number in it is correct.
  - The drop LIST was already chain-correct, so the memo contradicted itself and
    the agent resolved the contradiction by trusting the "A->B" summary.
  - A wrong destination is indistinguishable from a right one without knowing
    the stop order, which is exactly what the flattened form threw away.
  - "Destination" is a PLACEHOLDER token for an unnamed site, not a place. The
    chain solver scrubs it server-side; the client memo did not, so the agent
    reported "Destination" to the user as a delivery point.

SIX RULES

  A. The memo must derive its origin/destination from STOPS via
     describeTourChain, and must NOT interpolate the scalar PICKUP_CITY ->
     PROPOSAL_DROPOFF_CITY pair as the tour's endpoints. Banning the flat form
     by name matters: adding chain text while LEAVING the old summary in place
     restores the contradiction that caused the defect.
  B. The memo must name the loads and mark a multi-load tour as chained. A stop
     list without load ids cannot answer "which loads is this truck carrying".
  C. finalDropoff must come from the LAST dropoff. Asserted as the indexing
     form, not merely by the word "final": a mutation that points the same
     field at drops[0] leaves every other rule passing and reproduces the
     original bug exactly.
  D. The placeholder token set must exist and be applied on BOTH published
     paths - the chain text and the drops list. Scrubbing one leaves the other
     quoting "Destination" as a city.
  E. pack-views.json agentKnowledge must state the multi-load fact, AND the
     generated SKILL.md must carry the same sentence. The skill file is derived,
     so a correct source with a stale artifact ships the old guidance.
  F. agent-spec.json must carry the multi-load rule in the SAME bullet as
     query_backload. Same-bullet adjacency is required on purpose: this repo has
     already had a prose gate false-pass off a neighbouring bullet thousands of
     characters away.

  Plus vacuity counters. Every rule reports how many items it inspected and the
  run fails on zero. Two gates in this repo have previously passed while
  inspecting nothing at all.
"""

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
SA_APP = SKILL / "fleet_sa_app"

VIEW = SA_APP / "ui/src/components/views/areas/backload-matching.tsx"
HELPERS = SA_APP / "ui/src/components/views/areas/backload-matching/helpers.ts"
PACK_VIEWS = SA_APP / "ui/src/lib/packs/fleet/pack-views.json"
SKILL_MD = SA_APP / "app/cowork_skills/backload_matching/SKILL.md"
AGENT_SPEC = SA_APP / "app/agent-spec.json"

PLACEHOLDER_TOKENS = ["origin", "destination", "drop-off", "dropoff", "unknown", "depot"]


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.is_file() else ""


def memo_block(src: str) -> str:
    """The __memo_backload_matching construction only.

    Scoped so a rule cannot be satisfied by an unrelated mention elsewhere in a
    2000-line view: the whole point is what the AGENT receives.
    """
    start = src.find("const memo = visibleAssignments.length")
    if start < 0:
        return ""
    end = src.find("__memo_backload_matching", start)
    return src[start:end] if end > start else src[start:]


def rule_a():
    """Memo endpoints derived from STOPS, not from the first-pickup scalars."""
    violations, checked = [], 0
    block = memo_block(read(VIEW))
    if not block:
        return ["memo construction not found in backload-matching.tsx - rule cannot run"], 0

    checked += 1
    if "describeTourChain(a.STOPS" not in block:
        violations.append(
            "memo does not call describeTourChain(a.STOPS, ...): it is deriving the "
            "trip description from something other than the ordered stop list"
        )

    checked += 1
    # The exact flattened form that shipped the defect: the two first-pickup
    # scalars interpolated as the tour's two endpoints.
    flat = re.compile(r"a\.PICKUP_CITY[^`$]{0,40}\}\s*->\s*\$\{[^}]*a\.PROPOSAL_DROPOFF_CITY")
    if flat.search(block):
        violations.append(
            "memo still interpolates PICKUP_CITY -> PROPOSAL_DROPOFF_CITY as the tour "
            "endpoints; those come from the FIRST pickup only, so a chained tour reports "
            "its handover point as the destination"
        )

    checked += 1
    if "tour.finalDropoff" not in block:
        violations.append("memo does not publish tour.finalDropoff as the destination")

    return violations, checked


def rule_b():
    """Loads named, and a multi-load tour marked as chained."""
    violations, checked = [], 0
    block = memo_block(read(VIEW))
    if not block:
        return ["memo construction not found - rule cannot run"], 0

    checked += 1
    if "tour.loadIds" not in block:
        violations.append("memo does not publish tour.loadIds, so the agent cannot name the loads carried")

    checked += 1
    if not re.search(r"tour\.loadIds\.length\s*>\s*1", block):
        violations.append(
            "memo does not branch on more than one load, so a chained tour is published "
            "in the same shape as a single-load one"
        )

    checked += 1
    if "CHAINED" not in block:
        violations.append(
            "memo does not label a multi-load tour CHAINED; the guidance surfaces key off "
            "that word, so dropping it silently unhooks them"
        )

    checked += 1
    helpers = read(HELPERS)
    if not re.search(r"if\s*\(s\.offerId\s*&&\s*!loadIds\.includes\(s\.offerId\)\)", helpers):
        violations.append(
            "describeTourChain does not accumulate DISTINCT offerIds in first-touch order; "
            "a chained tour touches the same load twice (pickup + dropoff)"
        )

    return violations, checked


def rule_c():
    """Destination is the LAST dropoff, asserted as the indexing form."""
    violations, checked = [], 0
    helpers = read(HELPERS)
    if "describeTourChain" not in helpers:
        return ["describeTourChain not found in helpers.ts - rule cannot run"], 0

    checked += 1
    if not re.search(r"drops\[drops\.length\s*-\s*1\]", helpers):
        violations.append(
            "lastDrop is not drops[drops.length - 1]: the destination must be the LAST "
            "dropoff, and any other index reproduces the original defect"
        )

    checked += 1
    if re.search(r"lastDrop\s*=\s*[^;]*drops\[0\]", helpers):
        violations.append("lastDrop reads drops[0] - that is hop 1, not the destination")

    checked += 1
    # Reachability: finalDropoff must actually be fed by lastDrop, or rule C
    # asserts a variable nothing consumes.
    if not re.search(r"finalDropoff:\s*lastDrop", helpers):
        violations.append(
            "finalDropoff is not computed from lastDrop, so the last-dropoff check above "
            "is asserting a value the published field never reads"
        )

    checked += 1
    if not re.search(r"kind\s*===\s*'dropoff'", helpers):
        violations.append("drops is not filtered to dropoff stops")

    return violations, checked


def rule_d():
    """Placeholder tokens defined, and scrubbed on both published paths."""
    violations, checked = [], 0
    helpers = read(HELPERS)

    checked += 1
    if "PLACEHOLDER_PLACES" not in helpers:
        violations.append("PLACEHOLDER_PLACES set is missing from helpers.ts")
    else:
        m = re.search(r"PLACEHOLDER_PLACES\s*=\s*new Set\(\[(.*?)\]\)", helpers, re.S)
        body = m.group(1).lower() if m else ""
        for tok in PLACEHOLDER_TOKENS:
            checked += 1
            if f"'{tok}'" not in body:
                violations.append(
                    f"placeholder token '{tok}' missing - it is in the server-side "
                    "PLACEHOLDERS set, so the two surfaces would disagree"
                )

    checked += 1
    if not re.search(r"function realPlace", helpers):
        violations.append("realPlace() scrub helper is missing from helpers.ts")

    checked += 1
    if "realPlace(s.city)" not in helpers:
        violations.append("describeTourChain does not scrub stop cities through realPlace")

    # Both published paths. The drops list is built in the view, separately from
    # the chain text, so scrubbing one is not scrubbing the other.
    block = memo_block(read(VIEW))
    checked += 1
    if "realPlace(s.city)" not in block:
        violations.append(
            "the memo drops list does not scrub cities through realPlace, so it can still "
            "publish the bare token 'Destination' as a delivery point"
        )

    return violations, checked


def rule_e():
    """Source guidance states the multi-load fact, and the derived skill matches."""
    violations, checked = [], 0
    if not PACK_VIEWS.is_file():
        return ["pack-views.json not found - rule cannot run"], 0

    know = json.loads(read(PACK_VIEWS)).get("backload_matching", {}).get("agentKnowledge", {})
    haystack = " ".join(
        [str(v) for v in know.get("keyMetrics", [])] + [str(know.get("gotchas", ""))]
    )

    required = {
        "multi-load statement": r"(SEVERAL LOADS|more than one load)",
        "final-dropoff rule": r"(FINAL dropoff|final dropoff|FINAL dropoff as the destination)",
        "chained wording": r"CHAINED",
        "placeholder warning": r"placeholder",
    }
    for label, pat in required.items():
        checked += 1
        if not re.search(pat, haystack):
            violations.append(f"pack-views agentKnowledge does not state the {label}")

    # The skill file is GENERATED from the block above. A correct source with a
    # stale artifact deploys the old, flat guidance.
    md = read(SKILL_MD)
    checked += 1
    if not md:
        violations.append("generated backload_matching/SKILL.md not found")
    elif not re.search(r"(SEVERAL LOADS|more than one load)", md):
        violations.append(
            "SKILL.md does not carry the multi-load statement - it is derived, so run "
            "scripts/build_cowork_skills.py after editing pack-views.json"
        )

    return violations, checked


def rule_f():
    """The multi-load rule sits in the query_backload bullet itself."""
    violations, checked = [], 0
    if not AGENT_SPEC.is_file():
        return ["agent-spec.json not found - rule cannot run"], 0

    orch = json.loads(read(AGENT_SPEC)).get("instructions", {}).get("orchestration", "")
    bullets = [b for b in orch.split("\n- ") if "query_backload" in b]
    if not bullets:
        return ["no query_backload bullet in orchestration - rule cannot run"], 0

    for b in bullets:
        if "panel context" not in b:
            continue  # not the on-screen-plan bullet
        checked += 1
        if not re.search(r"(SEVERAL LOADS|more than one load)", b):
            violations.append(
                "the query_backload / panel-context bullet does not say a trip may carry "
                "several loads. It must be in THIS bullet: a rule satisfied from anywhere "
                "in a 35k-character string is satisfied by text the agent reads as "
                "guidance for a different tool"
            )
        checked += 1
        if not re.search(r"FINAL dropoff", b):
            violations.append("the query_backload bullet does not name the FINAL dropoff as the destination")

    return violations, checked


def main() -> int:
    results = [
        ("A memo derives endpoints from STOPS", *rule_a()),
        ("B loads named and chained tours marked", *rule_b()),
        ("C destination is the last dropoff", *rule_c()),
        ("D placeholder tokens scrubbed on both paths", *rule_d()),
        ("E guidance states multi-load, artifact fresh", *rule_e()),
        ("F agent-spec rule in the query_backload bullet", *rule_f()),
    ]

    failed = False
    for label, violations, checked in results:
        if checked == 0:
            print(f"FAILED [{label}]: inspected 0 items - paths are stale, so this rule is vacuous.")
            failed = True
            continue
        if violations:
            failed = True
            print(f"FAILED [{label}]: {len(violations)} violation(s) over {checked} inspected:")
            for v in violations:
                print("  - " + v)
        else:
            print(f"PASSED [{label}]: {checked} inspected, no violations.")

    if failed:
        print(
            "\n  A backload tour may carry several loads. Publish it from STOPS:\n"
            "  every load id, the ordered stops, and the LAST dropoff as the\n"
            "  destination. Do not restore the flat first-pickup summary to make\n"
            "  this pass - the agent quotes whatever the memo says back to the\n"
            "  user as fact, and a handover point named as the destination is a\n"
            "  wrong answer that nothing else in the stack can catch."
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
