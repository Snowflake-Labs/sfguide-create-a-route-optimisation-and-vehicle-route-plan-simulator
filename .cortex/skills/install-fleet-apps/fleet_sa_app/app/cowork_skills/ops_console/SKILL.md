---
name: ops-console
description: Operator controls for the platform behind the demos: service lifecycle, the active region, and health at a glance. Use for: Is the routing platform healthy, which region is active, and what do I resume before a demo or suspend after one? Covers the Ops Console use case of the Fleet Intelligence accelerator.
---

# Ops Console

**Business question.** Is the routing platform healthy, which region is active, and what do I resume before a demo or suspend after one?

**Who asks it.** Solution Engineer, Platform operator, Snowflake account team

## How to answer

1. No semantic view models this use case: it is computed live in the app. Answer with whatever `run_sql` and the routing tools can retrieve, then hand over the app view with `deep_link` rather than describing a screen you cannot see.
2. Scope the question before aggregating. This deployment holds EVERY loaded region and asset mode at once, so an unfiltered aggregate mixes them. `region` is the key (for example SanFrancisco); `region_label` or `city` is the readable form a person types. Say which slice you used.
3. Lead with these measures rather than inventing your own:
   - live service inventory with per-service status (RUNNING / SUSPENDED) and the compute pool each runs in
   - the active routing region and the active dashboard context (region, asset mode)
   - healthcheck rollup: ORS CORE function count, TOOL_* procedure count, routing gateway status
   - the synapse verb audit trail (recent_verb_attempts): verb, outcome, error code, timestamp
4. This use case is inherently visual in the app. Outside the app you cannot draw its map: give the figures, then call `deep_link(view_id="ops_console", region=...)` and offer the link. Never describe map contents as if you had seen them.

## How the numbers are produced

Actions call the operator verb bundle, which is a separate role-scoped tool surface from the one the consumer agent uses. Every call flows through the audited envelope.

## Caveats you MUST state

Operator-facing, not a customer demo. Resuming a large region loads its road graph and is not instant, so resume well before you need it.

## Questions this skill covers

- which services are running right now?
- resume the routing service for the active region
- suspend everything so we stop accruing cost
- is the platform healthy?
- show me the recent verb calls and any that failed

## What the answer is worth

- A demo that starts warm instead of failing on a cold service
- Idle compute suspended deliberately rather than forgotten
