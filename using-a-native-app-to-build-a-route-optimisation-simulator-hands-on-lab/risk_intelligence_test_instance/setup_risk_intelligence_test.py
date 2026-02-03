#!/usr/bin/env python3
"""
Risk Intelligence Test Instance Setup Script
Sets up and configures the Risk Intelligence native app test environment
"""

import sys
import os
import snowflake.connector
from snowflake.connector import DictCursor

# Add the current directory to Python path to import config
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

try:
    from snowflake_config import SNOWFLAKE_CONFIG, RISK_INTELLIGENCE_CONFIG, DATA_SOURCES
    print("✅ Configuration loaded successfully")
except ImportError:
    print("❌ Error: snowflake_config.py not found!")
    print("Please copy snowflake_config.template.py to snowflake_config.py and fill in your credentials")
    sys.exit(1)

def create_risk_intelligence_application():
    """Create Risk Intelligence application from package"""
    print("\n📱 Creating Risk Intelligence Application...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        app_name = RISK_INTELLIGENCE_CONFIG['application_name']
        
        # Check if application already exists
        cursor.execute("SHOW APPLICATIONS")
        applications = cursor.fetchall()
        
        existing_app = None
        for app in applications:
            if app['name'] == app_name:
                existing_app = app
                break
        
        if existing_app:
            print(f"✅ Application {app_name} already exists")
            print(f"   Version: {existing_app.get('version', 'Unknown')}")
            print(f"   Status: {existing_app.get('status', 'Unknown')}")
        else:
            # Create application from package
            print(f"Creating application {app_name} from package...")
            cursor.execute(f"""
                CREATE APPLICATION IF NOT EXISTS {app_name}
                FROM APPLICATION PACKAGE RISK_INTELLIGENCE_PACKAGE
                COMMENT = 'Risk Intelligence test instance'
            """)
            print(f"✅ Application {app_name} created successfully")
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Error creating application: {str(e)}")
        return False

def grant_application_roles():
    """Grant Risk Intelligence application roles to current user"""
    print("\n👥 Granting Application Roles...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        app_name = RISK_INTELLIGENCE_CONFIG['application_name']
        current_role = SNOWFLAKE_CONFIG['role']
        
        # Grant analyst role
        analyst_role = f"{app_name}.{RISK_INTELLIGENCE_CONFIG['analyst_role']}"
        try:
            cursor.execute(f"GRANT APPLICATION ROLE {analyst_role} TO ROLE {current_role}")
            print(f"✅ Granted {analyst_role} to {current_role}")
        except Exception as e:
            print(f"⚠️  Could not grant {analyst_role}: {str(e)}")
        
        # Grant admin role
        admin_role = f"{app_name}.{RISK_INTELLIGENCE_CONFIG['admin_role']}"
        try:
            cursor.execute(f"GRANT APPLICATION ROLE {admin_role} TO ROLE {current_role}")
            print(f"✅ Granted {admin_role} to {current_role}")
        except Exception as e:
            print(f"⚠️  Could not grant {admin_role}: {str(e)}")
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Error granting application roles: {str(e)}")
        return False

def verify_data_access():
    """Verify access to Risk Intelligence data"""
    print("\n📊 Verifying Data Access...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        app_name = RISK_INTELLIGENCE_CONFIG['application_name']
        
        # Check flood risk data
        try:
            cursor.execute(f"SELECT COUNT(*) as count FROM {app_name}.FLOOD_RISK.UK_STORMS")
            result = cursor.fetchone()
            print(f"✅ Flood risk data: {result['COUNT']} UK storms records")
        except Exception as e:
            print(f"❌ Flood risk data access issue: {str(e)}")
        
        # Check wildfire risk data
        try:
            cursor.execute(f"SELECT COUNT(*) as count FROM {app_name}.WILDFIRE_RISK.CUSTOMER_DETAILS")
            result = cursor.fetchone()
            print(f"✅ Wildfire risk data: {result['COUNT']} customer records")
        except Exception as e:
            print(f"❌ Wildfire risk data access issue: {str(e)}")
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Error verifying data access: {str(e)}")
        return False

def list_streamlit_apps():
    """List available Streamlit applications"""
    print("\n🖥️  Available Streamlit Applications...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        app_name = RISK_INTELLIGENCE_CONFIG['application_name']
        
        # List Streamlit apps
        cursor.execute(f"SHOW STREAMLITS IN APPLICATION {app_name}")
        streamlits = cursor.fetchall()
        
        if streamlits:
            print("Available Streamlit applications:")
            for streamlit in streamlits:
                schema = streamlit['schema_name']
                name = streamlit['name']
                url_id = streamlit.get('url_id', 'N/A')
                print(f"   📱 {schema}.{name}")
                if url_id != 'N/A':
                    print(f"      URL ID: {url_id}")
        else:
            print("❌ No Streamlit applications found")
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Error listing Streamlit apps: {str(e)}")
        return False

def create_test_queries():
    """Create some test queries for validation"""
    print("\n🧪 Sample Test Queries...")
    
    app_name = RISK_INTELLIGENCE_CONFIG['application_name']
    
    queries = [
        f"-- Check flood risk areas\nSELECT COUNT(*) FROM {app_name}.FLOOD_RISK.FLOOD_AREAS;",
        f"-- Check wildfire infrastructure risk\nSELECT COUNT(*) FROM {app_name}.WILDFIRE_RISK.INFRASTRUCTURE_RISK;",
        f"-- Application information\nSELECT * FROM {app_name}.SHARED_RESOURCES.APPLICATION_INFO;",
        f"-- Recent UK storms\nSELECT NAME, DATES, UK_FATALITIES FROM {app_name}.FLOOD_RISK.UK_STORMS ORDER BY DATES DESC LIMIT 5;"
    ]
    
    print("Sample queries to test your Risk Intelligence application:")
    for i, query in enumerate(queries, 1):
        print(f"\n{i}. {query}")
    
    return True

def main():
    """Main setup function"""
    print("🚀 Risk Intelligence Test Instance Setup")
    print("=" * 50)
    
    setup_steps = [
        ("Create Risk Intelligence Application", create_risk_intelligence_application),
        ("Grant Application Roles", grant_application_roles),
        ("Verify Data Access", verify_data_access),
        ("List Streamlit Apps", list_streamlit_apps),
        ("Create Test Queries", create_test_queries)
    ]
    
    results = []
    for step_name, step_func in setup_steps:
        print(f"\n🔄 {step_name}...")
        try:
            result = step_func()
            results.append((step_name, result))
        except Exception as e:
            print(f"❌ {step_name} failed with exception: {str(e)}")
            results.append((step_name, False))
    
    # Summary
    print("\n📋 Setup Results Summary")
    print("=" * 50)
    
    passed = 0
    for step_name, result in results:
        status = "✅ SUCCESS" if result else "❌ FAILED"
        print(f"{status} - {step_name}")
        if result:
            passed += 1
    
    print(f"\nOverall: {passed}/{len(results)} steps completed successfully")
    
    if passed == len(results):
        print("\n🎉 Risk Intelligence test instance setup complete!")
        print(f"\nNext steps:")
        print(f"1. Access Streamlit apps through Snowflake UI")
        print(f"2. Navigate to Applications → {RISK_INTELLIGENCE_CONFIG['application_name']}")
        print(f"3. Use the sample queries above to test data access")
        print(f"4. Run test_risk_intelligence_connection.py to validate setup")
    else:
        print("\n⚠️  Some setup steps failed. Please check the errors above.")

if __name__ == "__main__":
    main()
