# closure_impact - Closure Impact

## Summary

**Purpose:** Closure what-if analysis. User picks an existing (owned) store to hypothetically close and a drive-time band to see which surviving stores inherit its households and revenue, and how much revenue is at risk (postcodes no surviving store can reach). Revenue/EBITDA driven by user-supplied value-per-household, EBITDA-margin, and retention-rate sliders.

**Entities:** Owned stores from `FLEET_APP.LOCATION.VW_STORE_FACTS` (STORE_ROLE='OWNED'). Closure analytics computed live via `FLEET_APP.LOCATION.LIVE_CLOSURE_ZIPS`, `LIVE_CLOSURE_GAINERS`, `LIVE_CLOSURE_OVERLAPS`, `LIVE_CLOSURE_CELLS`, `LIVE_OWNED_CATCHMENTS`.

**Map layers** (app-views.json:3704-3878):
- `closed-catchment` (geojson): Outline of the closing store's drive-time catchment (line only).
- `survivor-catchments` (geojson): All surviving stores' catchments color-coded, toggle `show_catchments`.
- `closure-zip-risk` (geojson): ZIP polygons colored RETAINED (blue) vs AT_RISK (amber), toggle `show_zip_risk`.
- `closure-coverage-hex` (h3): H3 hex heatmap of survivor_count (red=at risk, green=well covered), toggle `show_coverage`.
- `closure-selected-overlap-outline` (geojson): Highlighted overlap polygon for selected overlap row.
- `selected-survivor-isochrone` (geojson): Selected surviving store's full catchment, toggle `show_selected_store`.
- `selected-store-ring` (scatterplot): Ring highlight on selected surviving store.
- `owned-stores` (scatterplot): All owned stores colored by ID, closed store highlighted yellow.

**Metrics** (app-views.json:3595-3616): MetricCards: Revenue retained, Revenue at risk, Closure risk %, Households at risk.

**Tables** (app-views.json:3655-3928):
- `gainers` (ClickableTable): Surviving stores inheriting households/revenue - gaining_store, households, % of closed, revenue, home_visit, sample, walk_in. Emits `selected_store` (highlight).
- `overlaps` (ClickableTable): Closure overlap summary - surviving_store, overlap km2, ZIPs, households, retained rev, retained EBITDA, home_visit, sample, walk_in, transfer %, status. Emits `selected_overlap` (selection).
- `overlapzips` (Table): Postcodes retained vs at-risk - ZIP, status, nearest survivor, population, households, median income, revenue.

**Detail Panel** (app-views.json:3929-3982): `closure_drawer` triggered by `selected_overlap`.

**Slider/selection emits** (app-views.json:3619-3654, 3671, 3901):
- FilterBar: `selected_closed` (store to close, selection), `selected_closed_band` (drive-time band, selection).
- Slider `rev`: emits `value_per_hh` (filter).
- Slider `margin`: emits `ebitda_margin` (filter).
- Slider `retention`: emits `retention_rate` (filter).
- ClickableTable `gainers`: emits `selected_store` (highlight).
- ClickableTable `overlaps`: emits `selected_overlap` (selection).

**agentKnowledge** (app-views.json:3580-3584):
- preferredTool: `"query_location"`
- keyMetrics: revenue retained by surviving stores, revenue at risk, closure risk score, households reassigned, households at risk
- exampleQuestions: "If we close this store, which store inherits the most sales?", "How much revenue is at risk if we close this store?", "What is the closure risk score for this store?"
- gotchas: ZIP is RETAINED if a surviving store reaches it, else AT_RISK. Revenue/EBITDA derived from user inputs. Closure risk score = at-risk rev / total closing-store rev. Overlap rows pairwise - do not sum households across rows.

**viewState keys:** `selected_closed`, `selected_closed_band`, `value_per_hh`, `ebitda_margin`, `retention_rate`, `selected_store`, `selected_overlap`; plus context keys.

**mapState:** Layers with featureCount. NO `clickEmits` on map - `selectedFeature.attrs` will NOT populate from map clicks. Store dots are pickable (tooltip) but clicking does not emit.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | Which store is selected to close? | Per-entity | Yes | viewState.selected_closed. | N/A | N/A |
| 2 | What drive-time band is active? | Per-entity | Yes | viewState.selected_closed_band. | N/A | N/A |
| 3 | What are the current slider values? | Per-entity | Yes | viewState.value_per_hh, viewState.ebitda_margin, viewState.retention_rate. | N/A | N/A |
| 4 | How much revenue is retained? | Counting | Partial | MetricCards `revenue_retained` not in viewState. preferredTool="query_location" could compute. | Publish metrics memo: `_rev_retained=X, _rev_at_risk=Y, _closure_risk_pct=Z, _hh_at_risk=N`. | High |
| 5 | How much revenue is at risk? | Counting | Partial | MetricCards `revenue_at_risk` not surfaced. Tool could answer. | Include in metrics memo. | High |
| 6 | What is the closure risk score/percentage? | Counting | Partial | MetricCards `closure_risk_pct` not surfaced. Tool could answer. | Include in metrics memo. | High |
| 7 | How many households are at risk? | Counting | Partial | MetricCards `hh_at_risk` not surfaced. Tool could answer. | Include in metrics memo. | High |
| 8 | Which surviving store inherits the most revenue? | Ranking | Partial | Gainers table data not in viewState. Tool could query. | Publish top gainer name+rev as memo. | High |
| 9 | How many surviving stores inherit households? | Counting | Partial | Gainers table row count not in viewState. mapState might have featureCount for related layers but not table rows. Tool could answer. | Include gainers_count in metrics memo. | Med |
| 10 | What percentage of the closed store's catchment goes to store X? | Per-entity | Partial | Gainers table `pct_of_closed` column, not in any channel. Tool could query. | Acceptable via tool. | Med |
| 11 | Which ZIPs are at risk? | Per-entity | Partial | overlapzips table has ZIP+status data but not in any channel. Tool could query. | Acceptable via tool. | Low |
| 12 | What is the overlap area with surviving store X? | Per-entity | Partial | Overlaps table data not in viewState. Tool could query. If `selected_overlap` set, drawer data still not in channel. | Acceptable via tool. | Low |
| 13 | How many ZIPs are retained vs at-risk? | Counting | Partial | Could be derived from overlapzips table but not surfaced. Tool could count. | Add retained_zips/at_risk_zips to metrics memo. | Med |
| 14 | What does the coverage heatmap show? | Spatial | Partial | mapState.layers shows `closure-coverage-hex` with featureCount and rendered status. Legend has gradient labels. But actual survivor_count distribution not told. | Agent can confirm layer is rendered + feature count. For distribution, needs tool. | Low |
| 15 | Which surviving store is highlighted? | Map-state | Yes | viewState.selected_store (from gainers table). | N/A | N/A |
| 16 | Which overlap row is selected? | Map-state | Yes | viewState.selected_overlap. | N/A | N/A |
| 17 | What layers are visible on the map? | Map-state | Yes | mapState.layers[].rendered/gated. Legend labels in mapState.legend. | N/A | N/A |
| 18 | Why is the ZIP risk layer not showing? | Map-state | Yes | mapState.layers (closure-zip-risk) gated=true if toggle off, or featureCount=0. Agent instructed to diagnose. | N/A | N/A |
| 19 | Compare revenue at risk at 10 min vs 20 min band | Comparison | No | Only one band active. Agent not told prior band's results. Would need two tool calls or band change. | Document in gotchas that comparison requires changing the band selection. | Low |
| 20 | Is there a store that covers all at-risk households if we reposition? | Spatial | No | Not computable from current view - would need a new analysis (which store's catchment contains the at-risk cells). | Out of scope - new feature/tool work. | Low |

## Notes

- No `clickEmits` on the map (app-views.json:3683-3692 shows config with toggles only). `selectedFeature.attrs` will NEVER populate from map click. Store selection is via ClickableTable `highlight` emits only.
- agentKnowledge is well-structured and comprehensive - all five keyMetrics map to real MetricCards outputs. Gotchas explain the attribution model clearly.
- All slider values ARE in viewState (emitted as "filter") - agent knows the economic assumptions. This is a key strength shared with site_impact.
- The view is structurally parallel to site_impact but with RETAINED/AT_RISK framing instead of cannibalisation.
- **Primary fix:** Publish MetricCards results (revenue_retained, revenue_at_risk, closure_risk_pct, hh_at_risk) as viewState memo so agent can directly quote headline numbers.
- **Counts:** Yes=7, Partial=11, No=2.
