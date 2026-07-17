# Architecture Tenets - synapse + Solution Accelerator

These are the load-bearing invariants of the agent-first analytics app built on the
**Solution Accelerator (SA)** host + the **synapse** typed/audited tool layer
(the `feature/sa-synapse-app` line of work). They exist so that any future change -
new domain, new dashboard, new tool, new engine - preserves what makes this solution
swappable, role-isolated, auditable, and reproducible.

**Read this before evolving the SA app, the synapse tool bundles, the routing contract,
or the data-contract packs.** When a change would violate a tenet, stop and reconsider
the design - do not work around it. These complement (do not replace) the operational
rules in `AGENTS.md` (commit discipline, tracking tags, geospatial conventions, fix discipline).

Primary code locations referenced below:
- SA host (vendored): `.cortex/skills/install-fleet-apps/fleet_sa_app/ui/` + bundle `.../fleet_sa_app/app/`
- synapse tool bundles: `.cortex/skills/install-fleet-apps/fleet_tools/{user,admin,ops}/` + vendored framework `fleet_tools/vendor/synapse/`
- Routing contract: `.cortex/skills/install-fleet-apps/routing_platform/setup.sql`
- Data-contract packs: `.../fleet_sa_app/app/packs/<domain>/`

---

## 1. Two swappable seams

**Tenet.** The solution has exactly two intentional swap seams: a **routing-engine seam**
(`ROUTING_PLATFORM.CONTRACT.*` typed verbs over pluggable provider adapters) and a
**data seam** (data-contract packs: `logical model → source mapping → generated FLEET_APP.<domain>`).
Consumers bind only to these neutral contracts, never to a named engine or a physical source.

**How to apply.** Need to call routing? Call `ROUTING_PLATFORM.CONTRACT.*` (DIRECTIONS/
ISOCHRONES/OPTIMIZATION/MATRIX/ROUTING_STATUS), which resolves a provider via
`COALESCE(per-call, region default, ors_internal)`. Need to consume data? Read the neutral
`FLEET_APP.<domain>` views produced by a pack's `generate.py`, and source-bind new data only
through `entity-mapping.yaml`. To add an engine, add an adapter in `ROUTING_PLATFORM.PROVIDERS`
+ register it - do not touch the contract signatures.

**Anti-pattern.** A dashboard, view, semantic view, or tool that selects directly from
`OPENROUTESERVICE_APP.CORE.*`, an engine-specific raw function, or a physical synthetic
table (`SYNTHETIC_DATASETS.UNIFIED.*`, domain base tables). That hard-wires the engine/data
and breaks customer-data and engine swappability.

---

## 2. Best-of-both topology, one repo

**Tenet.** SA owns the UI, the Cortex Agent, and distribution; synapse owns the typed,
audited tool layer. The upstream SA and synapse repos are **read-only references** -
all shipped code is **vendored into this work repo**.

**How to apply.** Make every change inside `.cortex/skills/install-fleet-apps/`
(`fleet_sa_app/` for host+bundle, `fleet_tools/` for tools, `routing_platform/` for the
contract). The synapse framework is vendored at `fleet_tools/vendor/synapse/` (its built
`dist/` ships; `node_modules` is gitignored) - bundles depend on it via `file:../vendor/synapse`,
never an absolute path.

**Anti-pattern.** Editing or committing in `/Users/obielov/Documents/GitHub/solution-accelerator`
or `/Users/obielov/Documents/GitHub/synapse`, or reintroducing an absolute-path / external
dependency on either. That makes the work repo non-self-contained and non-forkable (tier-C).

---

## 3. Role-scoped bundles are the isolation mechanism

**Tenet.** User, Ops, and Admin are separate synapse apps, each materializing its **own
MCP server** (`ROUTING_MCP` for user, `FLEET_OPS_MCP` for ops, `FLEET_ADMIN_MCP` for admin).
The consumer-facing agent (`FLEET_AGENT`) attaches the **User MCP only**. Ops/Admin tools
never appear on the consumer agent surface.

**How to apply.** Add a user-facing verb to `fleet_tools/user/`; add a control/lifecycle verb
to `fleet_tools/ops/` or `fleet_tools/admin/`. Each verb declares `roles:[...]` matching its
bundle. Keep `FLEET_OPS_AGENT`/admin tooling off the consumer agent's `mcp_servers`.

**Anti-pattern.** Adding an ops/admin verb to the user bundle, or attaching `FLEET_OPS_MCP`/
`FLEET_ADMIN_MCP` to `FLEET_AGENT` "for convenience." The firm isolation guarantee is that the
consumer agent has no privileged tools - do not erode it.

---

## 4. Config-driven, not code-edited

**Tenet.** Re-pointing the app to a new domain, schema, tool set, or region context must be
possible with **zero TypeScript edits**. `app-config.json` (read server-side via
`server-config.ts`, client-side via `/api/app-config`) is the single config surface. Existing
fleet literals remain only as **fallbacks** so the live fleet deploy stays behavior-identical.

**How to apply.** New domain/schema/verb wiring goes in `app/app-config.json`
(`domainPack`, `tools{schema,verbs,mapTools}`, `ops{schema,verbs}`, `region{database,schemas}`)
and `app/app-views.json`. The API routes (`/api/tool`, `/api/ops`, `/api/region`) already read
their allowlists from `getServerConfig()`. Re-point live by `snow stage copy` of the JSON to
`FLEET_APP_STAGE/config` + suspend/resume - no image rebuild.

**Anti-pattern.** Hardcoding a schema name, verb list, or region column in a `.tsx`/route file,
or branching app logic on `domainPack === 'fleet'` outside the designated loader. That defeats
config-driven domain swap and forces a rebuild for every tenant.

---

## 5. Self-building, contract-bound data

**Tenet.** A pack's analytic layer is **rebuilt from raw sources** via derived primitives
(generator `derived`/`sql` escape hatches), not faked as a thin facade, and must remain
**bit-for-bit verifiable** against the source-of-truth it mirrors. All consumers read the
neutral `FLEET_APP.<domain>` contract.

**How to apply.** Author `data-model.yaml` (logical entities) + `entity-mapping.yaml`
(source binding + transforms) and regenerate with the pack's `generate.py` / `install.py`;
verify counts/sums against the legacy physical objects before cutover. Swapping a customer's
data = a new `entity-mapping.<customer>.yaml`, regenerate, done - dashboards and SVs unchanged.

**Anti-pattern.** Editing generated views by hand, baking aggregates that can't be reproduced
from raw sources, or pointing a semantic view's base table at a physical table instead of the
`FLEET_APP` contract view. Hand edits drift and are silently overwritten on the next regenerate.

### 5a. Generation is data/config-driven; physical naming is absorbed by the contract

**Generation seam.** The synthetic data *generator* obeys the same config-driven rule as consumers.
Built-in generation profiles are persisted as data in `FLEET_INTELLIGENCE.CORE.GENERATION_PROFILE_CATALOG`
(seeded at control-app/admin boot from `studio/profiles.ts` `PROFILE_TEMPLATES`; the `/api/studio/templates`
endpoint reads the catalog with a TS fallback). The generation *engine* never branches on vehicle type:
per-mode behavior is driven by declarative profile fields - `base_speed_kmh`, `home_location_types`,
`category_map`, `generates_freight` - and by the **presence** of `battery` / `breaks` / `overnight`
(battery drain, HOS breaks, overnight rest). **Adding a new mode (vessel/aircraft) = inserting a profile
row (or saving a preset), with zero generator code edits.** Mode-specific asset dims + evaluation
thresholds come from the sibling `DIM_VEHICLE_PROFILE` / `DIM_VEHICLE_DWELL_SLA` catalog (see Tenet 1).

**Anti-pattern.** Re-introducing `vt === 'hgv'` / `config.mode === 'urban_ebike'` branches in
`server/studio/engine/*`, or hardcoding a generation knob in TypeScript instead of a profile field.

**Accepted physical-schema decisions (intentionally NOT changed).** The few mode-specific physical
column names - `DRIVER_ID` (FACT_TRIPS, DIM_TRIP_SCHEDULE), `DRIVER_PROFILE` (DIM_FLEET),
`IS_HOS_VIOLATION` (telemetry) - are deliberately left as-is and neutralized by the `FLEET_APP` contract
(`DRIVER_ID -> OPERATOR_ID`, canonical `FLEET_APP.CORE` renames). Renaming them at the physical layer is
churn across CORE + FLEET_OPS + every `replaces:` binding for zero architectural gain - the contract seam
exists precisely to absorb this. Likewise `DIM_POIS` is **REGION-scoped only** (no `VEHICLE_TYPE`): a POI
set is shared across modes within a region, identified by `(REGION, JOB_ID)`.


---

## 6. Hybrid provisioning - heavy substrate stays in the control app

**Tenet.** Compute-heavy, slow-to-provision substrate (ORS/VROOM graphs, compute pools,
the image build/push pipeline, region lifecycle) lives in the `OPENROUTESERVICE_APP`
control app. The SA + synapse layer is the **thin typed/audited surface** on top.

**How to apply.** Routing graph sizing, region provisioning, PBF download, and gateway/service
lifecycle changes go in the control-app skills (`install-fleet-apps`, `routing-customization`)
and follow the control-app image-deploy rules in `AGENTS.md`. The SA layer calls into the result
through `ROUTING_PLATFORM.CONTRACT.*`; it does not provision graphs.

**Anti-pattern.** Building graph-management, compute-pool sizing, or image provisioning into the
SA host or a synapse verb. That couples the thin layer to heavy infra and breaks the clean split
(and the per-stage `AUTO_SUSPEND_SECS` contract).

---

## 7. Audited envelope - no unaudited tool calls

**Tenet.** Every tool/verb invocation flows through the synapse envelope, which records a
`VERB_ATTEMPT` audit row (actor, role, args, outcome, error, result hash) and enforces
**idempotency** via the trailing idempotency key.

**How to apply.** Expose new capabilities as synapse verbs (`defineProc` with `roles:[...]`)
so they inherit the envelope automatically. SA server routes that call verbs
(`/api/tool`, `/api/ops`, `/api/region`, `/api/fx`) pass the trailing NULL/idempotency argument
and keep an allowlist + arity check.

**Anti-pattern.** Calling an underlying `TOOL_*` proc, contract function, or arbitrary SQL
directly from an API route to "skip the wrapper," or adding a verb path that bypasses the
envelope. That loses the audit trail and idempotency guarantees.

---

## 8. New-deployment-first (SA + synapse analog of Fix Discipline)

**Tenet.** Every fix or feature lands first in the **source artifacts a fresh install consumes**
- pack YAML/`generate.py`, `app-config.json`/`app-views.json` on the deploy stage, synapse bundle
source, `role_binding.sql`, `routing_platform/setup.sql`, `native-app/setup.sql`. A live hotfix
(ALTER SERVICE, ad-hoc `snow sql`, stage edit) is always **secondary** and only valid once the
same change exists in repo source.

**How to apply.** Before calling a change done, trace the clean path: does
`scripts/deploy_fleet_sa_app.sh` (+ `FLEET_SA_APP_TAG` bump) and the pack `install.py` /
`role_binding.sql` reproduce it from scratch with no manual step? If not, fix the source first,
then optionally apply the live hotfix.

**Anti-pattern.** Fixing only the running SPCS service, agent spec, or config stage and leaving
the repo source stale - the next clean deploy regresses. (This mirrors the existing
"Fix Discipline (new-deployment-first)" rule in `AGENTS.md`, extended to the SA/synapse stack.)

---

## 9. Live routing, not precomputed

**Tenet.** Analytics that depend on drive-time reachability, catchments, travel-time matrices,
or optimization MUST call the live routing functions (`ROUTING_PLATFORM.CONTRACT.*`, i.e.
`OPENROUTESERVICE_APP.CORE.ISOCHRONES` / `MATRIX` / `MATRIX_TABULAR` / `OPTIMIZATION`) **at
interaction time** - never read materialized or precomputed ORS output. The routing engine is
the thing being demoed; caching its output hides it.

**How to apply.** Resolve the interactive selection into literal, scalar-subquery, or bind args
(ORS SQL functions do not evaluate against correlated per-row columns; `ISOCHRONES` range is in
MINUTES). Guard every call with `COALESCE(:selection, <default>)` so nothing is invoked with a
NULL arg. Every ORS call requires the region's service RESUMED (a suspended service returns an
embedded error, not a throw). Precomputed **non-ORS** reference data (Overture POI subsets,
address/household density, synthetic commercials) is fine - the rule is specifically about not
caching ORS engine output.

**Anti-pattern.** Caching isochrone polygons, travel-time matrices, or optimization results into
a table and reading them back in a view. It hides the routing engine, goes stale when the
estate/region/params change, and diverges from what a customer would actually build.

---

## 10. Agent-aware by construction

**Tenet.** Every consumer-facing view - new or changed - must be answerable by the left-panel
Cortex agent. The on-screen numbers, rankings, and the map's meaning must reach the agent through
the panel-context channels; a view that renders data the agent cannot see or reason about is
incomplete. The three grounding channels are injected in
`fleet_sa_app/ui/src/app/api/chat/route.ts`: **Channel A** - `viewState` flattened to `key=value`
(publish bounded, pre-joined STRING memos under the reserved `__memo_<area>` key); **Channel B** -
`mapState` (layer counts, blank-layer diagnosis, bbox, legend, and one clicked `selectedFeature`
that only populates when the layer has `clickEmits`); **Channel C** - `agentKnowledge` in
`app-views.json` (`preferredTool` + `keyMetrics` + `exampleQuestions` + `gotchas`).

**How to apply.** When adding or altering a view: (1) publish its headline metrics as a bounded,
pre-joined STRING under `__memo_<area>` in `viewState` (a nested object serializes to
`[object Object]`) - `MetricCardsArea` does this generically; custom/table views publish via
`updateViewState` / `onStateChange`. (2) Add or refresh an `agentKnowledge` block naming the
verified tool-to-semantic-view pairing; if no semantic view models the data (e.g. safety events,
work-items), OMIT `preferredTool` and say so in `gotchas` rather than implying a tool can answer.
(3) Add `clickEmits` to the primary point/choropleth layer so "tell me about the one I clicked"
works. (4) Sanity-check by asking the agent a representative question about the on-screen result.
Keep every memo bounded (top-N rows, key columns, capped length).

**Anti-pattern.** Shipping a view whose KPIs, table rows, or chart values exist only client-side
with no channel; an `agentKnowledge.preferredTool` pointed at a semantic view that does not model
the data, so the agent invents numbers or misroutes; or dumping raw rows/objects into `viewState`
(which breaks the Channel A `key=value` flattening).
