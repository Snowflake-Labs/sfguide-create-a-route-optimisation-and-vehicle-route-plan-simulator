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

NINE RULES
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
  G. Every page that publishes a LIST memo must bound it by CHARACTERS through
     joinBounded with a named budget, and must not keep the old unbounded
     `.join('; ') + (+N more)` form beside it. Row count is not a bound.
  H. The consumer (app/api/chat/route.ts) must CLAMP a panel that alone exceeds
     the budget instead of deleting it, must say it truncated, and must not
     announce "On-screen values by panel" when the block came out empty.
  I. Worst case must FIT. A second, separate silent failure shipped here: the
     assignments memo measured 3,627 chars against a 3,000-char total, route.ts
     trimmed whole panels, so the ONLY memo on that view was dropped in full
     while its scalar KPIs survived as "Active filters". The agent could total a
     21-trip plan and could not name one trip in it, hedged about the top row,
     and fell back to SQL - with no error on any surface. G alone does not catch
     that (a 4,000-char cap satisfies G and is still deleted whole), so this rule
     does the arithmetic against the consumer's budget.

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

CHAT_ROUTE = SA_APP / "ui/src/app/api/chat/route.ts"
MEMO_BUDGET = SA_APP / "ui/src/lib/memo-budget.ts"

# Pages that publish a LIST of records as a memo, rather than a table sample.
LIST_PUBLISHERS = [
    VIEW,
    SA_APP / "ui/src/components/views/areas/backload-proposals.tsx",
    SA_APP / "ui/src/components/views/areas/triangle-proposals.tsx",
]

# Measured length of one rendered rehydrated trip line (trailer, source, load,
# first pickup, final dropoff, stop chain, drops, km split, margin clause).
OBSERVED_TRIP_LEN = 298


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8") if p.is_file() else ""


def memo_block(src: str) -> str:
    """The __memo_backload_matching construction only.

    Scoped so a rule cannot be satisfied by an unrelated mention elsewhere in a
    2000-line view: the whole point is what the AGENT receives.

    BOTH head forms are accepted, and that is load-bearing. The anchor used to be
    the bounded form's `const tripParts` alone, and when a commit written from a
    stale copy of the view reverted the bound, this returned "" - so rules A and
    B reported "inspected 0 items - paths are stale" and D claimed the drops list
    was unscrubbed when it plainly was not. Three rules lied about the cause
    while G and I told the truth. Matching either head keeps A/B/D inspecting the
    real text, so only the rules that are actually broken fail.
    """
    for anchor in ("const tripParts = visibleAssignments", "const memo = visibleAssignments"):
        start = src.find(anchor)
        if start >= 0:
            break
    else:
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


def rule_g():
    """Every list publisher bounds its memo by CHARACTERS, not by row count."""
    violations, checked = [], 0
    for path in LIST_PUBLISHERS:
        src = read(path)
        if not src:
            continue
        checked += 1
        if "joinBounded(" not in src:
            violations.append(
                f"{path.name} publishes a __memo_ list without joinBounded: MAX_TRIPS bounds "
                "ROWS, not characters, and the consumer trims WHOLE PANELS - so a list that "
                "outgrows the budget is deleted from the agent's context, not shortened"
            )
        checked += 1
        if not re.search(r"joinBounded\([^)]*(TRIP_MEMO_MAX_LEN|MEMO_MAX_LEN|Budget|budget)", src):
            violations.append(
                f"{path.name} calls joinBounded without a named budget; the cap must come from "
                "lib/memo-budget.ts so it cannot drift from the consumer's total"
            )
        checked += 1
        # The naive form this replaced. Re-adding it BESIDE the bounded join is the
        # false-pass shape: joinBounded would be present and unused.
        if re.search(r"\}\)\.join\('; '\)\s*\+\s*\(", src):
            violations.append(
                f"{path.name} still ends a mapped list with .join('; ') + (row-count suffix); "
                "that is the unbounded form, and its presence beside joinBounded means the "
                "bounded path may not be the one that publishes"
            )
    return violations, checked


def rule_h():
    """The consumer clamps an oversize single panel and never announces an empty block."""
    violations, checked = [], 0
    src = read(CHAT_ROUTE)
    if not src:
        return ["api/chat/route.ts not found - rule cannot run"], 0

    checked += 1
    if "from '@/lib/memo-budget'" not in src:
        violations.append(
            "route.ts does not import the budget from lib/memo-budget: a locally declared "
            "MEMO_TOTAL_MAX drifted from the publishers once already, and the drift is silent"
        )
    checked += 1
    if re.search(r"MEMO_TOTAL_MAX\s*=\s*\d+", src):
        violations.append("route.ts re-declares MEMO_TOTAL_MAX locally instead of importing it")

    checked += 1
    # The clamp: the i===0 branch must PRODUCE text, not just break.
    clamp = re.search(r"if \(i === 0\)\s*\{(.*?)\}\s*else", src, re.S)
    if not clamp:
        violations.append(
            "route.ts has no i === 0 branch in the memo trim loop, so a panel that alone "
            "exceeds the budget is dropped entirely - the exact failure that hid a 21-trip "
            "plan from the agent while its KPI scalars stayed visible"
        )
    else:
        body = clamp.group(1)
        checked += 1
        if "memoText =" not in body:
            violations.append("the i === 0 branch does not assign memoText, so it still drops the panel")
        checked += 1
        if "truncated" not in body:
            violations.append(
                "the clamped panel does not declare that it was truncated; a silently cut memo "
                "is quoted as if complete"
            )

    checked += 1
    # The empty-block guard must gate the ANNOUNCEMENT, not merely exist.
    guard = re.search(r"if \(memoText\.trim\(\)\)\s*\{(.*?)\n        \} else", src, re.S)
    if not guard:
        violations.append(
            "route.ts pushes the On-screen values block without checking memoText is non-empty: "
            "'On-screen values by panel:  | (+1 more panels not shown)' plus a 'quote them' "
            "instruction is what makes the agent improvise from the filters"
        )
    elif "On-screen values by panel" not in guard.group(1):
        violations.append("the non-empty guard does not wrap the On-screen values line itself")

    return violations, checked


def rule_i():
    """Simulate the worst case: the published memo must FIT the consumer's budget.

    This is the only rule that would have caught the original defect. G asserts a
    bound exists; this asserts the bound is small enough to survive the consumer,
    which is a different claim - a publisher capped at 4000 chars passes G and is
    still deleted whole by a 3600-char total.

    OBSERVED_TRIP_LEN is measured from the real rendered line (a rehydrated trip
    with a chain, a drops list and the margin clause), the same way
    verify_map_spec keeps an OBSERVED_SPEC fixture rather than guessing.
    """
    violations, checked = [], 0
    budget = read(MEMO_BUDGET)
    if not budget:
        return ["lib/memo-budget.ts not found - rule cannot run"], 0

    def const(name: str):
        m = re.search(rf"export const {name}\s*=\s*(\d+)", budget)
        return int(m.group(1)) if m else None

    total = const("MEMO_TOTAL_MAX")
    trip = const("TRIP_MEMO_MAX_LEN")
    checked += 1
    if total is None or trip is None:
        return ["MEMO_TOTAL_MAX / TRIP_MEMO_MAX_LEN not readable from lib/memo-budget.ts"], checked

    # A memo reaches the prompt as "<area>: <memo>", joined with " | ".
    label = len("backload_matching: ") + len(" | ")
    checked += 1
    if trip + label > total:
        violations.append(
            f"TRIP_MEMO_MAX_LEN ({trip}) plus its area label ({label}) exceeds MEMO_TOTAL_MAX "
            f"({total}): a memo at its own cap cannot fit the consumer, so route.ts would "
            "clamp or drop every full list"
        )

    # Worst-case naive length: if the unbounded form would not have fitted, the
    # publisher MUST be bounding by characters. This is what fails on the code as
    # it shipped: 12 x 298 + label = 3,627 against a total of 3,000.
    src = read(VIEW)
    m = re.search(r"const MAX_TRIPS = (\d+)", src)
    max_trips = int(m.group(1)) if m else 0
    checked += 1
    if not max_trips:
        violations.append("MAX_TRIPS not readable from backload-matching.tsx")
    else:
        naive = max_trips * OBSERVED_TRIP_LEN + label
        checked += 1
        # Compared against the PER-MEMO cap, not the total, on purpose. Comparing
        # against the total made this rule knife-edge: raising MEMO_TOTAL_MAX to
        # just above the observed worst case let the unbounded form pass again,
        # and a mutation proved it. The row ceiling alone can produce more text
        # than the per-memo budget allows, so the character bound must exist
        # regardless of how generous the total currently is - and the observed
        # 298 is a plain rehydrated trip, while a chained 8-stop tour is far
        # longer.
        if naive > trip and "joinBounded(" not in memo_block(src):
            violations.append(
                f"{max_trips} trips of ~{OBSERVED_TRIP_LEN} chars = {naive} exceeds "
                f"TRIP_MEMO_MAX_LEN ({trip}) and the memo block does not bound by characters: "
                "the consumer trims whole panels, so the entire assignments list would be "
                "deleted from the agent's context with no error anywhere"
            )
        checked += 1
        if naive <= trip:
            violations.append(
                f"fixture arithmetic is inert: {max_trips} x {OBSERVED_TRIP_LEN} + {label} fits "
                f"TRIP_MEMO_MAX_LEN ({trip}), so the bound above is never exercised - re-measure "
                "OBSERVED_TRIP_LEN from a rendered trip line rather than lowering it"
            )

    return violations, checked


def main() -> int:
    results = [
        ("A memo derives endpoints from STOPS", *rule_a()),
        ("B loads named and chained tours marked", *rule_b()),
        ("C destination is the last dropoff", *rule_c()),
        ("D placeholder tokens scrubbed on both paths", *rule_d()),
        ("E guidance states multi-load, artifact fresh", *rule_e()),
        ("F agent-spec rule in the query_backload bullet", *rule_f()),
        ("G list memos bounded by characters", *rule_g()),
        ("H consumer clamps instead of dropping", *rule_h()),
        ("I worst-case memo fits the budget", *rule_i()),
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
