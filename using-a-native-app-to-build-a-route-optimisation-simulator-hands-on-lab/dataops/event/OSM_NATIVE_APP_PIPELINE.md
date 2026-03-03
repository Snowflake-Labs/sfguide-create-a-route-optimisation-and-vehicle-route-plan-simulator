# OpenStreetMap Generator Native App - DataOps Pipeline Integration

This document describes the integration of the OpenStreetMap Generator Native App into the DataOps pipeline for automated deployment.

## 🏗️ Pipeline Integration Overview

The OSM Native App has been integrated into the existing DataOps pipeline as a new deployment stage that:

1. **Creates the native app package** with all required artifacts
2. **Configures external access integrations** for OpenStreetMap APIs
3. **Deploys the application instance** with proper permissions
4. **Validates the deployment** with test functions
5. **Provides usage examples** and documentation

## 📁 Pipeline Files

### **SQL Template**
- **File**: `dataops/event/deploy_osm_native_app.template.sql`
- **Purpose**: Main deployment script with templated variables
- **Features**:
  - Creates application package and version
  - Sets up external access integrations
  - Deploys application instance
  - Configures permissions and grants
  - Runs validation tests
  - Creates usage examples

### **Pipeline Configuration**
- **File**: `pipelines/includes/local_includes/deploy_osm_native_app.yml`
- **Purpose**: GitLab CI/CD job configuration
- **Features**:
  - Runs in "Additional Configuration" stage
  - Depends on account setup completion
  - Uses ACCOUNTADMIN role for deployment
  - Conditional execution based on variables

### **Variables Configuration**
- **File**: `dataops/event/variables.yml`
- **Added Variables**:
  ```yaml
  EVENT_DEPLOY_OSM_NATIVE_APP: "true"
  OSM_NATIVE_APP_DATABASE: OSM_GENERATOR_DB
  OSM_NATIVE_APP_SCHEMA: NATIVE_APP
  OSM_NATIVE_APP_PACKAGE_NAME: OSM_GENERATOR_PACKAGE
  OSM_NATIVE_APP_NAME: OSM_GENERATOR_APP
  OSM_NATIVE_APP_VERSION: V1_0
  ```

### **Native App Artifacts**
- **Directory**: `dataops/event/map-generator-native-app/`
- **Contents**:
  - `app/` - Application manifest and setup
  - `src/` - Core SQL functions and procedures
  - `streamlit/` - Interactive UI components

## 🚀 Deployment Process

### **Stage 1: Pipeline Initialization**
- Standard pipeline setup and validation
- Account readiness checks

### **Stage 2: Account Configuration**
- Attendee account setup
- Role and permission configuration

### **Stage 3: OSM Native App Deployment**
```sql
-- 1. Create database and schema
CREATE DATABASE OSM_GENERATOR_DB;
CREATE SCHEMA OSM_GENERATOR_DB.NATIVE_APP;

-- 2. Upload artifacts to stage
PUT file:///.../app/manifest.yml @OSM_GENERATOR_DB.NATIVE_APP.OSM_APP_STAGE/app/;
PUT file:///.../src/setup.sql @OSM_GENERATOR_DB.NATIVE_APP.OSM_APP_STAGE/src/;
PUT file:///.../streamlit/app.py @OSM_GENERATOR_DB.NATIVE_APP.OSM_APP_STAGE/streamlit/;

-- 3. Create external access integration
CREATE NETWORK RULE OSM_NETWORK_RULE ...;
CREATE EXTERNAL ACCESS INTEGRATION OSM_EXTERNAL_ACCESS ...;

-- 4. Create application package and instance
CREATE APPLICATION PACKAGE OSM_GENERATOR_PACKAGE ...;
CREATE APPLICATION OSM_GENERATOR_APP ...;

-- 5. Grant permissions and initialize
GRANT USAGE ON INTEGRATION OSM_EXTERNAL_ACCESS TO APPLICATION OSM_GENERATOR_APP;
ALTER APPLICATION OSM_GENERATOR_APP UPGRADE;
```

## 🔧 Configuration Variables

### **Core Application Settings**
| Variable | Default Value | Description |
|----------|---------------|-------------|
| `EVENT_DEPLOY_OSM_NATIVE_APP` | `"true"` | Enable/disable OSM app deployment |
| `OSM_NATIVE_APP_DATABASE` | `OSM_GENERATOR_DB` | Database for app artifacts |
| `OSM_NATIVE_APP_SCHEMA` | `NATIVE_APP` | Schema for app components |
| `OSM_NATIVE_APP_PACKAGE_NAME` | `OSM_GENERATOR_PACKAGE` | Application package name |
| `OSM_NATIVE_APP_NAME` | `OSM_GENERATOR_APP` | Application instance name |
| `OSM_NATIVE_APP_VERSION` | `V1_0` | Application version |

### **External Access Configuration**
The pipeline automatically configures external access to:
- `overpass-api.de:443` - OpenStreetMap data download
- `nominatim.openstreetmap.org:443` - City name geocoding
- `download.geofabrik.de:443` - Regional map extracts
- `extract.bbbike.org:443` - Custom area extracts

## 📊 Deployment Validation

The pipeline includes automatic validation steps:

### **Function Tests**
```sql
-- Test geocoding function
SELECT core.geocode_city('London, UK') as london_geocode_test;

-- Test preset areas function  
SELECT * FROM TABLE(core.get_preset_areas()) LIMIT 3;
```

### **Object Verification**
```sql
-- Show application objects
SHOW OBJECTS IN APPLICATION OSM_GENERATOR_APP;

-- Show Streamlit apps
SHOW STREAMLITS IN APPLICATION OSM_GENERATOR_APP;
```

### **Status Monitoring**
```sql
-- Check deployment status
SELECT * FROM OSM_GENERATOR_DB.NATIVE_APP.OSM_DEPLOYMENT_SUMMARY;
```

## 🎯 Usage After Deployment

### **Access Methods**

#### **1. Snowsight Interface**
- Navigate to **Data Products** → **Apps**
- Find **OSM_GENERATOR_APP**
- Open the Streamlit interface

#### **2. SQL Commands**
```sql
-- Generate map by city name
CALL OSM_GENERATOR_APP.core.generate_map('city', 
  PARSE_JSON('{"city_name": "London, UK", "output_filename": "london.osm"}')
);

-- Generate map by coordinates
CALL OSM_GENERATOR_APP.core.generate_map('bbox',
  PARSE_JSON('{"bbox": "-0.1778,51.4893,-0.0762,51.5279", "output_filename": "london.osm"}')
);

-- View generation history
SELECT * FROM OSM_GENERATOR_APP.core.map_generation_history;
```

#### **3. Usage Examples**
```sql
-- Get all usage examples
SELECT * FROM OSM_GENERATOR_DB.NATIVE_APP.OSM_APP_EXAMPLES;
```

## 🔍 Monitoring and Troubleshooting

### **Deployment Logs**
- Check GitLab CI/CD job logs for deployment status
- Review SQL execution logs in the pipeline artifacts

### **Application Health**
```sql
-- Check application status
SELECT * FROM OSM_GENERATOR_DB.NATIVE_APP.OSM_APP_STATUS;

-- View recent map generations
SELECT * FROM OSM_GENERATOR_APP.core.map_generation_history 
ORDER BY request_timestamp DESC LIMIT 10;
```

### **Common Issues**

#### **External Access Errors**
- Verify network rules are properly configured
- Check external access integration permissions
- Ensure account has external access capabilities

#### **Application Deployment Failures**
- Check ACCOUNTADMIN role permissions
- Verify all artifact files are uploaded correctly
- Review application package creation logs

#### **Function Execution Errors**
- Test external API connectivity
- Verify Python UDF permissions
- Check warehouse availability for Streamlit

## 🔄 Pipeline Customization

### **Conditional Deployment**
To disable OSM Native App deployment:
```yaml
EVENT_DEPLOY_OSM_NATIVE_APP: "false"
```

### **Custom Configuration**
Modify variables in `dataops/event/variables.yml`:
```yaml
OSM_NATIVE_APP_NAME: CUSTOM_OSM_APP_NAME
OSM_NATIVE_APP_VERSION: V2_0
```

### **Additional Features**
To add new features to the native app:
1. Update source files in `dataops/event/map-generator-native-app/`
2. Modify the SQL template if needed
3. Run the pipeline to deploy updates

## 📚 Integration Benefits

### **Automated Deployment**
- ✅ Consistent deployment across environments
- ✅ Version-controlled application artifacts
- ✅ Automated testing and validation
- ✅ Rollback capabilities through GitLab

### **Configuration Management**
- ✅ Templated SQL with environment variables
- ✅ Centralized configuration in variables.yml
- ✅ Environment-specific customization
- ✅ Secure credential management

### **Monitoring and Observability**
- ✅ Deployment status tracking
- ✅ Application health monitoring
- ✅ Usage analytics and history
- ✅ Error logging and troubleshooting

## 🎉 Next Steps

After successful pipeline deployment:

1. **Access the Application**: Open Snowsight → Apps → OSM_GENERATOR_APP
2. **Generate Test Maps**: Use the Streamlit interface to create sample maps
3. **Integrate with Workflows**: Use the SQL API in your data pipelines
4. **Monitor Usage**: Track map generations and performance metrics
5. **Customize as Needed**: Modify configuration for your specific requirements

---

**The OpenStreetMap Generator Native App is now fully integrated into your DataOps pipeline!** 🗺️✨
