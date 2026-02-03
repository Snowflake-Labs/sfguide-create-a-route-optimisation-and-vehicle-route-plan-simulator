# Retail Catchment Analysis with Overture Maps

A geospatial analytics solution that helps businesses identify optimal retail locations by analyzing customer catchment areas using isochrone-based travel time analysis and Overture Maps POI data.

## Overview

This demo combines OpenRouteService's isochrone capabilities with Carto's Overture Maps Places dataset to provide data-driven insights for retail expansion and location optimization. Analyze catchment zones, identify competitors, and visualize address density using H3 hexagonal grids.

## Key Features

### Catchment Area Visualization
Analyze and visualize customer catchment areas using travel-time isochrones:
- **Primary catchment zones** - Areas reachable within 5-10 minutes
- **Secondary catchment zones** - Extended reach within 15-30 minutes
- **Competitive overlap** - Competitor locations within catchment boundaries
- **Market gaps** - Underserved areas representing expansion opportunities

### Overture Maps POI Integration
Leverage real-world Points of Interest from the Overture Maps Foundation:
- Retail locations (convenience stores, supermarkets, pharmacies)
- Food & beverage (restaurants, cafes, fast food)
- Services (banks, post offices, gas stations)

### H3 Address Density Analysis
Visualize population density using hexagonal grid aggregation:
- Address counts per H3 cell
- Heat map visualization of customer potential
- Resolution-adjustable grid display

### AI-Powered Market Analysis
Generate comprehensive market insights using Snowflake Cortex:
- Market opportunity scoring
- Competitive landscape analysis
- Strategic recommendations

## Architecture

| Component | Description |
|-----------|-------------|
| **OpenRouteService Native App** | Provides isochrone calculations for travel-time catchments |
| **Carto Overture Maps** | POI data from Snowflake Marketplace |
| **Streamlit in Snowflake** | Interactive visualization and analysis UI |
| **Snowflake Cortex** | AI-powered market analysis |

## Prerequisites

1. **OpenRouteService Native App** installed and running
2. **Carto Overture Maps Places** from Snowflake Marketplace (listing ID: `GZT0Z4CM1E9KR`)

## Deployment

Use the included skill for automated deployment:

```
use the local skill from skills/deploy-demo
```

Or manually:

1. Run `scripts/01_setup_database.sql` to create database and stage
2. Upload Streamlit files to `@RETAIL_CATCHMENT_DEMO.PUBLIC.STREAMLIT_STAGE`
3. Run `scripts/02_deploy_streamlit.sql` to create the Streamlit app

## Usage

1. **Select a city** from the dropdown (San Francisco, Oakland, San Jose, etc.)
2. **Choose a retail category** (Convenience Store, Coffee Shop, Pharmacy, etc.)
3. **Select a store location** from the filtered results
4. **Configure isochrone settings**:
   - Travel mode (driving or walking)
   - Travel time in minutes
5. **Generate catchment analysis** to view:
   - Isochrone boundary on map
   - Competitor locations within catchment
   - H3 address density grid
   - AI market analysis

## File Structure

```
oss-retail-catchment-overture-maps/
├── README.md
├── Streamlit/
│   ├── retail_catchment.py    # Main Streamlit application
│   ├── environment.yml        # Python dependencies
│   ├── extra.css             # Custom styling
│   └── logo.svg              # App logo
├── scripts/
│   ├── 01_setup_database.sql  # Database setup
│   └── 02_deploy_streamlit.sql # Streamlit deployment
└── skills/
    └── deploy-demo/
        └── deploy-demo.md     # Deployment skill
```

## Customization

### Change Retail Categories
Edit the `RETAIL_CATEGORIES` list in `retail_catchment.py`:

```python
RETAIL_CATEGORIES = [
    'Convenience Store', 'Coffee Shop', 'Fast Food Restaurant',
    'Pharmacy', 'Supermarket', 'Gas Station', ...
]
```

### Add New Cities
Add entries to the `CITIES` dictionary with coordinates and OpenRouteService app name.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No stores found | Verify Overture Maps data access; check POI category exists in selected city |
| Isochrone fails | Ensure ORS Native App services are running; verify coordinates are within map coverage |
| Map not loading | Check Streamlit has network access for map tiles |

## Related Resources

- [OpenRouteService Native App](../oss-install-openrouteservice-native-app/)
- [Route Optimization Demo](../oss-deploy-route-optimization-demo/)
- [Overture Maps Foundation](https://overturemaps.org/)
