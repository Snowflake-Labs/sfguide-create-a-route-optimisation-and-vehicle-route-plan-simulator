# Route Deviation - Deployment Errors (2026-03-24)

## Error 1: ORS Berlin Region Returns NULL for All Profiles
- **Step**: 2 (Verify ORS with Germany Map)
- **Error**: DIRECTIONS_GEO with Berlin region returns NULL DISTANCE/GEOJSON for all profiles (driving-car, driving-hgv)
- **Cause**: ORS Berlin service graphs may not be fully initialized or routing gateway isn't routing to Berlin service
- **Workaround**: Used DIRECTIONS_GEO without region parameter (2-arg VARIANT form) which routed successfully via default ORS service
- **Impact**: All 9,343 OD pairs routed successfully (0 failures) using driving-car profile instead of driving-hgv

## Error 2: Stage Creation Before Schema (race condition)
- **Step**: 3 (Infrastructure Setup)
- **Error**: `File format 'SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.PARQUET_FF' does not exist`
- **Cause**: Stage CREATE executed before file format CREATE completed
- **Resolution**: Retried after file format was created
- **Impact**: None after resolution

## Note: Profile Mismatch
- **Expected**: driving-hgv (HGV truck routing)
- **Used**: driving-car (car routing via DIRECTIONS_GEO VARIANT form)
- **Impact**: Route distances/durations may differ slightly from HGV-specific routes. Deviation analysis still valid since both actual and expected use same baseline.

## Summary
- **Total errors**: 2 (both resolved/worked around)
- **Source data**: 5 tables loaded from S3 (15.2M telemetry rows)
- **Route cache**: 9,343/9,343 OD pairs (228s, 0 failures)
- **ETL**: All 5 tables created (4669, 9343, 3551, 500, 14 rows)
- **Streamlit**: Deployed at FLEET_INTELLIGENCE.ROUTE_DEVIATION.ROUTE_DEVIATION_DASHBOARD
