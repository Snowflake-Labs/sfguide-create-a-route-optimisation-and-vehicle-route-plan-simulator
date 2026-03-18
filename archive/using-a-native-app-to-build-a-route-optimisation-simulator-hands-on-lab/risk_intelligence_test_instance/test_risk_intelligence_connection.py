#!/usr/bin/env python3
"""
Risk Intelligence Native App Test Connection Script
Tests connection to the Risk Intelligence test account and validates native app setup
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

def test_basic_connection():
    """Test basic Snowflake connection"""
    print("\n🔗 Testing basic Snowflake connection...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        # Test basic query
        cursor.execute("SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE(), CURRENT_DATABASE()")
        result = cursor.fetchone()
        
        print(f"✅ Connected successfully!")
        print(f"   User: {result['CURRENT_USER()']}")
        print(f"   Role: {result['CURRENT_ROLE()']}")
        print(f"   Warehouse: {result['CURRENT_WAREHOUSE()']}")
        print(f"   Database: {result['CURRENT_DATABASE()']}")
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Connection failed: {str(e)}")
        return False

def test_risk_intelligence_app():
    """Test Risk Intelligence native app availability"""
    print("\n📱 Testing Risk Intelligence Native App...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        app_name = RISK_INTELLIGENCE_CONFIG['application_name']
        
        # Check if application exists
        cursor.execute("SHOW APPLICATIONS")
        applications = cursor.fetchall()
        
        risk_app = None
        for app in applications:
            if app['name'] == app_name:
                risk_app = app
                break
        
        if risk_app:
            print(f"✅ Risk Intelligence application found: {app_name}")
            print(f"   Version: {risk_app.get('version', 'Unknown')}")
            print(f"   Status: {risk_app.get('status', 'Unknown')}")
        else:
            print(f"❌ Risk Intelligence application not found: {app_name}")
            print("Available applications:")
            for app in applications:
                print(f"   - {app['name']}")
            return False
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Error checking applications: {str(e)}")
        return False

def test_application_roles():
    """Test Risk Intelligence application roles"""
    print("\n👥 Testing Risk Intelligence Application Roles...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        app_name = RISK_INTELLIGENCE_CONFIG['application_name']
        
        # Check application roles
        cursor.execute(f"SHOW APPLICATION ROLES IN APPLICATION {app_name}")
        roles = cursor.fetchall()
        
        expected_roles = [RISK_INTELLIGENCE_CONFIG['analyst_role'], RISK_INTELLIGENCE_CONFIG['admin_role']]
        
        print(f"Available application roles in {app_name}:")
        for role in roles:
            role_name = role['name']
            print(f"   - {role_name}")
            if role_name in expected_roles:
                print(f"     ✅ Expected role found")
            
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Error checking application roles: {str(e)}")
        return False

def test_streamlit_apps():
    """Test Risk Intelligence Streamlit applications"""
    print("\n🖥️  Testing Risk Intelligence Streamlit Apps...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        app_name = RISK_INTELLIGENCE_CONFIG['application_name']
        
        # Check Streamlit apps in the application
        cursor.execute(f"SHOW STREAMLITS IN APPLICATION {app_name}")
        streamlits = cursor.fetchall()
        
        expected_apps = [
            "UK Flood Risk Assessment",
            "California Wildfire Risk Assessment"
        ]
        
        print(f"Available Streamlit apps in {app_name}:")
        found_apps = []
        for streamlit in streamlits:
            app_title = streamlit['name']
            schema = streamlit['schema_name']
            print(f"   - {schema}.{app_title}")
            found_apps.append(app_title)
        
        for expected_app in expected_apps:
            if expected_app in found_apps:
                print(f"     ✅ {expected_app} found")
            else:
                print(f"     ❌ {expected_app} missing")
        
        cursor.close()
        conn.close()
        return len(found_apps) > 0
        
    except Exception as e:
        print(f"❌ Error checking Streamlit apps: {str(e)}")
        return False

def test_data_sources():
    """Test access to data sources"""
    print("\n📊 Testing Data Source Access...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        app_name = RISK_INTELLIGENCE_CONFIG['application_name']
        
        # Test flood risk data
        try:
            cursor.execute(f"SELECT COUNT(*) as count FROM {app_name}.FLOOD_RISK.UK_STORMS")
            result = cursor.fetchone()
            print(f"✅ Flood risk data accessible: {result['COUNT']} UK storms records")
        except Exception as e:
            print(f"❌ Flood risk data access failed: {str(e)}")
        
        # Test wildfire risk data
        try:
            cursor.execute(f"SELECT COUNT(*) as count FROM {app_name}.WILDFIRE_RISK.CUSTOMER_DETAILS")
            result = cursor.fetchone()
            print(f"✅ Wildfire risk data accessible: {result['COUNT']} customer records")
        except Exception as e:
            print(f"❌ Wildfire risk data access failed: {str(e)}")
        
        # Test application info
        try:
            cursor.execute(f"SELECT * FROM {app_name}.SHARED_RESOURCES.APPLICATION_INFO")
            result = cursor.fetchone()
            print(f"✅ Application info accessible:")
            print(f"   App Name: {result['APP_NAME']}")
            print(f"   Version: {result['VERSION']}")
            print(f"   Installed: {result['INSTALLED_AT']}")
        except Exception as e:
            print(f"❌ Application info access failed: {str(e)}")
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Error testing data sources: {str(e)}")
        return False

def test_original_data_sources():
    """Test access to original data sources (UK_STORMS_DB, WILDFIRES_DB)"""
    print("\n🗄️  Testing Original Data Sources...")
    
    try:
        conn = snowflake.connector.connect(**SNOWFLAKE_CONFIG)
        cursor = conn.cursor(DictCursor)
        
        # Test UK_STORMS_DB
        try:
            cursor.execute("SELECT COUNT(*) as count FROM UK_STORMS_DB.PUBLIC.UK_STORMS")
            result = cursor.fetchone()
            print(f"✅ UK_STORMS_DB accessible: {result['COUNT']} records")
        except Exception as e:
            print(f"❌ UK_STORMS_DB access failed: {str(e)}")
        
        # Test WILDFIRES_DB
        try:
            cursor.execute("SELECT COUNT(*) as count FROM WILDFIRES_DB.PUBLIC.CUSTOMER_LOYALTY_DETAILS")
            result = cursor.fetchone()
            print(f"✅ WILDFIRES_DB accessible: {result['COUNT']} records")
        except Exception as e:
            print(f"❌ WILDFIRES_DB access failed: {str(e)}")
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Error testing original data sources: {str(e)}")
        return False

def main():
    """Run all tests"""
    print("🧪 Risk Intelligence Native App Test Suite")
    print("=" * 50)
    
    tests = [
        ("Basic Connection", test_basic_connection),
        ("Risk Intelligence App", test_risk_intelligence_app),
        ("Application Roles", test_application_roles),
        ("Streamlit Apps", test_streamlit_apps),
        ("Data Sources", test_data_sources),
        ("Original Data Sources", test_original_data_sources)
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            result = test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"❌ {test_name} failed with exception: {str(e)}")
            results.append((test_name, False))
    
    # Summary
    print("\n📋 Test Results Summary")
    print("=" * 50)
    
    passed = 0
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {test_name}")
        if result:
            passed += 1
    
    print(f"\nOverall: {passed}/{len(results)} tests passed")
    
    if passed == len(results):
        print("\n🎉 All tests passed! Risk Intelligence test instance is ready!")
    else:
        print("\n⚠️  Some tests failed. Please check the configuration and setup.")

if __name__ == "__main__":
    main()
