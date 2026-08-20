# live_asset_operations - Live Entity Operations

## Summary

**Purpose:** Real-time fleet overview showing where every entity (vehicle/asset) is right now - live GPS positions, motion status, and fleet health KPIs. Merges Fleet Status, Asset Map, and Live Operations views.

**Data entities:** Positions (F_FACT_POSITION_SCOPED), Journeys (F_FACT_JOURNEY_SCOPED), Events (F_FACT_EVENT_SCOPED), Work Items (F_FACT_WORK_ITEM_SCOPED), Asset Attributes (F_VW_ASSET_ATTRIBUTES_SCOPED).

**Map layers (app-views.json:168-354):**
| Layer ID | Type | Shows |
|---|---|---|
| `empty_legs` | path | Empty/deadhead journey paths for selected entity (line 171) |
| `breadcrumb_history` | path | Earlier laden trip paths for selected entity (line 202) |
| `breadcrumb_latest` | path | Latest laden trip path for selected entity (line 234) |
| `positions` | scatterplot | Latest GPS position per entity, colored by motion state (line 266) |

**Key metrics (MetricCards, lines 34-79):** Active entities, Movement Utilization %, Empty Miles %, Moving Pings, Idle/Dwell Pings, Avg Speed.

**Filters/selections:** `selected_entity` emitted by ClickableTable (line 98-100). Date range from context.

**agentKnowledge (lines 6-18):** YES.
- `preferredTool`: `query_fleet_ops`
- `keyMetrics`: active entities, movement utilization %, empty miles %, average speed
- `exampleQuestions`: "How many entities are moving right now?", "What is our empty miles percentage?"
- `gotchas`: "Positions are GPS pings; utilization is the share of pings in a MOVING state, not a duty-cycle measure."

**DetailPanel (lines 358-598):** Triggered by `selected_entity`. Shows status, speed, heading, GPS quality, ping counts, last journey info. Includes related tables: Recent Journeys, Safety & Compliance Events, Planned Work, Asset Profile.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|---|---|---|---|---|---|
| 1 | How many vehicles are active right now? | Counting | Partial | agentKnowledge.keyMetrics names "active entities" and preferredTool `query_fleet_ops` can query it. But the on-screen KPI number is NOT in viewState or mapState - agent must make a tool call and may return a slightly different number than displayed. | Add `kpi_summary` viewState memo field (e.g. "active_entities=80, utilization_pct=72, empty_miles_pct=14, avg_speed=38.2") computed client-side from the MetricCards data response. | High |
| 2 | What percentage of the fleet is moving vs idle? | Counting | Partial | Same as #1 - preferredTool can answer but on-screen values not directly injected. The KPI shows Moving Pings and Idle Pings but those numbers don't reach the agent. | Same kpi_summary memo fix as #1. | High |
| 3 | What is our empty miles percentage? | Counting | Partial | agentKnowledge.exampleQuestions lists this exact question; preferredTool can query. But on-screen value not in viewState. | kpi_summary memo. | High |
| 4 | Which entity is selected? | Map-state | Yes | viewState.`selected_entity` (Channel A, line 98-100). | N/A | - |
| 5 | What is the status of the selected vehicle? | Per-entity detail | Partial | viewState.`selected_entity` tells WHICH entity. DetailPanel data (lines 358-432) computes status, but the panel content is NOT serialized to viewState or mapState. Agent must query `query_fleet_ops` for the entity. | Add selectedFeature.attrs on the `positions` layer via `clickEmits` config so clicking a dot populates mapState.selectedFeature with entity_id + state + speed. | Med |
| 6 | How many vehicles are on the map? | Counting | Yes | mapState.layers[positions].featureCount (Channel B, route.ts:69). | N/A | - |
| 7 | What layers are currently showing? | Map-state | Yes | mapState.layers array (Channel B, route.ts:68-74). | N/A | - |
| 8 | Why is the map blank / why are there no trip lines? | Map-state | Yes | mapState.emptyLayers (Channel B, route.ts:76) will list blank layers. The agent's instructions (route.ts:72-73,90) tell it to diagnose gated/blank layers. | N/A | - |
| 9 | Where is vehicle X right now? | Spatial/on-map | Partial | If entity X is clicked (selected_entity=X) AND the map has that point, mapState.bbox gives viewport. But the agent cannot read individual point coordinates from the positions layer. preferredTool `query_fleet_ops` can answer with a tool call returning lat/lon. | Implement `clickEmits` on positions layer to populate selectedFeature.attrs with lng/lat/state. | Med |
| 10 | What is the fastest vehicle? | Ranking | Partial | Table data (entities table, lines 82-100) ranks by pings not speed. preferredTool `query_fleet_ops` can answer. Not directly on screen. | agentKnowledge.gotchas could note "entity table sorts by ping count; use query_fleet_ops for speed ranking". Or add a precomputed `top_entity_by_speed` memo. | Low |
| 11 | How many journeys did the selected entity complete? | Per-entity detail | Partial | DetailPanel has "Recent Journeys" related table (lines 452-485) but that data is not in viewState. preferredTool can query. | Could add a `selected_entity_journey_count` memo in viewState from the detail query. | Med |
| 12 | What is the selected entity's last journey distance? | Per-entity detail | Partial | DetailPanel computes `last_journey_km` (line 361) but not in viewState. preferredTool needed. | selectedFeature.attrs or a viewState memo `last_journey_km`. | Med |
| 13 | Are there any safety events for the selected vehicle? | Per-entity detail | Partial | DetailPanel "Safety & Compliance Events" table (lines 487-516) shows them, not in viewState. preferredTool `query_fleet_ops` can answer. | A `selected_entity_event_count` viewState memo or agentKnowledge hint. | Med |
| 14 | What area/region is shown on the map? | Spatial/on-map | Yes | mapState.bbox (Channel B, route.ts:77-79) plus activeContext.region (Channel route.ts:124). | N/A | - |
| 15 | What is the average speed across the fleet? | Counting | Partial | agentKnowledge.keyMetrics includes "average speed". preferredTool can query. On-screen value not in viewState. | kpi_summary memo. | High |
| 16 | Show me the breakdown of moving vs idle vs dwell states | Comparison | Partial | Map legend (Channel B, route.ts:89) lists "Moving", "Idle", "Dwell / Stopped" labels but not counts per state. preferredTool can query state breakdown. | Add a `state_breakdown` viewState memo (e.g. "MOVING=45, IDLE=20, DWELL=15") from positions layer data. | Med |
| 17 | Does the selected entity have any empty legs? | Per-entity detail | Partial | mapState.layers[empty_legs].featureCount > 0 tells the agent IF empty legs are rendered. But only when entity is selected and the layer has data. | featureCount of `empty_legs` layer answers yes/no. For details, preferredTool needed. Partial is acceptable. | Low |
| 18 | What legend colors mean what? | Map-state | Yes | mapState.legend (Channel B, route.ts:89) carries label strings from config (lines 106-166): "Moving", "Idle", "Dwell / Stopped", "Latest trip (laden)", "Earlier trips (laden)", "Empty leg (deadhead)". | N/A | - |

## Notes

- **agentKnowledge is present (lines 6-18)** with `preferredTool: query_fleet_ops` - this means the agent CAN answer most data questions via a tool round-trip. The gap is not "unanswerable" but "agent must make an extra call and may return a slightly different value than what is on screen".
- **Biggest gap:** KPI metric values (active count, utilization %, empty miles %, avg speed) are computed and displayed but never serialized to viewState. A single `kpi_summary` memo field would close 4 of the top questions.
- **selectedFeature.attrs is not populated** because the `positions` layer has `pickable: true` and `tooltip` but no `clickEmits` configured in the JSON. Adding `clickEmits` to the positions scatterplot layer would let map clicks feed entity attributes into Channel B.
- **Cross-view pattern:** The DetailPanel sections (Recent Journeys, Safety Events, Planned Work, Asset Profile) are rich per-entity data that could be partially surfaced via a bounded memo string, but the preferredTool `query_fleet_ops` already covers these queries. The priority is lower because the tool path exists.
