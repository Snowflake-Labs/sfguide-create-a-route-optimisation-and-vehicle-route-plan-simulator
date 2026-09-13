---
name: safety-risk-scorecard
description: Operational risk on one screen: event volume by severity, the behaviour mix behind it, and where the hot spots are. Use for: Where is our risk concentrated, and what would we fix first to reduce claims? Covers the Safety / Risk Scorecard use case of the Fleet Intelligence accelerator.
---

# Safety / Risk Scorecard

**Business question.** Where is our risk concentrated, and what would we fix first to reduce claims?

**Who asks it.** Safety manager, Risk and insurance, Compliance officer, Operations director

## How to answer

1. No semantic view models this use case: it is computed live in the app. Answer with whatever `run_sql` and the routing tools can retrieve, then hand over the app view with `deep_link` rather than describing a screen you cannot see.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - total safety / risk events
   - high, medium, and low severity counts
   - event types (speeding, harsh braking, and similar)
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="safety_risk_scorecard", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Events carry a severity and a type and are aggregated by both. The KPI tiles double as the filter, so the queue, chart and map always reflect the selected severity.

## Caveats you MUST state

Synthetic events, and they are not modelled in any semantic view. The assistant therefore answers from the on-screen values rather than recomputing them, and will not invent per-operator trends or event types.

## Questions this skill covers

- How many high-severity events are there?
- How do high, medium, and low counts compare?
- What severity filter is active?

## What the answer is worth

- Reduce claim frequency by targeting the few behaviours and locations that drive it
- Evidence for a premium negotiation
- Separate driver-behaviour risk from road and site risk, so the fix matches the cause
