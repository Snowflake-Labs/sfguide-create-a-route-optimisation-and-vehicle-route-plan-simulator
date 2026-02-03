# Risk Intelligence - Internal Marketplace Deployment Guide

## Overview

This guide provides step-by-step instructions for deploying the Risk Intelligence Native App to your organization's internal Snowflake marketplace. The internal version is optimized for organizational use with simplified permissions and streamlined deployment.

## Prerequisites

### Required Roles and Privileges
- `ACCOUNTADMIN` role for initial setup
- `CREATE APPLICATION PACKAGE` privilege
- Access to internal Snowflake account
- Ability to upload files to Snowflake stages

### Required Files
- Application source code (Streamlit apps)
- Data files (UK storms, flood risk areas)
- Configuration files (manifest, setup scripts)

## Deployment Steps

### Step 1: Initial Setup (ACCOUNTADMIN)

```sql
-- Run the internal marketplace deployment script
USE ROLE ACCOUNTADMIN;
@risk_intelligence_native_app/scripts/internal_marketplace_deployment.sql
```

This creates:
- ✅ Application package `RISK_INTELLIGENCE_INTERNAL`
- ✅ Internal distribution stage
- ✅ Simplified manifest and setup files
- ✅ Distribution management procedures

### Step 2: Upload Application Files

From your local environment with SnowSQL or Snowflake CLI:

```bash
# Navigate to the native app directory
cd risk_intelligence_native_app

# Upload Streamlit applications
PUT file://streamlit/flood_risk_areas.py @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;
PUT file://streamlit/wildfire_assessment.py @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;
PUT file://streamlit/environment.yml @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;
PUT file://streamlit/extra.css @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;
PUT file://streamlit/logo.svg @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/streamlit/;

# Upload data files
PUT file://data/uk_storms.csv @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/data/;
PUT file://data/Flood_Risk_Areas.geojson @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/data/;
PUT file://data/fws_historic_warnings.csv @RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE/data/;
```

### Step 3: Create Application Package Version

```sql
-- Create the internal version
ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL 
    ADD VERSION v1_0_internal USING '@RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE'
    COMMENT = 'Internal marketplace version 1.0 - Flood and Wildfire Risk Assessment';

-- Set as default version
ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL 
    SET DEFAULT RELEASE DIRECTIVE VERSION = v1_0_internal PATCH = 0;
```

### Step 4: Set Up Internal Distribution

```sql
-- Create distribution role
CREATE ROLE IF NOT EXISTS RISK_INTELLIGENCE_DISTRIBUTOR
    COMMENT = 'Role for managing internal Risk Intelligence app distribution';

-- Grant necessary privileges
GRANT USAGE ON APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL TO ROLE RISK_INTELLIGENCE_DISTRIBUTOR;
GRANT CREATE APPLICATION ON ACCOUNT TO ROLE RISK_INTELLIGENCE_DISTRIBUTOR;

-- Assign to appropriate administrators
GRANT ROLE RISK_INTELLIGENCE_DISTRIBUTOR TO ROLE <your_admin_role>;
```

## User Deployment Options

### Option 1: Manual Deployment (Per User/Team)

```sql
-- Create application instance for a specific team/user
CREATE APPLICATION RISK_INTELLIGENCE_TEAM_A 
FROM APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL;

-- Grant appropriate roles
GRANT APPLICATION ROLE RISK_INTELLIGENCE_TEAM_A.RISK_USER TO ROLE <team_role>;
GRANT APPLICATION ROLE RISK_INTELLIGENCE_TEAM_A.RISK_ADMIN TO ROLE <admin_role>;

-- Load initial data
CALL RISK_INTELLIGENCE_TEAM_A.SHARED_RESOURCES.LOAD_INTERNAL_DATA();
```

### Option 2: Automated Deployment (Using Procedure)

```sql
-- Use the automated deployment procedure
CALL RISK_INTELLIGENCE_INTERNAL.VERSIONS.DEPLOY_TO_INTERNAL_USER('<target_role>');
```

This automatically:
- Creates application instance
- Assigns user roles
- Loads sample data
- Returns deployment status

## Access and Usage

### For End Users

1. **Access Dashboards**:
   - Flood Risk: Navigate to Streamlit section → `RISK_INTELLIGENCE_[INSTANCE].FLOOD_RISK."Flood Risk Dashboard"`
   - Wildfire Risk: Navigate to Streamlit section → `RISK_INTELLIGENCE_[INSTANCE].WILDFIRE_RISK."Wildfire Risk Dashboard"`

2. **Query Data Directly**:
   ```sql
   -- Flood risk analysis
   SELECT * FROM RISK_INTELLIGENCE_[INSTANCE].FLOOD_RISK.UK_STORMS;
   
   -- Wildfire risk analysis  
   SELECT * FROM RISK_INTELLIGENCE_[INSTANCE].WILDFIRE_RISK.FIRE_INCIDENTS;
   ```

### For Administrators

1. **Manage Data**:
   ```sql
   -- Load additional organizational data
   INSERT INTO RISK_INTELLIGENCE_[INSTANCE].FLOOD_RISK.UK_STORMS 
   VALUES (...);
   
   -- Update risk assessments
   UPDATE RISK_INTELLIGENCE_[INSTANCE].WILDFIRE_RISK.INFRASTRUCTURE_RISK 
   SET risk_score = ... WHERE ...;
   ```

2. **Monitor Usage**:
   ```sql
   -- Check application status
   SHOW APPLICATIONS LIKE 'RISK_INTELLIGENCE%';
   
   -- Monitor Streamlit usage
   SHOW STREAMLITS IN APPLICATION RISK_INTELLIGENCE_[INSTANCE];
   ```

## Integration with Organizational Data

### Connect to Internal Data Sources

```sql
-- Create views to organizational data
CREATE OR REPLACE VIEW FLOOD_RISK.ORGANIZATIONAL_ASSETS AS
SELECT * FROM <your_org_database>.ASSETS.BUILDINGS
WHERE risk_category = 'flood_prone';

-- Integrate with existing risk management systems
CREATE OR REPLACE VIEW WILDFIRE_RISK.CORPORATE_FACILITIES AS
SELECT facility_id, latitude, longitude, asset_value
FROM <your_org_database>.FACILITIES.LOCATIONS
WHERE region = 'California';
```

### Data Refresh Procedures

```sql
-- Create automated data refresh
CREATE OR REPLACE PROCEDURE SHARED_RESOURCES.REFRESH_ORGANIZATIONAL_DATA()
RETURNS STRING
LANGUAGE SQL
AS
BEGIN
    -- Refresh flood risk data from organizational sources
    MERGE INTO FLOOD_RISK.FLOOD_AREAS USING (
        SELECT * FROM <your_org_database>.RISK.FLOOD_ZONES
    ) AS source ON ...;
    
    -- Refresh wildfire risk data
    MERGE INTO WILDFIRE_RISK.INFRASTRUCTURE_RISK USING (
        SELECT * FROM <your_org_database>.RISK.FIRE_RISK_ASSETS  
    ) AS source ON ...;
    
    RETURN 'Organizational data refreshed successfully';
END;
```

## Maintenance and Updates

### Version Management

```sql
-- Create new version for updates
ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_INTERNAL 
    ADD VERSION v1_1_internal USING '@RISK_INTELLIGENCE_INTERNAL.INTERNAL_STAGE'
    COMMENT = 'Updated version with new features';

-- Upgrade existing applications
ALTER APPLICATION RISK_INTELLIGENCE_TEAM_A 
    UPGRADE USING VERSION v1_1_internal;
```

### Monitoring and Troubleshooting

```sql
-- Check application health
SELECT app_name, version, status 
FROM INFORMATION_SCHEMA.APPLICATIONS 
WHERE app_name LIKE 'RISK_INTELLIGENCE%';

-- Monitor resource usage
SELECT warehouse_name, credits_used 
FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY 
WHERE warehouse_name = 'RISK_INTELLIGENCE_WH';
```

## Security and Governance

### Access Control Best Practices

1. **Role-Based Access**:
   - Use `RISK_USER` for standard analysts
   - Use `RISK_ADMIN` for data managers
   - Limit `RISK_INTELLIGENCE_DISTRIBUTOR` to IT administrators

2. **Data Governance**:
   - Implement row-level security for sensitive data
   - Use masking policies for PII data
   - Set up audit logging for compliance

3. **Resource Management**:
   - Monitor warehouse usage and costs
   - Set up resource monitors and alerts
   - Implement auto-suspend policies

### Compliance Considerations

- Ensure data residency requirements are met
- Implement appropriate data retention policies
- Set up audit trails for risk assessment activities
- Validate against organizational security standards

## Support and Troubleshooting

### Common Issues

1. **Installation Failures**:
   - Verify ACCOUNTADMIN privileges
   - Check stage file uploads
   - Validate manifest.yml syntax

2. **Access Issues**:
   - Confirm role assignments
   - Check application role grants
   - Verify warehouse permissions

3. **Data Loading Problems**:
   - Validate file formats
   - Check stage permissions
   - Review error logs

### Getting Help

- **Internal IT Support**: Contact your Snowflake administrators
- **Documentation**: Refer to application README files
- **Logs**: Check Snowflake query history and error logs
- **Community**: Leverage internal Snowflake user groups

## Next Steps

After successful deployment:

1. **User Training**: Conduct training sessions for end users
2. **Data Integration**: Connect to organizational data sources  
3. **Customization**: Adapt dashboards for specific use cases
4. **Scaling**: Plan for additional teams and use cases
5. **Monitoring**: Set up ongoing monitoring and maintenance procedures

---

**Note**: This internal deployment is optimized for organizational use. For external marketplace distribution, use the standard native app deployment process.
