# Transform-primitive catalog

The data-contract generator (`generate.py`) already gives every pack two primitive
forms via `derived` entities:

- **rollup primitive** - `group_by` + per-column `expr` (declarative aggregate)
- **sql primitive** - a `sql:` body over sibling `{schema}.VW_*` objects (windows,
  sessionization, joins, H3, multi-step DAG)

This file is the *catalog* of recurring transform shapes seen across the fleet packs,
plus the rule for when a shape graduates into shared, parameterized machinery.

## Extraction threshold (avoid premature abstraction)

Promote a shape to a shared, parameterized primitive **only when all three hold**:
1. it appears in **>= 3 packs**, and
2. the callers share the **same output columns / semantics** (not just a similar shape), and
3. parameterizing it does **not** require more config than writing the `sql:` inline.

Until then, keep the logic inline in each pack's `data-model.yaml`. Three similar
`derived` blocks are cheaper to read and change than one over-parameterized template.

## Observed shapes (current state)

| Shape | Packs | Templatize now? |
|-------|-------|-----------------|
| CONFIG-filtered leaf projection (`WHERE col = (SELECT col FROM ...CONFIG)`) | dwell, taxi, food_delivery, marketplace, route_optimization, backload (~6) | Boilerplate, not compute - it lives in the swappable `entity-mapping` layer by design. A future generator convenience (a `config_filter:` shorthand on a mapping leaf) is the most justified extraction, but it is sugar, not a primitive. |
| daily-trend rollup (`DATE_TRUNC('day',...)` + counts/sums) | dwell (DAILY_TRENDS), route_deviation (DAILY_DEVIATION_TRENDS) | No - 2 callers, divergent columns. |
| per-entity summary rollup (group by id + counts/sums) | dwell (DRIVER_DWELL_SUMMARY), route_deviation (DRIVER_DEVIATION_SUMMARY) | No - 2 callers, divergent columns. |
| H3 spatial rollup | dwell (H3_CONGESTION) | No - 1 caller. |
| active-snapshot filter (join to `IS_ACTIVE` snapshot) | a retired vertical pack (x3) | No - single pack; already trivially expressed. |
| ANY_VALUE de-dup of a source key | backload, taxi (dedup_pois/fleet) | No - inline CTE, caller-specific keys. |

## Conclusion

No shape currently clears the threshold, so **no shared template code is added** - this
is the lazy/correct outcome. The single extraction worth revisiting first is the
`config_filter:` mapping shorthand (6 callers, identical shape). Revisit this catalog
when a new domain pushes any row to >= 3 same-shape callers.
