#!/usr/bin/env python3
"""Update the labor_overtime useCase and agentKnowledge for the compliance layer.

Separate from restructure_labor_view.py so the narrative change is reviewable
apart from the layout change. Same slice-replacement technique: rewrite only this
view's JSON block so the rest of the 6k-line file keeps its formatting.

The point of this edit is HONESTY about three classes of thing:

1. What the compliance layer now does, and on what regulatory authority. The
   thresholds are not invented - they are FLSA 13(b)(1), 49 CFR 395.2 and 395.3.

2. What is DERIVED vs SYNTHESIZED. Hours come from real recorded trips; pay rate,
   team and supervisor do not exist in the source data at all. Money figures must
   be qualified in the room and hours must not, and the distinction has to be
   stated rather than left for someone to discover.

3. What is genuinely MISSING and is an integration ask, not a gap we can paper
   over with a proxy. Cases per labour hour is the verified DSD productivity
   denominator and we have no volume unit; scheduled-vs-actual variance is
   standard and expected but the planned timestamps are copies of actuals so the
   variance is structurally zero, which is why that panel is absent rather than
   showing a fake zero.
"""
import json
import sys
from pathlib import Path

APP_VIEWS = Path(__file__).resolve().parents[1] / "fleet_sa_app" / "app" / "app-views.json"
VIEW_ID = "labor_overtime"

TALK_TRACK = [
    "Start at the KPI row: headcount against FTE, overtime as a percentage of paid hours, and the AVOIDABLE overtime premium. Note the premium is the half-time portion, not the loaded cost - the straight-time hours would be paid to somebody regardless.",
    "Make the timing point: everything here is a PROJECTION from hours worked so far, not a month-end report. Mid-week every {{labels.operator}} is still under the limit, so hours-to-date can never surface anyone in time to act.",
    "Open the at-risk table. It is ordered by projected hours so it reads as a call list, and it names the supervisor to call.",
    "Point at the binding-limit column. This is the differentiator: the dashboard says WHICH rule applies to each person, not just that they are working a lot. For light vehicles that is FLSA overtime; for a commercial motor vehicle the FLSA motor carrier exemption may mean no overtime is owed at all and the real ceiling is the DOT 60-hour on-duty limit.",
    "Move to the distribution. Concentration is the story: twenty {{labels.operator_plural}} at 55 hours is a different problem from two hundred at 42, and the average is identical. This is why the view does not lead with a mean.",
    "Then the compliance panel, which counts {{labels.operator_plural}} by binding limit, and the team chart, which localises the overtime. If it concentrates in one shift pattern or depot, the fix is rostering, not coaching individuals.",
    "Close on the platform point: no timekeeping integration was needed. Hours were reconstructed from operational data already in Snowflake, and an alert can fire on this same projection before a threshold is crossed.",
]

SNOWFLAKE_CAPABILITIES = [
    "Paid time reconstructed from trip records with window-function sessionization, so the workflow demonstrates without a timekeeping feed",
    "The PERIOD data type with PERIOD_INTERSECT to split a duty period straddling a payroll week boundary, so weekly hours are exact rather than clamped",
    "A compliance layer that resolves which regulatory regime binds each person per week, from vehicle GVWR, a rolling 7-day on-duty window, and driving-share and radius tests computed from the telematics",
    "Semantic view (SV_LABOR) so the agent answers overtime questions in plain language without new SQL",
    "Snowflake ALERT plus a notification integration to warn a supervisor before a threshold is crossed, on the same projection shown here",
    "Masking and row access policies available on the same tables, which matters more for labour data than for fleet telemetry",
]

DATA_REQUIRED = [
    "Trip or job records attributed to a person, with start and end timestamps",
    "Vehicle GVWR, which determines FLSA overtime eligibility per workweek under the motor carrier exemption and its small-vehicle exception",
    "A timekeeping or payroll feed for true clock hours and the FLSA regular rate (which includes commissions and nondiscretionary bonuses, so it exceeds base pay for a commissioned driver-salesperson)",
    "The overtime thresholds, payroll week start day and any daily-overtime rules for the jurisdiction; the employer chooses the workweek and may set different ones per employee group",
    "Delivered volume in a normalised unit (a standard physical case, in beverage DSD) to make cases per labour hour available - the industry-standard productivity denominator",
    "Team or depot structure and supervisor assignment, so an alert reaches a human",
    "Absence, separations and open requisitions, to show whether chronic overtime is a scheduling problem or an understaffing one",
]

VALUE_DRIVERS = [
    "Intervene before a threshold is crossed rather than discovering it in the payroll run",
    "Attribute overtime to a shift pattern or depot, so the fix is a rostering change instead of across-the-board coaching",
    "Separate the pay question from the hours-of-service question, so compliance effort goes where the actual regulatory exposure is",
    "Protect the workforce from sustained excessive hours, not just the labour budget",
]

METHOD = (
    "A duty period is a maximal run of an {{labels.operator}}'s trips with no gap longer than a configured "
    "threshold, so a shift crossing midnight stays one shift. Paid hours are the duty SPAN (first trip start "
    "to last trip end), because someone waiting between stops is on the clock; driving hours are tracked "
    "separately so the difference shows as utilization. Each duty period is intersected with the payroll week "
    "or weeks it touches, so a duty period straddling the boundary contributes to both and no hours are lost. "
    "Projection for the in-progress week is a linear daily run rate, anchored to the latest activity in the "
    "dataset rather than to wall-clock time. "
    "The compliance layer splits the population on vehicle GVWR: at or under 10,000 lb (4.536 tonnes) the FLSA "
    "small-vehicle exception applies so overtime is owed, and DOT hours-of-service and driver-salesperson "
    "status are not applicable; above it the FLSA 13(b)(1) motor carrier exemption may mean no overtime is "
    "owed and the binding limit becomes the DOT on-duty ceiling. Eligibility uses the LIGHTEST vehicle worked "
    "in the week, because the exception covers the whole workweek even when heavier vehicles were also driven. "
    "DOT on-duty hours are a rolling 7 consecutive days and are kept separate from payroll hours throughout, "
    "since on-duty time includes waiting to be dispatched, inspection and loading."
)

CAVEATS = (
    "WHAT IS REAL: hours, days worked, trips, distance, driving share and the radius and on-duty computations "
    "are all derived from recorded trips. "
    "WHAT IS SYNTHESIZED: contracted hours, hourly rate, team and supervisor do NOT exist in the source data "
    "and are generated deterministically from the {{labels.operator}} id. So qualify every MONEY figure as "
    "indicative and every team structure as illustrative, and do NOT qualify the hours. Overtime cost also "
    "rests on a base rate, whereas FLSA requires the regular rate including commissions and nondiscretionary "
    "bonuses, so true cost is higher than shown. "
    "MODELLING LIMITS: paid time is the duty span, which excludes pre-trip and post-trip work a real clock "
    "system would capture, so these figures understate true paid hours. The fleet itself is synthetic. "
    "The 50-hour tier is a company policy threshold, not a statutory one - only 40 (FLSA weekly) and 60/70 "
    "(DOT on-duty) have regulatory force, and daily-overtime states such as California are not modelled. "
    "NOT PRESENT: cases per labour hour, the industry-standard DSD productivity denominator, needs a delivered "
    "volume feed - stops and km per paid hour are stand-ins and should be described as such. Scheduled-versus-"
    "actual variance is deliberately absent rather than shown as zero, because the planned timestamps in this "
    "dataset are copies of the actuals. Absence, turnover and vacancy rates need an HR feed. "
    "GOVERNANCE: in a real deployment, per-person hours tracking is a decision for the customer, their legal "
    "team and where applicable their works council, and in an organised workforce a collective agreement may "
    "govern overtime assignment by seniority, so a recommendation about who to send home may not be the "
    "employer's to make."
)

GOTCHAS = (
    "query_labor (SV_LABOR) models this whole view. Use projected_week_hours, NOT hours_to_date, for any "
    "'will exceed' question - hours_to_date is mid-week and always under the limit. Filter is_current_week = "
    "TRUE for the projectable week; a completed week projects to its actual. A week with is_partial_start = "
    "TRUE is cut off at its BEGINNING by the dataset boundary, so its low totals are an artifact and must "
    "never be presented as a drop in hours. "
    "Two cost columns exist and they differ by design: est_ot_premium is the AVOIDABLE half-time portion and "
    "is the right answer to 'what could we save'; est_ot_cost is the fully loaded cost of those hours. Quoting "
    "the loaded figure as the saving overstates it threefold. "
    "Overtime percentage has a named denominator - ot_pct_of_paid and ot_pct_of_straight are different numbers "
    "and are not interchangeable, so say which one you used. "
    "Thresholds are DATA (ot_threshold_1/2/3, dot_onduty_limit), not a fixed 40/50/60; read them. Only 40 and "
    "60/70 have regulatory force and the 50 is a policy tier. "
    "binding_constraint says which rule applies. dot_onduty_7d_hours and driver_salesperson_ok are NULL for "
    "light vehicles because they are NOT APPLICABLE there, not because data is missing - DOT hours-of-service "
    "and driver-salesperson status are defined for commercial motor vehicles. Never merge dot_onduty_7d_hours "
    "into a paid-hours total: on-duty time is a different clock that includes waiting, inspection and loading. "
    "Hours are derived from real trips; pay rates, team and supervisor are synthesized, so qualify money and "
    "not hours. Never mix the duty grain into weekly totals: a duty period straddling a week boundary counts "
    "in both weeks in the weekly fact but once in the duty fact."
)


def replace_block(raw: str, view_id: str, view: dict) -> str:
    start_marker = f'  "{view_id}": {{'
    start = raw.index(start_marker)
    rest = raw[start + len(start_marker):]
    depth, i = 1, 0
    while depth > 0:
        ch = rest[i]
        if ch == '"':
            i += 1
            while rest[i] != '"':
                i += 2 if rest[i] == "\\" else 1
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    end = start + len(start_marker) + i
    block = json.dumps({view_id: view}, indent=2, ensure_ascii=False)
    block = "\n".join(block.split("\n")[1:-1])
    return raw[:start] + block + raw[end:]


def main() -> int:
    raw = APP_VIEWS.read_text()
    doc = json.loads(raw)
    if VIEW_ID not in doc:
        print(f"ERROR: {VIEW_ID} not found", file=sys.stderr)
        return 1

    view = doc[VIEW_ID]
    uc = view["useCase"]
    uc["talkTrack"] = TALK_TRACK
    uc["snowflakeCapabilities"] = SNOWFLAKE_CAPABILITIES
    uc["dataRequired"] = DATA_REQUIRED
    uc["valueDrivers"] = VALUE_DRIVERS
    uc["method"] = METHOD
    uc["caveats"] = CAVEATS
    uc["businessQuestion"] = (
        "Which {{labels.operator_plural}} are projected to exceed a weekly hours limit, "
        "which rule actually binds them, what will it cost, and which depot is generating it?"
    )
    view["agentKnowledge"]["gotchas"] = GOTCHAS
    view["agentKnowledge"]["keyMetrics"] = [
        "headcount and FTE for the current week",
        "overtime as a percentage of paid hours (denominator named)",
        "avoidable overtime premium, the half-time portion",
        "operators projected at risk or in breach",
        "driving share of paid hours",
        "projected week-end hours per operator",
        "which limit binds each operator (FLSA pay vs DOT hours-of-service)",
        "rolling 7-day DOT on-duty hours, for commercial motor vehicles only",
        "distribution of projected hours across bands, showing concentration",
    ]
    view["agentKnowledge"]["exampleQuestions"] = [
        "who is projected to exceed 60 hours this week?",
        "which rule binds our highest-hours drivers?",
        "what is our overtime percentage, and of what denominator?",
        "what could we actually save on overtime?",
        "which depot is generating the overtime?",
        "is anyone close to the DOT on-duty limit?",
        "are any drivers losing driver-salesperson status?",
        "is our overtime concentrated or spread across the fleet?",
    ]

    updated = replace_block(raw, VIEW_ID, view)

    parsed = json.loads(updated)
    v = parsed[VIEW_ID]
    if len(parsed) != len(doc):
        print("ERROR: view count changed", file=sys.stderr)
        return 1
    for required in ("useCase", "agentKnowledge", "layout", "areas"):
        if required not in v:
            print(f"ERROR: lost {required}", file=sys.stderr)
            return 1
    if len(v["areas"]) != len(doc[VIEW_ID]["areas"]):
        print("ERROR: areas changed", file=sys.stderr)
        return 1
    for dash in ("\u2013", "\u2014"):
        if dash in json.dumps(v, ensure_ascii=False):
            print(f"ERROR: unicode dash {dash!r}", file=sys.stderr)
            return 1

    APP_VIEWS.write_text(updated)
    print(f"updated {VIEW_ID} useCase + agentKnowledge")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
