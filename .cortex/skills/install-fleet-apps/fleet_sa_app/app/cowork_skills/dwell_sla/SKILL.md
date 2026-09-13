---
name: dwell-sla
description: The breach queue: every dwell session that went over its SLA, by severity, with the site on a map. Use for: Which dwell breaches happened, how bad were they, and where should we intervene first? Covers the SLA Alerts use case of the Fleet Intelligence accelerator.
---

# SLA Alerts

**Business question.** Which dwell breaches happened, how bad were they, and where should we intervene first?

**Who asks it.** Operations controller, Carrier performance manager, Site manager, Customer service

## How to answer

1. Use the `query_dwell` Cortex Analyst tool. It is the governed path for this question - do NOT reach for `run_sql` unless query_dwell cannot express what was asked.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - total SLA alerts
   - critical vs warning breaches
   - average minutes over the threshold
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="dwell_sla", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

A session breaches when its duration exceeds the configured SLA threshold, and severity bands split critical from warning by how far over it went. Sessions at or under the threshold are compliant and never enter this queue.

## Caveats you MUST state

Synthetic telemetry. Because sessions are sessionized from pings, a stop shorter than the SLA threshold cannot be a breach, so this is not a list of every long wait a driver felt.

## Questions this skill covers

- Which facilities breached SLA the most?
- How many critical dwell alerts this week?

## What the answer is worth

- Escalate while the Vehicle is still on site, instead of reporting it next month
- Quantify the minutes lost per site for a commercial claim
- Prioritise remediation by severity rather than by complaint volume
