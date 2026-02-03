# Risk Intelligence Native App Test Instance

## Overview

This directory contains the configuration and testing tools for the Risk Intelligence Native App test instance using the `fleet-intelligence-changes` credentials and the dedicated test Snowflake account.

## Test Account Details

- **Account**: `SFSEHOL-TEST_RISK_NATIVE_APP_EZCXJH`
- **URL**: `https://sfsehol-test_risk_native_app_ezcxjh.snowflakecomputing.com/`
- **Credentials**: Same as `fleet-intelligence-changes` (drafts instance)
- **Purpose**: Testing Risk Intelligence Native App deployment and functionality

## Setup Instructions

### 1. Configure Connection

Copy the template configuration file and fill in your credentials:

```bash
cp snowflake_config.template.py snowflake_config.py
```

Edit `snowflake_config.py` with your actual credentials:
- Use the same username/password as your `fleet-intelligence-changes` instance
- Account should be `SFSEHOL-TEST_RISK_NATIVE_APP_EZCXJH`
- Role should be `ATTENDEE_ROLE` or appropriate role for this test account

### 2. Test Connection

Run the connection test to verify your setup:

```bash
python test_risk_intelligence_connection.py
```

This will test:
- ✅ Basic Snowflake connection
- ✅ Risk Intelligence application availability
- ✅ Application roles access
- ✅ Streamlit applications
- ✅ Data source access
- ✅ Original data sources (UK_STORMS_DB, WILDFIRES_DB)

### 3. Setup Risk Intelligence Application

If the application doesn't exist yet, run the setup script:

```bash
python setup_risk_intelligence_test.py
```

This will:
- 📱 Create Risk Intelligence application from package
- 👥 Grant application roles to your user
- 📊 Verify data access
- 🖥️ List available Streamlit apps
- 🧪 Provide sample test queries

## Application Structure

### Risk Intelligence Application: `RISK_INTELLIGENCE_DEMO`

#### Schemas:
- **FLOOD_RISK**: UK flood risk assessment data and applications
- **WILDFIRE_RISK**: California wildfire risk assessment data and applications  
- **SHARED_RESOURCES**: Common resources, file formats, and application info

#### Application Roles:
- **RISK_ANALYST**: Standard user role for risk analysis
- **RISK_ADMIN**: Administrative role for managing the application

#### Streamlit Applications:
- **FLOOD_RISK."UK Flood Risk Assessment"**: Interactive UK flood risk dashboard
- **WILDFIRE_RISK."California Wildfire Risk Assessment"**: California wildfire risk dashboard

## Data Sources

### Application Data (within RISK_INTELLIGENCE_DEMO):
- `FLOOD_RISK.UK_STORMS`: Historical UK storm data
- `FLOOD_RISK.FLOOD_AREAS`: UK flood risk areas with risk levels
- `FLOOD_RISK.HISTORIC_WARNINGS`: Historic flood warning system data
- `WILDFIRE_RISK.CUSTOMER_DETAILS`: Customer loyalty and risk data
- `WILDFIRE_RISK.INFRASTRUCTURE_RISK`: Cell tower and infrastructure risk scores
- `WILDFIRE_RISK.FIRE_PERIMETERS`: California wildfire perimeter data

### Original Data Sources (from attendee setup):
- `UK_STORMS_DB.PUBLIC.*`: Original UK storms and flood risk data
- `WILDFIRES_DB.PUBLIC.*`: Original wildfire and infrastructure data
- `FLEET_INTELLIGENCE.PUBLIC.*`: Fleet management and routing data

## Testing Scenarios

### 1. Basic Functionality Test
```sql
-- Test application info
SELECT * FROM RISK_INTELLIGENCE_DEMO.SHARED_RESOURCES.APPLICATION_INFO;

-- Test flood risk data
SELECT COUNT(*) FROM RISK_INTELLIGENCE_DEMO.FLOOD_RISK.UK_STORMS;

-- Test wildfire risk data  
SELECT COUNT(*) FROM RISK_INTELLIGENCE_DEMO.WILDFIRE_RISK.CUSTOMER_DETAILS;
```

### 2. Streamlit Application Access
1. Navigate to Snowflake UI
2. Go to **Applications** → **RISK_INTELLIGENCE_DEMO**
3. Access Streamlit apps:
   - **FLOOD_RISK."UK Flood Risk Assessment"**
   - **WILDFIRE_RISK."California Wildfire Risk Assessment"**

### 3. Role-Based Access Testing
```sql
-- Test analyst role permissions
USE APPLICATION ROLE RISK_INTELLIGENCE_DEMO.RISK_ANALYST;
SELECT * FROM RISK_INTELLIGENCE_DEMO.FLOOD_RISK.FLOOD_AREAS LIMIT 5;

-- Test admin role permissions  
USE APPLICATION ROLE RISK_INTELLIGENCE_DEMO.RISK_ADMIN;
SHOW TABLES IN SCHEMA RISK_INTELLIGENCE_DEMO.FLOOD_RISK;
```

### 4. Data Integration Testing
```sql
-- Compare application data with original sources
SELECT 
    (SELECT COUNT(*) FROM RISK_INTELLIGENCE_DEMO.FLOOD_RISK.UK_STORMS) as app_storms,
    (SELECT COUNT(*) FROM UK_STORMS_DB.PUBLIC.UK_STORMS) as original_storms;
```

## Troubleshooting

### Common Issues

1. **Connection Failed**
   - Verify account name: `SFSEHOL-TEST_RISK_NATIVE_APP_EZCXJH`
   - Check credentials match your `fleet-intelligence-changes` instance
   - Ensure role has appropriate permissions

2. **Application Not Found**
   - Run the attendee setup script first to create the application package
   - Verify `RISK_INTELLIGENCE_PACKAGE` exists
   - Run `setup_risk_intelligence_test.py` to create the application

3. **Permission Denied**
   - Check that application roles are granted to your user role
   - Verify you're using the correct role in your connection
   - Ensure the attendee setup script completed successfully

4. **Data Access Issues**
   - Verify original data sources (`UK_STORMS_DB`, `WILDFIRES_DB`) exist
   - Check that marketplace data connections are established
   - Ensure data was loaded during attendee setup

### Validation Commands

```sql
-- Check available applications
SHOW APPLICATIONS;

-- Check application package
SHOW APPLICATION PACKAGES;

-- Check application roles
SHOW APPLICATION ROLES IN APPLICATION RISK_INTELLIGENCE_DEMO;

-- Check Streamlit apps
SHOW STREAMLITS IN APPLICATION RISK_INTELLIGENCE_DEMO;

-- Check data availability
SHOW SCHEMAS IN APPLICATION RISK_INTELLIGENCE_DEMO;
```

## Files in this Directory

- **`snowflake_config.template.py`**: Template configuration file
- **`snowflake_config.py`**: Your actual configuration (create from template)
- **`test_risk_intelligence_connection.py`**: Comprehensive connection and functionality test
- **`setup_risk_intelligence_test.py`**: Setup script for Risk Intelligence application
- **`README.md`**: This documentation file

## Next Steps

After successful setup:

1. **Validate Functionality**: Run all test scripts to ensure everything works
2. **Test Streamlit Apps**: Access and test both flood and wildfire risk dashboards
3. **Data Exploration**: Use the sample queries to explore risk data
4. **Integration Testing**: Test with your existing workflows and data sources
5. **Performance Testing**: Validate performance with realistic data volumes

## Support

For issues with this test instance:
1. Check the troubleshooting section above
2. Run the test scripts to identify specific problems
3. Verify the attendee setup script completed successfully
4. Check Snowflake logs for detailed error messages
