---
name: labor-overtime
description: See who is going to blow through an overtime threshold while there are still days left to do something about it. Use for: Which Drivers are projected to exceed a weekly hours limit, which rule actually binds them, what will it cost, and which depot is generating it? Covers the Labour and Overtime use case of the Fleet Intelligence accelerator.
---

# Labour and Overtime

**Business question.** Which Drivers are projected to exceed a weekly hours limit, which rule actually binds them, what will it cost, and which depot is generating it?

**Who asks it.** Operations leader, Depot or branch supervisor, HR and labour relations, Finance and workforce planning

## How to answer

1. Use the `query_labor` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_labor cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - headcount and FTE for the current week
   - overtime as a percentage of paid hours (denominator named)
   - avoidable overtime premium, the half-time portion
   - operators projected at risk or in breach
   - driving share of paid hours
   - projected week-end hours per operator
   - which limit binds each operator (FLSA pay vs DOT hours-of-service)
   - rolling 7-day DOT on-duty hours, for commercial motor vehicles only
   - distribution of projected hours across bands, showing concentration
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="labor_overtime", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

A duty period is a maximal run of an Driver's trips with no gap longer than a configured threshold, so a shift crossing midnight stays one shift. Paid hours are the duty SPAN (first trip start to last trip end), because someone waiting between stops is on the clock; driving hours are tracked separately so the difference shows as utilization. Each duty period is intersected with the payroll week or weeks it touches, so a duty period straddling the boundary contributes to both and no hours are lost. Projection for the in-progress week is a linear daily run rate, anchored to the dataset rather than to wall-clock time. The anchor is resolved PER REGION and is TRIMMED: it is the last day whose volume reaches a configured share of that region's median daily volume, because a generated dataset stops mid-day and its final calendar day is a taper rather than a day of work. Untrimmed, the current week was a one-day stub and this view showed only the operators who happened to work in it. A selected date range clamps that anchor, so narrowing the range moves the current week earlier. The compliance layer splits the population on vehicle GVWR: at or under 10,000 lb (4.536 tonnes) the FLSA small-vehicle exception applies so overtime is owed, and DOT hours-of-service and driver-salesperson status are not applicable; above it the FLSA 13(b)(1) motor carrier exemption may mean no overtime is owed and the binding limit becomes the DOT on-duty ceiling. Eligibility uses the LIGHTEST vehicle worked in the week, because the exception covers the whole workweek even when heavier vehicles were also driven. DOT on-duty hours are a rolling 7 consecutive days and are kept separate from payroll hours throughout, since on-duty time includes waiting to be dispatched, inspection and loading.

## Caveats you MUST state

WHAT IS REAL: hours, days worked, trips, distance, driving share and the radius and on-duty computations are all derived from recorded trips. WHAT IS SYNTHESIZED: contracted hours, hourly rate, team and supervisor do NOT exist in the source data and are generated deterministically from the Driver id. So qualify every MONEY figure as indicative and every team structure as illustrative, and do NOT qualify the hours. Overtime cost also rests on a base rate, whereas FLSA requires the regular rate including commissions and nondiscretionary bonuses, so true cost is higher than shown. MODELLING LIMITS: paid time is the duty span, which excludes pre-trip and post-trip work a real clock system would capture, so these figures understate true paid hours. The fleet itself is synthetic, and one consequence is visible here: the generator stops mid-day, so the dataset's final calendar day carries a fraction of normal volume and is EXCLUDED from the as-of anchor. That trim is a demo-data accommodation, not a modelling choice a real deployment would need. The 50-hour tier is a company policy threshold, not a statutory one - only 40 (FLSA weekly) and 60/70 (DOT on-duty) have regulatory force, and daily-overtime states such as California are not modelled. NOT PRESENT: cases per labour hour, the industry-standard DSD productivity denominator, needs a delivered volume feed - stops and km per paid hour are stand-ins and should be described as such. Scheduled-versus-actual variance is deliberately absent rather than shown as zero, because the planned timestamps in this dataset are copies of the actuals. Absence, turnover and vacancy rates need an HR feed. GOVERNANCE: in a real deployment, per-person hours tracking is a decision for the customer, their legal team and where applicable their works council, and in an organised workforce a collective agreement may govern overtime assignment by seniority, so a recommendation about who to send home may not be the employer's to make.

## Questions this skill covers

- who is projected to exceed 60 hours this week?
- which rule binds our highest-hours drivers?
- what is our overtime percentage, and of what denominator?
- what could we actually save on overtime?
- which depot is generating the overtime?
- is anyone close to the DOT on-duty limit?
- are any drivers losing driver-salesperson status?
- is our overtime concentrated or spread across the fleet?

## What the answer is worth

- Intervene before a threshold is crossed rather than discovering it in the payroll run
- Attribute overtime to a shift pattern or depot, so the fix is a rostering change instead of across-the-board coaching
- Separate the pay question from the hours-of-service question, so compliance effort goes where the actual regulatory exposure is
- Protect the workforce from sustained excessive hours, not just the labour budget
