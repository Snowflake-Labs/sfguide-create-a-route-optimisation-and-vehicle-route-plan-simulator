# Plan: Cycling Profile Swap and Nominatim Removal

## Part 1: Replace cycling-road with cycling-electric

The ORS config (`ors-config.yml`) already has `cycling-electric: true` and `cycling-road: false`. However, many files still reference `cycling-road` as if it were an active/default profile. These hardcoded references need updating.

### Files to change

#### 1. [`build-routing-solution/Native_app/code_artifacts/streamlit/pages/function_tester.py`](build-routing-solution/Native_app/code_artifacts/streamlit/pages/function_tester.py)
- **Line 177**: Change `'cycling-road'` to `'cycling-electric'` in the `ROUTING_PROFILES` list
- **Line 292**: Change `cycling-road` to `cycling-electric` in the profile description docstring
- **Line 1414**: Same change in another docstring occurrence
- **Line 1737**: Change `cycling-road: Road bicycle routing` to `cycling-electric: Electric bicycle routing`

#### 2. [`.cortex/skills/routing-customization/SKILL.md`](.cortex/skills/routing-customization/SKILL.md)
- **Line 56**: Change `cycling-road` to `cycling-electric` in the description
- **Line 170**: Update the hardcoded warning to reference `cycling-electric` instead of `cycling-road`

#### 3. [`.cortex/skills/routing-customization/routing-profiles/SKILL.md`](.cortex/skills/routing-customization/routing-profiles/SKILL.md)
- **Line 53**: Change "Default (car, cycling-road, walking)" to "Default (car, cycling-electric, hgv)"
- **Line 77**: Change the YAML example from `cycling-road` to `cycling-electric`

#### 4. [`.cortex/skills/routing-customization/read-ors-configuration/SKILL.md`](.cortex/skills/routing-customization/read-ors-configuration/SKILL.md)
- **Line 54**: Change `cycling-road` to `cycling-electric` in the common profiles list

#### 5. [`.cortex/skills/route-optimization/assets/streamlit/routing.py`](.cortex/skills/route-optimization/assets/streamlit/routing.py)
- **Line 53**: Change fallback `methods` list from `['driving-car', 'driving-hgv', 'cycling-road']` to `['driving-car', 'driving-hgv', 'cycling-electric']`

#### 6. [`.cortex/skills/route-optimization/references/streamlit-deployment.md`](.cortex/skills/route-optimization/references/streamlit-deployment.md)
- **Line 65**: Update fallback profiles text from `cycling-road` to `cycling-electric`

#### 7. [`.cortex/skills/route-optimization/assets/notebooks/routing_functions_aisql.ipynb`](.cortex/skills/route-optimization/assets/notebooks/routing_functions_aisql.ipynb)
- **Line 1263**: Change `'cycling-road'` to `'cycling-electric'` in the isochrone SQL example

### Files with cycling-road that do NOT need changing (disabled/listing-all-available):
- `ors-config.yml` files (already `enabled: false` for cycling-road)
- `vroom/config.yml` (lists all available profiles for Vroom compatibility)
- `routing-agent/references/agent-definitions.md` line 387 (lists all 9 profiles as available options)
- `routing-customization/routing-profiles/SKILL.md` line 31 (profile table listing all 9)
- `build-routing-solution/SKILL.md` line 297 (already correctly says cycling-road is disabled)

---

## Part 2: Remove Nominatim (geocoding) code

Nominatim is not deployed but dead code remains. 4 areas to clean up:

### 1. Gateway Python service: [`build-routing-solution/Native_app/services/gateway/routing_service.py`](build-routing-solution/Native_app/services/gateway/routing_service.py)

Remove:
- **Lines 17-18**: `NOMINATIM_HOST` and `NOMINATIM_PORT` env var declarations
- **Lines 353-499**: All Nominatim-related functions:
  - `get_nominatim_response()` (lines 354-366)
  - `post_geocode()` (lines 368-395)
  - `post_geocode_detailed()` (lines 397-428)
  - `post_reverse_geocode()` (lines 430-458)
  - `post_geocode_lookup()` (lines 460-486)
  - `get_nominatim_status()` (lines 488-499)

**Safety:** The gateway routes for `/geocode`, `/geocode_detailed`, `/reverse_geocode`, `/geocode_lookup`, and `/nominatim_status` are the only paths that call Nominatim. ORS routing endpoints (`/directions`, `/isochrones`, `/matrix`, `/optimization`) are completely separate code paths and unaffected.

### 2. Gateway service YAML: [`build-routing-solution/Native_app/services/gateway/routing-gateway-service.yaml`](build-routing-solution/Native_app/services/gateway/routing-gateway-service.yaml)

Remove:
- **Lines 13-14**: `NOMINATIM_HOST` and `NOMINATIM_PORT` env vars

### 3. ORS Native App setup script: [`build-routing-solution/Native_app/app/setup_script.sql`](build-routing-solution/Native_app/app/setup_script.sql)

Remove the 4 geocode SQL function definitions and their grants (lines 292-322):
```sql
CREATE OR REPLACE FUNCTION core.GEOCODE(address VARCHAR) ...
GRANT USAGE ON FUNCTION core.GEOCODE(varchar) ...
CREATE OR REPLACE FUNCTION core.GEOCODE(address VARCHAR, options VARIANT) ...
GRANT USAGE ON FUNCTION core.GEOCODE(varchar, variant) ...
CREATE OR REPLACE FUNCTION core.REVERSE_GEOCODE(lon FLOAT, lat FLOAT) ...
GRANT USAGE ON FUNCTION core.REVERSE_GEOCODE(float, float) ...
CREATE OR REPLACE FUNCTION core.GEOCODE_LOOKUP(osm_ids VARCHAR) ...
GRANT USAGE ON FUNCTION core.GEOCODE_LOOKUP(varchar) ...
```

### 4. Skill documentation: [`.cortex/skills/build-routing-solution/SKILL.md`](.cortex/skills/build-routing-solution/SKILL.md)

- **Line 140-141**: Remove the nominatim note entirely (no longer relevant once code is gone)
- **Line 318-319**: Remove `GEOCODE_LOOKUP(address)` / `REVERSE_GEOCODE(lon, lat)` from the Available Functions list

### No changes needed elsewhere
- The `routing-agent` skill uses AI_COMPLETE for geocoding (not the Nominatim GEOCODE function) -- safe
- The `route-optimization` notebook has a cell named `geocode_summit_address` but it's a custom table name, not calling the GEOCODE function -- safe (needs verification during implementation)
