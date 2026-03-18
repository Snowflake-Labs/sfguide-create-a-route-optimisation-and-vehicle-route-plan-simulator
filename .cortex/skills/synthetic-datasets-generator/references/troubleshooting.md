# Troubleshooting Guide

Common issues, causes, and solutions for the Synthetic Fleet Telemetry Generator.

---

## ORS Issues

### ORS returns no routes / routing fails

**Symptoms**: `WARNING - No route for truck TRK-00001 on 2025-12-01` or `ORS routing failed` errors.

**Cause**: ORS compute pool is suspended, services are not running, or the region is not configured for the target area.

**Solution**:
1. Check service status:
   ```sql
   SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```
2. Resume if suspended:
   ```sql
   ALTER COMPUTE POOL OPENROUTESERVICE_NATIVE_APP_COMPUTE_POOL RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.DOWNLOADER RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME;
   ALTER SERVICE OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE RESUME;
   ```
3. Wait 60-90 seconds for services to become READY.
4. Test with a simple route query. If it still fails, the ORS map may not cover the target region. Use the `routing-customization` skill to change the map.

### ORS batch size exceeded

**Symptoms**: `ORS error` with message about response size or timeout.

**Cause**: Requesting too many routes in a single batch call.

**Solution**: The generator handles this automatically with the `ors.batch_size` config (default 200). If you encounter issues, reduce to 100:
```yaml
routing:
  ors:
    batch_size: 100
```

### ORS returns straight-line routes

**Symptoms**: Route quality check fails, average point gap > 2km.

**Cause**: ORS may be returning simplified geometries or falling back to direct connections.

**Solution**: Verify ORS is fully initialized (the OSM data download may still be in progress). Check service logs:
```sql
SELECT SYSTEM$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE', 0, 'ors-service', 50);
```

---

## POI Data Issues

### Fallback POI generators activated

**Symptoms**: `WARNING - Using fallback warehouse generator` or `WARNING - Using warehouses as destinations`.

**Cause**: The expected Overture Maps POI tables (`GERMANY_WAREHOUSES`, `GERMANY_DESTINATIONS`, `GERMANY_REST_STOPS`) do not exist in the target schema.

**Solution**:
- **Option A**: Load POI data first using the `fleet-intelligence-taxis` skill's Overture Maps workflow, adapted for your target region.
- **Option B**: Accept the fallback generators. They create randomly distributed locations within the bounding box. Routes will still follow roads via ORS, but origins/destinations won't correspond to real-world POIs.

### Column name mismatches

**Symptoms**: `KeyError: 'lon'` or `KeyError: 'lng'` when loading POI data.

**Cause**: The POI tables use different column names than expected. The generator expects `LNG`/`LAT` columns.

**Solution**: Verify your POI table column names match the expected format:
- Warehouses: `ID, NAME, BASIC_CATEGORY, LNG, LAT, CITY, ADDRESS`
- Destinations: `ID, NAME, BASIC_CATEGORY, LOCATION_TYPE, LNG, LAT, CITY, ADDRESS`
- Rest stops: `REST_STOP_ID, NAME, REST_TYPE, LNG, LAT, HAS_EV_CHARGING, AREA_M2, CAPACITY_RATING`

---

## Generation Issues

### Memory errors / process killed

**Symptoms**: Python process killed, `MemoryError`, or system becomes unresponsive during generation.

**Cause**: Fleet size too large for the configured chunk size. Each chunk holds all telemetry points for `chunk_size_days * num_trucks * trips_per_day * ~300 points` in memory.

**Solution**: Reduce `time.chunk_size_days`:
```yaml
time:
  chunk_size_days: 3    # Down from default 7
```

Estimated memory per chunk:
| Trucks | chunk_size_days=7 | chunk_size_days=3 |
|--------|------------------|------------------|
| 10 | ~50 MB | ~20 MB |
| 100 | ~500 MB | ~200 MB |
| 500 | ~2.5 GB | ~1 GB |

### Generation is very slow

**Symptoms**: Hours to generate even small datasets.

**Cause**: ORS calls are slow (no route caching) or route cache is corrupt.

**Solution**:
1. Verify `ors.cache_enabled: true` in config
2. Check cache stats: the SQLite file at `cache/routes.db` should grow as routes are computed
3. For re-runs, the cache avoids repeated ORS calls, making subsequent runs much faster
4. If cache is corrupt, delete `cache/routes.db` and regenerate

### Zero telemetry points generated

**Symptoms**: `Generated 0 telemetry points`.

**Cause**: All routes failed (ORS down) or all trucks were not operating (e.g., weekend with low operating rate + small fleet).

**Solution**:
1. Verify ORS is working (see ORS Issues above)
2. Check the date range -- if it only covers weekends, increase `weekend_operating_rate` or extend the range
3. Ensure `fleet.num_trucks > 0`

---

## Snowflake Loading Issues

### COPY INTO fails

**Symptoms**: `COPY INTO failed` error during the `--load` step.

**Cause**: Stage doesn't exist, file format mismatch, or column name mismatch.

**Solution**:
1. Ensure setup was run first: `python main.py setup --config config/config.yml`
2. Verify the stage exists:
   ```sql
   SHOW STAGES IN SCHEMA {DATABASE}.{SCHEMA};
   ```
3. Check Parquet files were generated in the `output/` directory

### Timestamp epoch issues

**Symptoms**: Dates appear as year 50000+ or 1970 in Snowflake.

**Cause**: `write_pandas` sometimes converts timestamps with microsecond epoch instead of second epoch.

**Solution**: The generator includes an automatic fix (`TS epoch fix`). If timestamps still look wrong after loading:
```sql
UPDATE {DATABASE}.{SCHEMA}.FACT_TRUCK_TELEMETRY
SET TS = TO_TIMESTAMP(DATE_PART('epoch_second', TS) / 1000000)
WHERE DATE_PART('epoch_second', TS) > 1e12;
```

### write_pandas errors

**Symptoms**: `ProgrammingError` during dimension table loading.

**Cause**: Column count or type mismatch between DataFrame and target table.

**Solution**:
1. Verify table DDL matches expected schema (run `setup` again)
2. Check DataFrame columns match table columns (case-insensitive)
3. If a column was added to the DDL but not the DataFrame, drop and recreate the table

---

## QA Validation Issues

### Speeding rate outside expected range

**Symptoms**: QA check `speeding_rate` fails with rate < 2% or > 15%.

**Cause**: Driver profile proportions or speeding probabilities are misconfigured.

**Solution**: Check `driver_profiles` config. With default 92% COMPLIANT (2% speeding) + 6% MILD (12%) + 2% OUTLIER (25%), the fleet-wide speeding rate should be approximately:
```
0.92 * 0.02 + 0.06 * 0.12 + 0.02 * 0.25 = 3.06%
```

### Route quality check fails

**Symptoms**: Average point gap > 2000m.

**Cause**: Routes are not road-following (ORS issue) or interpolation interval is too large.

**Solution**:
1. Verify ORS returns detailed route geometries (not simplified)
2. Check `telemetry.ping_interval.moving.target_sec` -- values > 60s increase gap size
3. For long routes (>300km), larger gaps between points are expected

### Spatial bounds check fails

**Symptoms**: Less than 99% of points within the configured bounding box.

**Cause**: GPS jitter pushes edge-case points slightly outside the bbox, or route detours extend beyond the region.

**Solution**: This is usually acceptable. If > 5% of points are outside, check that the region bbox in config matches the actual POI data locations.
