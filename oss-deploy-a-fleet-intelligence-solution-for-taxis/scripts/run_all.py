"""
SF Taxi Fleet Intelligence - Master Deployment Script

This script runs all SQL scripts in order to set up the complete Fleet
Intelligence solution from scratch.

Usage:
    python run_all.py --account <account> --user <user> --password <password>

Or set environment variables:
    SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD

Requirements:
    pip install snowflake-connector-python
"""

import os
import argparse
import time
from pathlib import Path

try:
    import snowflake.connector
except ImportError:
    print("Error: snowflake-connector-python not installed")
    print("Run: pip install snowflake-connector-python")
    exit(1)


# SQL scripts to run in order
SQL_SCRIPTS = [
    ('01_setup_database.sql', 'Setting up database and schemas'),
    ('02_create_base_locations.sql', 'Creating base locations from Overture Maps'),
    ('03_create_drivers.sql', 'Creating 80 drivers with shift patterns'),
    ('04_create_trips.sql', 'Generating trips with varied counts'),
    ('05_generate_routes.sql', 'Generating ORS routes (this may take a few minutes)'),
    ('06_create_driver_locations.sql', 'Creating interpolated driver locations'),
    ('07_create_analytics_views.sql', 'Creating analytics views'),
]


def get_connection(args):
    """Create Snowflake connection from args or environment variables."""
    return snowflake.connector.connect(
        account=args.account or os.environ.get('SNOWFLAKE_ACCOUNT'),
        user=args.user or os.environ.get('SNOWFLAKE_USER'),
        password=args.password or os.environ.get('SNOWFLAKE_PASSWORD'),
        warehouse=args.warehouse or os.environ.get('SNOWFLAKE_WAREHOUSE', 'COMPUTE_WH'),
    )


def run_sql_file(conn, filepath: Path, description: str):
    """Execute a SQL file."""
    print(f"\n{'='*60}")
    print(f"Running: {filepath.name}")
    print(f"Description: {description}")
    print('='*60)
    
    with open(filepath, 'r') as f:
        sql_content = f.read()
    
    # Split by semicolons but handle edge cases
    statements = []
    current = []
    for line in sql_content.split('\n'):
        current.append(line)
        if line.strip().endswith(';'):
            statements.append('\n'.join(current))
            current = []
    
    cursor = conn.cursor()
    start_time = time.time()
    
    for i, stmt in enumerate(statements):
        stmt = stmt.strip()
        if not stmt or stmt.startswith('--'):
            continue
        
        try:
            cursor.execute(stmt)
            # Fetch results if any
            try:
                results = cursor.fetchall()
                if results and len(results) > 0:
                    # Print status messages
                    for row in results[-3:]:  # Last 3 rows
                        if row:
                            print(f"  {row}")
            except:
                pass
        except Exception as e:
            print(f"  Warning: {e}")
    
    elapsed = time.time() - start_time
    print(f"  Completed in {elapsed:.1f} seconds")
    cursor.close()


def main():
    parser = argparse.ArgumentParser(
        description='Run all Fleet Intelligence setup scripts'
    )
    parser.add_argument('--account', help='Snowflake account identifier')
    parser.add_argument('--user', help='Snowflake username')
    parser.add_argument('--password', help='Snowflake password')
    parser.add_argument('--warehouse', default='COMPUTE_WH', help='Warehouse to use')
    parser.add_argument('--skip-to', type=int, default=1, 
                        help='Skip to script number (1-7)')
    
    args = parser.parse_args()
    
    scripts_path = Path(__file__).parent
    
    print("="*60)
    print("SF Taxi Fleet Intelligence - Setup")
    print("="*60)
    
    try:
        conn = get_connection(args)
        print(f"Connected to Snowflake")
        
        for i, (script, description) in enumerate(SQL_SCRIPTS, 1):
            if i < args.skip_to:
                print(f"\nSkipping: {script}")
                continue
                
            filepath = scripts_path / script
            if filepath.exists():
                run_sql_file(conn, filepath, description)
            else:
                print(f"\nWarning: {script} not found")
        
        conn.close()
        
        print("\n" + "="*60)
        print("Setup complete!")
        print("="*60)
        print("\nNext steps:")
        print("1. Run: python deploy_streamlit.py")
        print("2. Run: 08_deploy_streamlit.sql in Snowflake")
        print("3. Open the Streamlit app in Snowsight")
        
    except Exception as e:
        print(f"\nError: {e}")
        exit(1)


if __name__ == '__main__':
    main()
