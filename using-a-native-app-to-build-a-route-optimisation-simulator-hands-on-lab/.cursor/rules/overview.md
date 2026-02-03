## Project Overview

This repository contains a hands-on lab for building a route optimization simulator using Snowflake, Streamlit, and the Open Route Service (ORS) Native App. The project demonstrates fleet management, vehicle routing optimization, and geospatial analysis for delivery scenarios.

## Key Technologies & Architecture
- **Data Platform**: Snowflake (SQL, native apps, geospatial functions)
- **Frontend**: Streamlit applications with interactive visualizations
- **Mapping & Visualization**: Pydeck, Altair charts, PyDeck layers
- **Routing Engine**: Open Route Service API and Native App
- **Geospatial**: PostGIS-style functions in Snowflake (ST_*)
- **AI/ML**: Snowflake Cortex for intelligent location parsing
- **DevOps**: GitLab CI/CD with DataOps automation
- **Documentation**: MkDocs for attendee instructions

## Project Structure
```
dataops/event/
├── streamlit/          # Streamlit applications
├── notebooks/          # Jupyter notebooks for analysis
├── homepage/           # Documentation and instructions
├── *.template.sql      # Jinja2 SQL templates for deployment
└── variables.yml       # Configuration variables

pipelines/              # CI/CD pipeline definitions
```

## Core Applications
1. **Route Optimizer Simulator** (`routing.py`): Main vehicle routing optimization tool
2. **NYC Taxi Trip Viewer** (`NYC_taxis.py`): Fleet management analysis
3. **NYC Heat Map** (`NYC_heat_map.py`): Geospatial visualization


