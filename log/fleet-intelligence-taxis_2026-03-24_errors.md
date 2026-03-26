# Fleet Intelligence Taxis - Deployment Errors (2026-03-24)

## Error 1: Overture Maps Databases Not Installed
- **Step**: 3b (Check & Install Overture Maps Datasets)
- **Error**: `SQL compilation error: Database 'OVERTURE_MAPS__PLACES' does not exist or not authorized.`
- **Same for**: `OVERTURE_MAPS__ADDRESSES`
- **Resolution**: Installed from Marketplace listings (GZT0Z4CM1E9KR, GZT0Z4CM1E9NQ)
- **Impact**: None after resolution

## Error 2: Snow CLI Default Connection Cannot Access Schema
- **Step**: 10 (Deploy Streamlit - Upload Files)
- **Error**: `002003 (02000): SQL compilation error: Schema 'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS' does not exist or not authorized.`
- **Cause**: `snow stage copy` using default CLI connection (SFCOGSOPS-SNOWHOUSE) instead of fleet_test_evals (wgb26798)
- **Resolution**: Added `--connection fleet_test_evals` to all snow stage copy commands
- **Impact**: None after resolution

## Summary
- **Total errors**: 2 (both resolved)
- **Data pipeline**: Completed successfully (1,165 routes, 17,475 location points, 80 drivers)
- **Streamlit**: Deployed at FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS.TAXI_CONTROL_CENTER
