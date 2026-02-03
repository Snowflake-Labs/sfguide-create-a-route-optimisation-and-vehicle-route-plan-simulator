# Copy this file to snowflake_config.py and fill in your Snowflake connection details
# DO NOT commit snowflake_config.py to git - add it to .gitignore

SNOWFLAKE_CONFIG = {
    'account': 'SFSEHOL-TEST_FLEET_INTELLIGENCE_V3_AGSNWH',
    'user': 'your-username', 
    'password': 'your-password',
    'role': 'your-role',
    'warehouse': 'your-warehouse',
    'database': 'your-database',
    'schema': 'your-schema'
}

# Alternative: Use key pair authentication (recommended for security)
# SNOWFLAKE_CONFIG = {
#     'account': 'SFSEHOL-TEST_FLEET_INTELLIGENCE_V3_AGSNWH',
#     'user': 'your-username',
#     'private_key_path': '/path/to/your/private_key.p8',
#     'role': 'your-role',
#     'warehouse': 'your-warehouse', 
#     'database': 'your-database',
#     'schema': 'your-schema'
# }
