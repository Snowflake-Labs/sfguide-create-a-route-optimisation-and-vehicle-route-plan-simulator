#!/usr/bin/env python3
"""Validate that a FORCED routing region cannot turn a routable trip into a dead
end, and that an off-graph coordinate is never reported as an unroutable leg.

All five rules were violated live on 2026-09-18 by one question - "show me the
route from SF international airport to Civic center" - which is fully routable:
measured on TIB, MATRIX_TABULAR('driving-car', SFO, CivicCenter, 'SanFrancisco')
returns durations [[0,1435.33],[1575.69,0]], and COVERING_REGION_FOR_POINTS names
SanFrancisco for the pair. The agent was nevertheless told, as a FINAL refusal,
that no navigable road path exists between the two - and then invented an
explanation about peninsula geography and the Ops Console to fill the gap.

RULE A - the SA app's active-context prefix must not default a routing REGION.
    ui/src/app/api/chat/route.ts prepended to the USER turn: "When a routing tool
    needs a region or profile and the user did not name one, default to this
    region". The agent spec says the opposite for this exact verb ("Leave `region`
    null: it is resolved from the places"), and the prefix won because it rides in
    the user message while orchestration sits further away. "The user did not name
    one" was the trap: the user named PLACES, not a region, so the default read as
    applying. VW_AGENT_VERB_CALLS shows region = UnitedStatesOfAmerica on four
    turns. A forced region can only be equal to or worse than the resolved one, so
    the prefix must bind routing region to null and say the active region scopes
    DATA.

RULE B - the off-graph pre-flight must test the destination ENTRY with
    IS_NULL_VALUE, never a bare IS NULL.
    ORS writes the WHOLE destinations element as JSON null when it cannot snap a
    coordinate to the graph at all. Measured for SFO against the
    UnitedStatesOfAmerica long-haul HGV graph: destinations = [null, {..., 60.79}].
    A VARIANT JSON null is not SQL NULL - verified again here:
    `destinations[0] IS NULL` -> FALSE, `IS_NULL_VALUE(destinations[0])` -> TRUE.
    Same trap the ::FLOAT cast on the durations cell already documents, one field
    over, so a bare IS NULL yields a check that runs and cannot convict.

RULE C - the unsnappable-coordinate refusal must come BEFORE the leg refusal.
    An unsnappable coordinate nulls every leg that touches it, so the leg branch
    fires first and always mis-states the cause: "no road route exists between
    place 1 and place 2 ... usually separated by water" for two points 20 km apart
    in one city. Ordering is the whole fix - both branches existing is not enough.

RULE D - every refusal reachable with a caller-supplied region must carry
    retry_without_region.
    TOOL_DIRECTIONS already knew the region came from the caller
    (v_region_source = 'caller') and already had COVERING_REGION_FOR_POINTS, but
    never consulted it on the forced path, so a recoverable failure was reported as
    final. One branch left without the flag is enough to strand the caller, which
    is why this rule counts branches rather than occurrences.

RULE E - the verb description AND the agent spec must both state the retry
    exception and name retry_without_region.
    The description ended "All three are refusals to report, not conditions to
    retry" and the orchestration bullet ended "do not re-issue the same call with
    a different profile or a forced region". The agent obeyed both, correctly. Text
    in only one of the two loses: whichever surface still carries the blanket ban
    is the one the agent reads. A MENTION in a comment does not count - the rule
    must be in the shipped string.

Exit 0 clean, 1 on any violation.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
SKILL = REPO / ".cortex/skills/install-fleet-apps"
TOOLS_SQL = REPO / ".cortex/skills/routing-agent/references/deploy-agent.sql"
CHAT_ROUTE = SKILL / "fleet_sa_app/ui/src/app/api/chat/route.ts"
VERB_TS = SKILL / "fleet_tools/user/src/procs/get_directions.ts"
SPECS = (
    SKILL / "fleet_sa_app/app/agent-spec.json",
    SKILL / "fleet_sa_app/app/super-agent-spec.json",
)

# Set by each rule that actually read its subject, so a rule made unreachable by
# a rename or a moved file fails LOUDLY instead of passing on an empty scan. A
# gate that inspected nothing is documentation, not a gate - two rules in an
# earlier harness in this repo passed for exactly that reason.
SEEN: dict[str, int] = {}


def strip_line_comments(src: str) -> str:
    """Blank whole-line comments, preserving line numbers.

    Load-bearing here for the same reason as check_routing_probe: the code being
    checked DOCUMENTS the patterns it must not contain. The fixed route.ts quotes
    the old "default to this region" prefix verbatim in its header, and the fixed
    SQL quotes `destinations[0] IS NULL`, so an unstripped scan convicts the fix.
    """
    out = []
    for line in src.split("\n"):
        s = line.lstrip()
        out.append("" if s.startswith(("--", "//", "#", "*")) else line)
    return "\n".join(out)


def tool_directions_body(sql: str) -> tuple[int, str] | None:
    m = re.search(
        r"CREATE\s+OR\s+REPLACE\s+PROCEDURE\s+FLEET_INTELLIGENCE\.ROUTING_TOOLS\."
        r"TOOL_DIRECTIONS\s*\(",
        sql,
        re.I,
    )
    if not m:
        return None
    # Bodies end at the dollar-quote terminator, not at the next CREATE: the
        # file continues with sibling procs that have their own refusal branches.
    end = sql.find("\n$$;", m.start())
    end = len(sql) if end == -1 else end
    return sql.count("\n", 0, m.start()) + 1, sql[m.start():end]


def rule_a() -> list[str]:
    if not CHAT_ROUTE.exists():
        return [f"RULE A: missing {CHAT_ROUTE.relative_to(REPO)}"]
    src = strip_line_comments(CHAT_ROUTE.read_text())
    # Greedy to the closing bracket of the prefix literal, NOT `.*?;`: the
    # template contains `${ctxBits.join('; ')}`, so a non-greedy stop at the first
    # semicolon captured one line and made rules A2/A3 fail on the FIXED file.
    m = re.search(r"activeContextPrefix\s*=\s*(.*?\]\\n\\n`\s*);", src, re.S)
    if not m:
        return [
            "RULE A: no activeContextPrefix assignment found in chat/route.ts - the "
            "region-defaulting check cannot run, so this is a failure, not a skip."
        ]
    prefix = m.group(1)
    SEEN["A"] = 1
    bad = []
    # The defect shape: telling the agent to DEFAULT a region for a routing tool.
    if re.search(r"default to this region", prefix, re.I):
        bad.append(
            "RULE A: the active-context prefix tells the agent to 'default to this "
            "region' for routing tools. That overrides the spec's get_directions rule "
            "and forced region = UnitedStatesOfAmerica onto an SFO-to-Civic-Center "
            "route, which the SanFrancisco graph routes in 1435 s."
        )
    if not re.search(r"region\s*=\s*null", prefix, re.I):
        bad.append(
            "RULE A: the active-context prefix never tells the agent to pass "
            "region = null to routing verbs. Without that sentence the active region "
            "reads as the routing default again."
        )
    if not re.search(r"scopes\s+fleet\s+DATA|scopes\s+DATA", prefix, re.I):
        bad.append(
            "RULE A: the prefix does not say the active region scopes DATA rather than "
            "routing. That distinction is the rule - naming the region without it is "
            "what the agent read as a routing default."
        )
    return bad


def rule_b_c_d(sql_raw: str) -> list[str]:
    found = tool_directions_body(strip_line_comments(sql_raw))
    if not found:
        return ["RULE B/C/D: TOOL_DIRECTIONS not found in deploy-agent.sql"]
    line, body = found
    SEEN["B"] = SEEN["C"] = SEEN["D"] = 1
    bad: list[str] = []

    # ---- RULE B ---------------------------------------------------------
    entries = re.findall(r"([A-Za-z_(:]{0,24})R:destinations\[[^\]]+\]\s*(?!:)", body)
    isnv = re.findall(
        r"IS_NULL_VALUE\s*\(\s*[a-z]+\.R:destinations\[[^\]]+\]\s*\)", body, re.I
    )
    if not isnv:
        bad.append(
            f"RULE B: TOOL_DIRECTIONS (line ~{line}) never tests a matrix destination "
            f"ENTRY with IS_NULL_VALUE. A coordinate ORS could not snap at all is "
            f"written as JSON null, snapped_distance is then NULL (which the far-snap "
            f"gate deliberately ignores), and the request is refused as UNROUTABLE_LEG."
        )
    for m in re.finditer(
        r"R:destinations\[[^\]]+\]\s*(?!:)(?:::[A-Z]+\s*)?IS\s+NULL", body, re.I
    ):
        bad.append(
            f"RULE B: TOOL_DIRECTIONS (line ~{line + body.count(chr(10), 0, m.start())}) "
            f"tests a destination entry with a bare `IS NULL`. A VARIANT JSON null is "
            f"not SQL NULL - verified FALSE - so the check runs and cannot convict. Use "
            f"IS_NULL_VALUE."
        )

    # ---- RULE C ---------------------------------------------------------
    unsnapped = re.search(r"IF\s*\(\s*v_unsnapped_count\s+IS\s+NOT\s+NULL", body, re.I)
    leg = re.search(r"IF\s*\(\s*v_unroutable_legs\s+IS\s+NOT\s+NULL", body, re.I)
    if not unsnapped:
        bad.append(
            f"RULE C: TOOL_DIRECTIONS (line ~{line}) has no unsnappable-coordinate "
            f"refusal branch, so an off-graph place is only ever reported as a leg "
            f"failure."
        )
    elif leg and unsnapped.start() > leg.start():
        bad.append(
            f"RULE C: the unsnappable-coordinate branch sits AFTER the unroutable-leg "
            f"branch in TOOL_DIRECTIONS (line ~{line}). An unsnappable coordinate nulls "
            f"every leg it touches, so the leg branch fires first and mis-states the "
            f"cause as 'separated by water'."
        )

    # ---- RULE D ---------------------------------------------------------
    # Count refusal branches that can be reached once a region is resolved, i.e.
    # every OBJECT_CONSTRUCT carrying 'region' AFTER the caller-region lookup.
    anchor = re.search(r"v_region_source\s*=\s*'caller'", body, re.I)
    if not anchor:
        bad.append(
            "RULE D: TOOL_DIRECTIONS never branches on v_region_source = 'caller', so a "
            "forced region is never annotated with the region that does cover the "
            "places and every refusal reads as final."
        )
    else:
        if not re.search(r"COVERING_REGION_FOR_POINTS", body[anchor.start():], re.I):
            bad.append(
                "RULE D: the caller-region branch does not call "
                "COVERING_REGION_FOR_POINTS, so suggested_region can only ever be null."
            )
        tail = body[anchor.start():]
        for m in re.finditer(r"RETURN\s+OBJECT_CONSTRUCT\s*\(", tail):
            depth, i = 0, m.end() - 1
            while i < len(tail):
                if tail[i] == "(":
                    depth += 1
                elif tail[i] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            payload = tail[m.end():i]
            if "'status', 'FAILED'" not in payload:
                continue  # success payload
            # Scoped to refusals that NAME a region. The proc's outermost
            # EXCEPTION WHEN OTHER returns only SQLERRM and never reached region
            # resolution, so a suggested_region there would be a claim about state
            # the handler cannot vouch for. Any branch that reports a region is in
            # scope, which is what makes a deleted flag on a real branch convict.
            if "'region'" not in payload:
                continue
            hit = line + body.count("\n", 0, anchor.start() + m.start())
            for key in ("retry_without_region", "suggested_region", "region_source"):
                if f"'{key}'" not in payload:
                    bad.append(
                        f"RULE D: the refusal at line ~{hit} omits '{key}'. A caller can "
                        f"reach this branch with a forced region, and without the flag "
                        f"the agent is told a recoverable failure is final."
                    )
    return bad


def rule_e() -> list[str]:
    bad: list[str] = []
    if not VERB_TS.exists():
        return [f"RULE E: missing {VERB_TS.relative_to(REPO)}"]
    desc = strip_line_comments(VERB_TS.read_text())
    SEEN["E"] = 1
    if "retry_without_region" not in desc:
        bad.append(
            "RULE E: the get_directions description never names retry_without_region. "
            "It ends by calling all three refusals non-retryable, and the agent obeys "
            "that even when a region it was handed is the only reason for the refusal."
        )
    elif not re.search(r"retry\s+exactly\s+once\s+with\s+region\s+null", desc, re.I):
        bad.append(
            "RULE E: the description names retry_without_region but never states the "
            "action. Naming a field is not an instruction - say to retry exactly once "
            "with region null."
        )
    for spec in SPECS:
        if not spec.exists():
            bad.append(f"RULE E: missing {spec.relative_to(REPO)}")
            continue
        orch = json.loads(spec.read_text())["instructions"]["orchestration"]
        SEEN["E"] = 1
        if "retry_without_region" not in orch:
            bad.append(
                f"RULE E: {spec.name} orchestration still bans re-issuing with a forced "
                f"region and states no exception. Whichever surface keeps the blanket "
                f"ban is the one the agent follows."
            )
        elif not re.search(r"retry\s+exactly\s+once\s+with\s+region\s+null", orch, re.I):
            bad.append(
                f"RULE E: {spec.name} mentions retry_without_region without telling the "
                f"agent to retry once with region null."
            )
    return bad


def main() -> int:
    for path in (TOOLS_SQL, CHAT_ROUTE, VERB_TS):
        if not path.exists():
            print(f"FAILED: missing {path}")
            return 1
    problems: list[str] = []
    problems += rule_a()
    problems += rule_b_c_d(TOOLS_SQL.read_text())
    problems += rule_e()

    missing = [r for r in "ABCDE" if r not in SEEN]
    if missing:
        problems.append(
            "VACUITY: rule(s) " + ", ".join(missing) + " inspected nothing. A rule that "
            "reads no subject reports a pass it did not earn."
        )

    print(f"  scanned {CHAT_ROUTE.name}, {TOOLS_SQL.name}, {VERB_TS.name} and "
          f"{len(SPECS)} agent spec(s)")
    if problems:
        print()
        for p in problems:
            print("  " + p)
        print(f"\nFAILED: {len(problems)} forced-region-refusal violation(s)")
        return 1
    print("\nPASSED: the active region never forces a routing region, an unsnappable "
          "place is refused as off-graph before any leg claim, and a forced-region "
          "refusal tells both the proc and the agent how to recover")
    return 0


if __name__ == "__main__":
    sys.exit(main())
