# catchment - Catchment

## Summary

**Purpose:** Drive-time catchment and market analysis. User picks a candidate site (from table or map click), sees live isochrone rings (5/10/15 min), reachable population/households/median income, venue counts and categories.

**Entities:** POIs from `FLEET_APP.CATCHMENT.VW_POIS`, addresses from `FLEET_APP.CATCHMENT.VW_REGIONAL_ADDRESSES`. Catchment computed live via `FLEET_APP.CATCHMENT.LIVE_CATCHMENT` and `LIVE_CATCHMENT_CATEGORIES`.

**Map layers** (app-views.json:2975-3132):
- `address-density` (h3): H3 hex heatmap of address count, toggle `show_density`.
- `ring-15` (geojson): 15-min isochrone polygon with population/households/venues/median_income in tooltip.
- `ring-10` (geojson): 10-min isochrone polygon.
- `ring-5` (geojson): 5-min isochrone polygon.
- `pois` (scatterplot): Up to 5000 venue dots, colored by category, tooltip shows name+category.
- `anchor` (scatterplot): Greenfield click anchor point.
- `selected-site` (scatterplot): Highlighted selected POI dot.

**Metrics** (app-views.json:2884-2903): Population <=15 min, Households <=15 min, Median income, Venues <=15 min, Catchment area km2.

**Tables** (app-views.json:2135-3179):
- `bands`: Catchment by drive-time band (5/10/15 min) - population, households, median income, venues, addresses, area km2.
- `categories`: Venues by category within 15 min.

**Slider/selection emits** (app-views.json:2906-2942, 2948):
- FilterBar `category` emits `selected_category` (selection).
- ClickableTable `candidates` emits `selected_poi` (selection).
- Map `clickEmits` (line 2948): `selected_poi` (objectColumn: poi_name), `anchor_lng`, `anchor_lat`.

**agentKnowledge** (app-views.json:2870-2874):
- preferredTool: `"catchment"`
- keyMetrics: reachable population and households, median income, venues in catchment, catchment area
- exampleQuestions: "How many people live within a 10-minute drive of this site?", "How many restaurants compete inside the 15-minute catchment?", "What is the median income of the 5-minute catchment?"
- gotchas: Bands are cumulative; never sum across rows. US Census figures (0 outside US). Venues from Overture. Isochrones are live.

**viewState keys:** `selected_poi`, `anchor_lng`, `anchor_lat`, `selected_category` (from emits); plus context keys.

**mapState:** Layers with featureCount per layer. `clickEmits` IS set (line 2948) so `selectedFeature.attrs` WILL populate when user clicks a POI on the map - attrs will include `poi_name` and `category` from the tooltip/data columns.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | Which site is currently selected? | Per-entity | Yes | viewState.selected_poi contains the POI name (emitted from table or clickEmits). | N/A | N/A |
| 2 | What is the population within 15 minutes of this site? | Counting | Partial | MetricCards query computes it but value not in viewState. Agent told preferredTool="catchment" so could call tool, but on-screen number not directly told. | Publish metrics memo to viewState: `_catchment_pop_15=X, _catchment_hh_15=Y`. | High |
| 3 | What is the median income of the catchment? | Counting | Partial | Same - MetricCards value not in viewState. Tool could compute. | Publish in metrics memo. | High |
| 4 | How many venues are within 15 minutes? | Counting | Partial | MetricCards `venues` not surfaced. Tool could re-compute. | Publish in metrics memo. | High |
| 5 | What is the catchment area in km2? | Counting | Partial | MetricCards `area_km2` not surfaced. Tool could re-compute. | Publish in metrics memo. | Med |
| 6 | What are the drive-time band stats (5/10/15 min)? | Counting | Partial | Bands table data not in viewState or mapState. Tool "catchment" could answer. | Publish compact band summary (3 rows) as viewState memo. | High |
| 7 | How many restaurants compete within 10 minutes? | Per-entity | Partial | Categories table has venue-by-category but only for 15 min; 10-min category split not shown. Tool could compute per agentKnowledge. | Acceptable via tool - document in gotchas that category breakdown is 15 min only on screen. | Low |
| 8 | What category has the most venues? | Ranking | Partial | Categories table data (<=15 venues by category) not in any channel. Tool could compute. | Publish top-3 categories as viewState memo. | Med |
| 9 | What is the address density near the selected site? | Spatial | No | H3 address-density layer rendered but individual cell counts only in tooltip; featureCount = row count. No summary metric. | Add `_catchment_addresses_15` to metrics memo (the bands table already has it). | Med |
| 10 | What category does the selected site belong to? | Per-entity | Partial | If user map-clicked, selectedFeature.attrs will include `category`. If selected via table, only `selected_poi` name is in viewState - category not emitted. | Emit category alongside selected_poi from ClickableTable, or always populate from clickEmits attrs. | Med |
| 11 | How many POI dots are on the map? | Map-state | Yes | mapState.layers (pois layer).featureCount. | N/A | N/A |
| 12 | Is the address density layer showing? | Map-state | Yes | mapState.layers (address-density).rendered + gated status. | N/A | N/A |
| 13 | What are the isochrone rings visible on the map? | Map-state | Yes | mapState.layers lists ring-5, ring-10, ring-15 with rendered/gated status. Legend labels confirm. | N/A | N/A |
| 14 | Which filter category is active? | Map-state | Yes | viewState.selected_category contains the active filter value. | N/A | N/A |
| 15 | Compare population at 5 vs 10 vs 15 min bands | Comparison | Partial | Bands table has the data; not in viewState. Tool "catchment" could compute. | Publish band summary memo. | High |
| 16 | What coordinates did I click? | Per-entity | Yes | viewState.anchor_lng and viewState.anchor_lat. | N/A | N/A |

## Notes

- `clickEmits` IS present (line 2948) so `selectedFeature.attrs` will populate on map-click with the POI's scatterplot data columns (poi_name, category, lng, lat, and possibly trips from joined fields). This is a strength vs. site_impact/closure_impact which lack clickEmits.
- agentKnowledge is well-structured: preferredTool, keyMetrics, gotchas all present. The main gap is that on-screen computed values (MetricCards, bands table, categories table) are invisible to the agent - it must re-query via the tool.
- The "catchment" tool (preferredTool) likely wraps `LIVE_CATCHMENT` so the agent CAN answer most questions via a round-trip, making many gaps "Partial" rather than "No".
- **Primary fix:** Publish a compact metrics memo (population, households, income, venues, area for the 15-min band) to viewState after the MetricCards query resolves.
- **Counts:** Yes=5, Partial=9, No=2.
