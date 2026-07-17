# site_impact - Site Impact

## Summary

**Purpose:** Cannibalisation what-if analysis. User picks a candidate site and a drive-time band to see how much revenue/EBITDA the new site draws from the existing estate, split by interaction type. Revenue driven by user-supplied value-per-household, EBITDA-margin, and capture-rate sliders.

**Entities:** Candidate sites and owned stores from `FLEET_APP.LOCATION.VW_STORE_FACTS` and `VW_STORES`. Cannibalisation computed live via `FLEET_APP.LOCATION.LIVE_CANNIBALISATION`, overlaps via `LIVE_OVERLAPS`, overlap cells via `LIVE_OVERLAP_CELLS`, ZIP bands via `LIVE_ZIP_BANDS`, owned catchments via `LIVE_OWNED_CATCHMENTS`, overlap ZIPs via `LIVE_OVERLAP_ZIPS`.

**Map layers** (app-views.json:3308-3467):
- `zip-drivetime-choropleth` (geojson): ZIP polygons colored by drive-time band from candidate, toggle `show_zip`.
- `overlap-intensity-hex` (h3): H3 hex heatmap of overlap_count, toggle `show_overlap`.
- `selected-overlap-outline` (geojson): Highlighted overlap polygon for selected overlap row.
- `selected-store-isochrone` (geojson): Selected existing store's full catchment, toggle `show_selected_store`.
- `stores` (scatterplot): All stores (owned + candidate) colored by role.
- `selected-store-ring` (scatterplot): Ring highlight on selected store.
- `candidate-isochrone` (geojson): Live ORS isochrone ring for the candidate at selected band.

**Metrics** (app-views.json:3201-3221): MetricCards: Cannibalised revenue, Cannibalised EBITDA, Shared households, Stores impacted.

**Tables** (app-views.json:3261-3522):
- `transfers` (ClickableTable): Revenue transfer by existing store - store name, households, transfer %, revenue, home_visit, sample, walk_in. Emits `selected_store` (highlight).
- `overlaps` (ClickableTable): Overlap summary - existing store, overlap km2, ZIPs, households, cannibalised rev, cannibalised EBITDA, transfer %, confidence. Emits `selected_overlap` (selection).
- `overlapzips` (Table): Postcodes inside overlap - existing store, ZIP, population, households, median income.
- `ziptable` (Table): ZIP codes by drive-time band from candidate.

**Detail Panel** (app-views.json:3524-3573): `overlap_drawer` triggered by `selected_overlap`.

**Slider/selection emits** (app-views.json:3226-3260, 3277, 3498):
- FilterBar: `selected_candidate` (selection), `selected_band` (selection).
- Slider `rev`: emits `value_per_hh` (filter).
- Slider `margin`: emits `ebitda_margin` (filter).
- Slider `capture`: emits `capture_rate` (filter).
- ClickableTable `transfers`: emits `selected_store` (highlight).
- ClickableTable `overlaps`: emits `selected_overlap` (selection).

**agentKnowledge** (app-views.json:3187-3191):
- preferredTool: `"query_location"`
- keyMetrics: cannibalised revenue and EBITDA, shared households, existing stores impacted
- exampleQuestions: "How much would the candidate site cannibalise within a 20-minute drive?", "Which existing store loses the most revenue to the new site?"
- gotchas: Drive-time bands are nested what-if scenarios; never sum transfer across bands. Household counts real; revenue/EBITDA derived from user inputs. Home Visit/Sample/Walk-in split from estate.

**viewState keys:** `selected_candidate`, `selected_band`, `value_per_hh`, `ebitda_margin`, `capture_rate`, `selected_store`, `selected_overlap`; plus context keys.

**mapState:** Layers with featureCount. NO `clickEmits` on map - so `selectedFeature.attrs` will NOT populate from map clicks. Store dots are pickable with tooltip but no click emission.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | Which candidate site is selected? | Per-entity | Yes | viewState.selected_candidate. | N/A | N/A |
| 2 | What drive-time band is active? | Per-entity | Yes | viewState.selected_band. | N/A | N/A |
| 3 | What are the current slider values (value/hh, margin, capture)? | Per-entity | Yes | viewState.value_per_hh, viewState.ebitda_margin, viewState.capture_rate. | N/A | N/A |
| 4 | How much revenue does the candidate cannibalise? | Counting | Partial | MetricCards `transfer_rev` not in viewState. preferredTool="query_location" could compute. | Publish metrics memo: `_cannibalised_rev=X, _cannibalised_ebitda=Y, _shared_hh=Z, _stores_impacted=N`. | High |
| 5 | How much EBITDA is cannibalised? | Counting | Partial | Same as #4 - MetricCards value not surfaced. Tool could answer. | Include in metrics memo. | High |
| 6 | How many households are shared? | Counting | Partial | MetricCards `shared_hh` not surfaced. Tool could answer. | Include in metrics memo. | High |
| 7 | How many existing stores are impacted? | Counting | Partial | MetricCards `impacted` not surfaced. Tool could answer. | Include in metrics memo. | High |
| 8 | Which existing store loses the most revenue? | Ranking | Partial | Transfers table data not in viewState. Tool "query_location" could query. | Publish top-impacted store name+rev as memo. | High |
| 9 | What is the overlap area (km2) with store X? | Per-entity | Partial | Overlaps table data not in viewState. Tool could query. If `selected_overlap` is set, drawer data accessible but not surfaced. | Acceptable via tool. | Med |
| 10 | What ZIPs are inside the overlap? | Per-entity | Partial | overlapzips table visible but data not in any channel. Tool could query. | Acceptable via tool. | Low |
| 11 | What is the transfer probability for store X? | Per-entity | Partial | In overlaps table data, not in viewState. Tool could answer. | Acceptable via tool. | Med |
| 12 | How many ZIPs are within 10 minutes of the candidate? | Counting | Partial | ziptable has this data but not surfaced. Tool could compute. | Acceptable via tool. | Low |
| 13 | What is the total population reachable within the band? | Counting | Partial | ziptable has cumulative population but not surfaced. Tool could compute. | Add to metrics memo or gotchas. | Med |
| 14 | What is the confidence level of the overlap? | Per-entity | Partial | In overlaps table column but not surfaced. Tool could query. | Acceptable via tool. | Low |
| 15 | Which overlap row is selected? | Map-state | Yes | viewState.selected_overlap (if set). | N/A | N/A |
| 16 | Which store is highlighted on the map? | Map-state | Yes | viewState.selected_store (from transfers table highlight). | N/A | N/A |
| 17 | What layers are visible/hidden? | Map-state | Yes | mapState.layers[].rendered/gated status. | N/A | N/A |
| 18 | Why is the overlap hex layer blank? | Map-state | Yes | mapState.emptyLayers or layers[].featureCount=0; agent instructed to diagnose. | N/A | N/A |
| 19 | What does the map show for the selected store? | Spatial | Partial | If `selected_store` set and `show_selected_store` toggle on, the isochrone layer renders but its details (area, band) only in tooltip not in selectedFeature.attrs (no clickEmits). | Add clickEmits or publish selected-store catchment summary. | Med |
| 20 | Compare cannibalisation at 10 min vs 20 min band | Comparison | No | Only one band active at a time; agent not told prior band's results. Would need two tool calls. | Document in gotchas that comparison requires changing selection. | Low |

## Notes

- No `clickEmits` on the map (app-views.json:3290-3293 shows config with toggles but no clickEmits key). Therefore `selectedFeature.attrs` will NEVER populate from a map click on this view. Store selection happens via ClickableTable `highlight` emits, not map interaction.
- agentKnowledge is present and useful: preferredTool, keyMetrics, gotchas all populated. The main gap is that on-screen MetricCards values and table row data are invisible - the agent must re-query via tool.
- All slider values ARE in viewState (they emit as "filter") so the agent knows the user's economic assumptions. This is a strength.
- **Primary fix:** Publish MetricCards results as a compact viewState memo so the agent can state the headline numbers without a tool round-trip.
- **Counts:** Yes=7, Partial=11, No=2.
