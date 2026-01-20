"""
SF Taxi Fleet Intelligence - Streamlit Deployment Script

This script uploads the Streamlit application files to a Snowflake stage.
Run this before executing 08_deploy_streamlit.sql.

Usage:
    python deploy_streamlit.py --account <account> --user <user> --password <password>

Or set environment variables:
    SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD

Requirements:
    pip install snowflake-connector-python
"""

import os
import argparse
from pathlib import Path

try:
    import snowflake.connector
except ImportError:
    print("Error: snowflake-connector-python not installed")
    print("Run: pip install snowflake-connector-python")
    exit(1)


def get_connection(args):
    """Create Snowflake connection from args or environment variables."""
    return snowflake.connector.connect(
        account=args.account or os.environ.get('SNOWFLAKE_ACCOUNT'),
        user=args.user or os.environ.get('SNOWFLAKE_USER'),
        password=args.password or os.environ.get('SNOWFLAKE_PASSWORD'),
        warehouse=args.warehouse or os.environ.get('SNOWFLAKE_WAREHOUSE', 'COMPUTE_WH'),
        database='FLEET_INTELLIGENCE',
        schema='PUBLIC'
    )


def upload_files(conn, base_path: Path):
    """Upload Streamlit files to Snowflake stage."""
    cursor = conn.cursor()
    
    # Files to upload from the parent directory
    main_files = [
        'SF_Taxi_Control_Center.py',
        'extra.css',
        'logo.svg',
        'environment.yml'
    ]
    
    # Page files
    page_files = [
        'pages/1_Driver_Routes.py',
        'pages/2_Fleet_Heat_Map.py'
    ]
    
    stage_path = '@FLEET_INTELLIGENCE.PUBLIC.STREAMLIT_STAGE/sf_taxi'
    
    print("Uploading Streamlit files to Snowflake stage...")
    
    # Upload main files
    for filename in main_files:
        file_path = base_path.parent / filename
        if file_path.exists():
            cursor.execute(f"""
                PUT 'file://{file_path}' {stage_path}/ 
                AUTO_COMPRESS=FALSE OVERWRITE=TRUE
            """)
            print(f"  Uploaded: {filename}")
        else:
            print(f"  Warning: {filename} not found")
    
    # Upload page files
    for filename in page_files:
        file_path = base_path.parent / filename
        if file_path.exists():
            cursor.execute(f"""
                PUT 'file://{file_path}' {stage_path}/pages/ 
                AUTO_COMPRESS=FALSE OVERWRITE=TRUE
            """)
            print(f"  Uploaded: {filename}")
        else:
            print(f"  Warning: {filename} not found")
    
    cursor.close()
    print("\nUpload complete!")


def main():
    parser = argparse.ArgumentParser(
        description='Deploy Streamlit files to Snowflake stage'
    )
    parser.add_argument('--account', help='Snowflake account identifier')
    parser.add_argument('--user', help='Snowflake username')
    parser.add_argument('--password', help='Snowflake password')
    parser.add_argument('--warehouse', default='COMPUTE_WH', help='Warehouse to use')
    
    args = parser.parse_args()
    
    # Get the scripts directory path
    scripts_path = Path(__file__).parent
    
    try:
        conn = get_connection(args)
        upload_files(conn, scripts_path)
        conn.close()
        print("\nStreamlit files uploaded successfully!")
        print("Now run: 08_deploy_streamlit.sql")
    except Exception as e:
        print(f"Error: {e}")
        exit(1)


if __name__ == '__main__':
    main()
