# Risk Intelligence Native App

## Overview

Risk Intelligence is a comprehensive Snowflake Native App that provides advanced risk assessment capabilities for natural disasters, specifically focusing on flood and wildfire risk analysis. The application combines real-time data analysis, geospatial intelligence, and AI-powered insights to help organizations make informed decisions about risk management and safety planning.

## Features

### 🌊 Flood Risk Assessment
- **UK Flood Risk Areas Analysis**: Interactive mapping and analysis of flood-prone areas across the UK
- **Historic Storm Data**: Comprehensive database of historical UK storms and their impacts
- **Flood Warning System Integration**: Real-time integration with flood warning systems
- **Building Profile Analysis**: Detailed risk assessment for individual buildings and infrastructure
- **Geospatial Risk Modeling**: Advanced spatial analysis for flood risk prediction

### 🔥 Wildfire Risk Assessment  
- **California Wildfire Monitoring**: Real-time wildfire risk assessment for California regions
- **Infrastructure Risk Analysis**: Cell tower and critical infrastructure vulnerability assessment
- **Customer Impact Analysis**: Telecommunications customer risk profiling and loyalty analysis
- **AI-Powered Risk Insights**: Machine learning-driven risk predictions and recommendations
- **Historical Fire Data**: Comprehensive wildfire perimeter and impact analysis

## Application Components

### Streamlit Applications
1. **UK Flood Risk Assessment** - Interactive dashboard for flood risk analysis
2. **California Wildfire Risk Assessment** - Comprehensive wildfire risk monitoring and analysis

### Data Sources
- UK Storm historical data
- Flood Risk Areas (GeoJSON boundaries)
- Historic Flood Warning System data
- California wildfire perimeter data (via Snowflake Marketplace)
- Telecommunications infrastructure data (via Snowflake Marketplace)

### Key Capabilities
- **Geospatial Analysis**: Advanced mapping and spatial risk modeling
- **Real-time Monitoring**: Live data integration and alerts
- **AI-Powered Insights**: Machine learning risk predictions
- **Interactive Dashboards**: User-friendly Streamlit interfaces
- **Risk Scoring**: Quantitative risk assessment metrics
- **Historical Analysis**: Trend analysis and pattern recognition

## Installation

### Prerequisites
- Snowflake account with Native App support
- Appropriate privileges for installing Native Apps
- Access to required Snowflake Marketplace listings (for wildfire data)

### Installation Steps

1. **Install the Native App**:
   ```sql
   CREATE APPLICATION RISK_INTELLIGENCE 
   FROM APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE
   USING '@RISK_INTELLIGENCE_STAGE';
   ```

2. **Grant Required Privileges**:
   ```sql
   GRANT APPLICATION ROLE RISK_INTELLIGENCE.RISK_ANALYST TO ROLE <your_role>;
   ```

3. **Load Sample Data** (Optional):
   ```sql
   CALL RISK_INTELLIGENCE.CORE.LOAD_SAMPLE_DATA();
   ```

4. **Access Applications**:
   - Navigate to the Streamlit applications in your Snowflake interface
   - UK Flood Risk Assessment: `RISK_INTELLIGENCE.FLOOD_RISK."UK Flood Risk Assessment"`
   - California Wildfire Risk Assessment: `RISK_INTELLIGENCE.WILDFIRE_RISK."California Wildfire Risk Assessment"`

## Application Roles

### RISK_ANALYST
- View and analyze risk data
- Access Streamlit applications
- Generate risk reports
- Query risk assessment views

### RISK_ADMIN  
- Full administrative access
- Manage application configuration
- Load and update data
- Configure marketplace connections

## Data Schema

### FLOOD_RISK Schema
- `UK_STORMS`: Historical storm data
- `FLOOD_RISK_AREAS`: Geospatial flood risk boundaries
- `FWS_HISTORIC_WARNINGS`: Historic flood warning data
- `FLOOD_RISK_AREAS_VIEW`: Flattened view for analysis

### WILDFIRE_RISK Schema
- `CUSTOMER_LOYALTY_DETAILS`: Customer risk profiles
- `CELL_TOWERS_WITH_RISK_SCORE`: Infrastructure risk assessment
- `CALIFORNIA_FIRE_PERIMETER`: Wildfire boundary data

### CORE Schema
- Application configuration and shared resources
- File formats and stages
- Utility procedures and functions

## Configuration

### Marketplace Data Integration
The application can integrate with Snowflake Marketplace listings for enhanced data:

1. **Location Analytics - Making People Safer**: Wildfire and infrastructure data
2. **OS Building Sample Data**: UK building and geographic data

### Custom Data Loading
Organizations can load their own risk data using the provided file formats and procedures.

## Usage Examples

### Flood Risk Analysis
```sql
-- Query high-risk flood areas
SELECT fra_name, flood_source, geog
FROM RISK_INTELLIGENCE.FLOOD_RISK.FLOOD_RISK_AREAS_VIEW
WHERE flood_source = 'river';

-- Analyze historic storm patterns
SELECT name, dates, uk_fatalities
FROM RISK_INTELLIGENCE.FLOOD_RISK.UK_STORMS
ORDER BY uk_fatalities::INT DESC;
```

### Wildfire Risk Analysis
```sql
-- Assess infrastructure risk
SELECT tower_id, latitude, longitude, risk_score
FROM RISK_INTELLIGENCE.WILDFIRE_RISK.CELL_TOWERS_WITH_RISK_SCORE
WHERE risk_score > 0.7;
```

## Support and Documentation

### Technical Support
- Review application logs in the Snowflake interface
- Check data loading status and errors
- Validate marketplace data connections

### Best Practices
- Regularly update risk data for accurate assessments
- Monitor application performance and resource usage
- Implement appropriate access controls for sensitive risk data
- Integrate with existing business continuity planning processes

## Version History

### v1.0.0
- Initial release with flood and wildfire risk assessment
- UK flood risk analysis capabilities
- California wildfire monitoring
- AI-powered risk insights
- Interactive Streamlit dashboards

## License and Compliance

This application processes risk and safety data. Ensure compliance with:
- Data privacy regulations (GDPR, CCPA)
- Industry-specific safety standards
- Organizational data governance policies
- Geographic data usage restrictions

## Contact

For technical support, feature requests, or partnership opportunities, please contact the Risk Intelligence development team through your Snowflake account representative.
