# Risk Intelligence Native App Test Instance Configuration
# Copy this file to snowflake_config.py and fill in your Snowflake connection details
# DO NOT commit snowflake_config.py to git - add it to .gitignore

SNOWFLAKE_CONFIG = {
    'account': 'SFSEHOL-TEST_RISK_NATIVE_APP_EZCXJH',
    'user': 'your-username',  # Same as fleet-intelligence-changes credentials
    'password': 'your-password',  # Same as fleet-intelligence-changes credentials
    'role': 'ATTENDEE_ROLE',  # Or your appropriate role for this test account
    'warehouse': 'DEFAULT_WH',  # Or EVENT_WAREHOUSE
    'database': 'RISK_INTELLIGENCE_DEMO',  # The demo app created by attendee setup
    'schema': 'FLOOD_RISK'  # Default to flood risk schema
}

# Alternative: Use key pair authentication (recommended for security)
# SNOWFLAKE_CONFIG = {
#     'account': 'SFSEHOL-TEST_RISK_NATIVE_APP_EZCXJH',
#     'user': 'your-username',
#     'private_key_path': '/path/to/your/private_key.p8',
#     'role': 'ATTENDEE_ROLE',
#     'warehouse': 'DEFAULT_WH',
#     'database': 'RISK_INTELLIGENCE_DEMO',
#     'schema': 'FLOOD_RISK'
# }

# Risk Intelligence Application Configuration
RISK_INTELLIGENCE_CONFIG = {
    'application_name': 'RISK_INTELLIGENCE_DEMO',
    'flood_risk_schema': 'FLOOD_RISK',
    'wildfire_risk_schema': 'WILDFIRE_RISK',
    'shared_resources_schema': 'SHARED_RESOURCES',
    'analyst_role': 'RISK_ANALYST',
    'admin_role': 'RISK_ADMIN'
}

# Data Source Configuration (for testing with attendee setup data)
DATA_SOURCES = {
    'uk_storms_db': 'UK_STORMS_DB',
    'wildfires_db': 'WILDFIRES_DB',
    'fleet_intelligence_db': 'FLEET_INTELLIGENCE'
}
