#!/usr/bin/env python3
"""
Upload minimal environment.yml following sfguide pattern exactly
"""

import snowflake.connector

def upload_minimal_env():
    try:
        conn = snowflake.connector.connect(
            account='SFSEHOL-DRY_RUN_FLEET_INTELLIGENCE_NOV_BDTTVY',
            user='user',
            password='sn0wf@ll',
            role='ACCOUNTADMIN',
            warehouse='DEFAULT_WH',
            database='OSM_GENERATOR_DB',
            schema='NATIVE_APP'
        )
        
        cursor = conn.cursor()
        
        # Read the minimal environment.yml
        with open('minimal_environment.yml', 'r') as f:
            env_content = f.read()
        
        print("Uploading minimal environment.yml (following sfguide pattern)...")
        print("Content:")
        print(env_content)
        
        # Remove the old file
        cursor.execute("REMOVE @OSM_APP_STAGE/app/streamlit/environment.yml")
        
        # Upload as raw content
        cursor.execute("CREATE OR REPLACE TEMPORARY TABLE temp_minimal_env (content STRING)")
        cursor.execute("INSERT INTO temp_minimal_env VALUES (%s)", (env_content,))
        
        cursor.execute("""
            COPY INTO @OSM_APP_STAGE/app/streamlit/environment.yml
            FROM (SELECT content FROM temp_minimal_env)
            FILE_FORMAT = (TYPE = 'CSV' FIELD_OPTIONALLY_ENCLOSED_BY = NONE ESCAPE_UNENCLOSED_FIELD = NONE RECORD_DELIMITER = NONE)
            SINGLE = TRUE
            OVERWRITE = TRUE
        """)
        
        print("✅ Minimal environment.yml uploaded!")
        
        # Verify the content looks correct
        cursor.execute("SELECT $1 FROM @OSM_APP_STAGE/app/streamlit/environment.yml")
        results = cursor.fetchall()
        print("✅ Verification:")
        for row in results:
            print(f"  {repr(row[0])}")
            
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ Upload failed: {e}")

if __name__ == "__main__":
    upload_minimal_env()
