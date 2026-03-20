# Fix Matrix Function Gateway Bugs

## Problem

Two bugs prevent MATRIX and MATRIX_TABULAR from working:

### Bug 1: `/matrix_tabular` handler ignores 3rd argument

**File:** [routing_service.py:269-302](build-routing-solution/Native_app/services/gateway/routing_service.py)

Both SQL functions route to `/matrix_tabular`:
- `MATRIX(method, locations)` sends `[row_id, method, locations]` (3 elements)
- `MATRIX_TABULAR(method, origin, destinations)` sends `[row_id, method, origin, destinations]` (4 elements)

The handler always reads `row[2]` as a complete locations array. For the 3-arg case, `row[2]` is just a single origin point `[-122.445, 37.755]`, which ORS rejects as invalid.

**Fix:** Detect row length and combine origin + destinations when `len(row) == 4`.

```python
output_rows = []
for row in input_rows:
    if len(row) == 4:
        origin = row[2] if isinstance(row[2][0], list) else [row[2]]
        destinations = row[3]
        locations = origin + destinations
        body = {
            'locations': locations,
            'sources': list(range(len(origin))),
            'destinations': list(range(len(origin), len(locations))),
            'metrics': ['distance', 'duration'],
            'resolve_locations': True
        }
    else:
        body = {
            'locations': row[2],
            'metrics': ['distance', 'duration'],
            'resolve_locations': True
        }
    output_rows.append([row[0], get_ors_response('matrix', row[1], body, format)])
```

### Bug 2: Function Tester MATRIX type resolution

**File:** [function_tester.py:1510-1521](build-routing-solution/Native_app/code_artifacts/streamlit/pages/function_tester.py)

The Streamlit Function Tester creates a Snowpark DataFrame with `LOCATIONS` as a Python list, which Snowpark serializes as VARIANT. This causes Snowflake to resolve to the `MATRIX(varchar, VARIANT)` overload (routing to `/matrix`), where the handler passes the raw array directly to ORS instead of wrapping it in `{"locations": [...]}`.

**Fix:** Use raw SQL with `ARRAY_CONSTRUCT` to ensure ARRAY type resolution, or cast to ARRAY explicitly.

## Steps

### 1. Fix `/matrix_tabular` handler in routing_service.py

Replace the list comprehension at line 290-294 with a loop that checks `len(row)` and builds the appropriate body.

### 2. Fix Function Tester MATRIX call

Update [function_tester.py:1510-1521](build-routing-solution/Native_app/code_artifacts/streamlit/pages/function_tester.py) to use raw SQL with `ARRAY_CONSTRUCT` instead of Snowpark `call_function` with a Python list, ensuring the ARRAY overload is matched.

### 3. Rebuild gateway image

```bash
cd Native_app/services/gateway
docker build --rm --platform linux/amd64 -t $REPO_URL/routing_reverse_proxy:v0.7.3 .
docker push $REPO_URL/routing_reverse_proxy:v0.7.3
```

Update [routing-gateway-service.yaml](build-routing-solution/Native_app/services/gateway/routing-gateway-service.yaml) to reference `v0.7.3`.

### 4. Redeploy native app

```bash
cd Native_app && snow app run -c fleet_test_evals --warehouse ROUTING_ANALYTICS
```

### 5. Verify

```sql
-- MATRIX (ARRAY overload)
SELECT CORE.MATRIX('driving-car',
  ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(-122.445,37.755), ARRAY_CONSTRUCT(-122.435,37.765)));

-- MATRIX_TABULAR (3-arg)
SELECT CORE.MATRIX_TABULAR('driving-car',
  ARRAY_CONSTRUCT(-122.445, 37.755),
  ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(-122.435, 37.765), ARRAY_CONSTRUCT(-122.443, 37.768)));
```
