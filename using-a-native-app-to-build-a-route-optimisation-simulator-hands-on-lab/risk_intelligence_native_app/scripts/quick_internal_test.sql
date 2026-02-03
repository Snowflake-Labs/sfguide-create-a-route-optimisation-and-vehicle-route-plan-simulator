-- Risk Intelligence - Quick Internal Test Setup
-- Fast deployment for testing the internal marketplace version

USE ROLE ACCOUNTADMIN;

-- ===== QUICK TEST DEPLOYMENT =====

-- 1. Create test application package
CREATE APPLICATION PACKAGE IF NOT EXISTS RISK_INTELLIGENCE_TEST_PKG
    COMMENT = 'Test package for Risk Intelligence internal marketplace';

-- 2. Create test stage
CREATE STAGE IF NOT EXISTS RISK_INTELLIGENCE_TEST_PKG.TEST_STAGE;

-- 3. Create minimal manifest for testing
CREATE OR REPLACE FILE RISK_INTELLIGENCE_TEST_PKG.TEST_STAGE/manifest.yml AS
$$
manifest_version: 1
version:
  name: "1.0.0-test"
  label: "Risk Intelligence Test"
artifacts:
  setup_script: setup_test.sql
  readme: README.md
privileges:
  - CREATE DATABASE
  - CREATE SCHEMA
  - CREATE TABLE
  - CREATE VIEW
  - CREATE STREAMLIT
application_roles:
  - name: TEST_USER
    label: "Test User"
$$;

-- 4. Create minimal setup script for testing
CREATE OR REPLACE FILE RISK_INTELLIGENCE_TEST_PKG.TEST_STAGE/setup_test.sql AS
$$
-- Test setup for Risk Intelligence
CREATE APPLICATION ROLE IF NOT EXISTS TEST_USER;
CREATE SCHEMA IF NOT EXISTS RISK_DATA;
CREATE WAREHOUSE IF NOT EXISTS TEST_WH WAREHOUSE_SIZE='XSMALL' AUTO_SUSPEND=60;

-- Create test table
CREATE TABLE IF NOT EXISTS RISK_DATA.TEST_RISKS (
    risk_id NUMBER,
    risk_type STRING,
    severity STRING,
    location STRING,
    assessment_date DATE
);

-- Insert test data
INSERT INTO RISK_DATA.TEST_RISKS VALUES
    (1, 'Flood', 'High', 'London', CURRENT_DATE()),
    (2, 'Wildfire', 'Medium', 'California', CURRENT_DATE()),
    (3, 'Flood', 'Low', 'Manchester', CURRENT_DATE());

-- Grant permissions
GRANT USAGE ON SCHEMA RISK_DATA TO APPLICATION ROLE TEST_USER;
GRANT SELECT ON ALL TABLES IN SCHEMA RISK_DATA TO APPLICATION ROLE TEST_USER;
GRANT USAGE ON WAREHOUSE TEST_WH TO APPLICATION ROLE TEST_USER;
$$;

-- 5. Create README for test
CREATE OR REPLACE FILE RISK_INTELLIGENCE_TEST_PKG.TEST_STAGE/README.md AS
$$
# Risk Intelligence Test Version
This is a minimal test version for validating the internal marketplace deployment.

## Test Features
- Basic risk data table
- Simple test data
- Minimal permissions

## Usage
```sql
SELECT * FROM RISK_DATA.TEST_RISKS;
```
$$;

-- 6. Create package version
ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_TEST_PKG 
    ADD VERSION test_v1 USING '@RISK_INTELLIGENCE_TEST_PKG.TEST_STAGE';

ALTER APPLICATION PACKAGE RISK_INTELLIGENCE_TEST_PKG 
    SET DEFAULT RELEASE DIRECTIVE VERSION = test_v1 PATCH = 0;

-- 7. Create test application
CREATE APPLICATION IF NOT EXISTS RISK_INTELLIGENCE_TEST_APP
    FROM APPLICATION PACKAGE RISK_INTELLIGENCE_TEST_PKG;

-- 8. Grant test role
GRANT APPLICATION ROLE RISK_INTELLIGENCE_TEST_APP.TEST_USER TO ROLE SYSADMIN;

-- ===== VERIFICATION =====

-- Test the application
USE APPLICATION RISK_INTELLIGENCE_TEST_APP;
SELECT * FROM RISK_DATA.TEST_RISKS;

-- Check application status
SHOW APPLICATIONS LIKE 'RISK_INTELLIGENCE_TEST_APP';

-- Verify roles
SHOW APPLICATION ROLES IN APPLICATION RISK_INTELLIGENCE_TEST_APP;

-- ===== CLEANUP (Optional) =====
-- Uncomment to clean up test resources

-- DROP APPLICATION IF EXISTS RISK_INTELLIGENCE_TEST_APP;
-- DROP APPLICATION PACKAGE IF EXISTS RISK_INTELLIGENCE_TEST_PKG;

-- ===== SUCCESS MESSAGE =====
SELECT 
    'Risk Intelligence test deployment successful!' AS STATUS,
    'Application: RISK_INTELLIGENCE_TEST_APP' AS APP_NAME,
    'Test query: SELECT * FROM RISK_DATA.TEST_RISKS' AS TEST_COMMAND,
    'Ready for full internal marketplace deployment' AS NEXT_STEP;
