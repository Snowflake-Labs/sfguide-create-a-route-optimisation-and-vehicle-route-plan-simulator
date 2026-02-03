#!/usr/bin/env python3
"""
Test script to validate Snowflake connection and data availability
"""

import sys
from pathlib import Path

def test_imports():
    """Test if required packages can be imported"""
    print("🔍 Testing package imports...")
    
    try:
        import streamlit
        print(f"  ✅ streamlit {streamlit.__version__}")
    except ImportError as e:
        print(f"  ❌ streamlit: {e}")
        return False
        
    try:
        from snowflake.snowpark import Session
        from snowflake.snowpark.functions import col
        print("  ✅ snowflake-snowpark-python")
    except ImportError as e:
        print(f"  ❌ snowflake-snowpark-python: {e}")
        return False
        
    try:
        import pandas
        print(f"  ✅ pandas {pandas.__version__}")
    except ImportError as e:
        print(f"  ❌ pandas: {e}")
        return False
        
    try:
        import pydeck
        print(f"  ✅ pydeck {pydeck.__version__}")
    except ImportError as e:
        print(f"  ❌ pydeck: {e}")
        return False
        
    return True

def test_config():
    """Test if Snowflake configuration exists and is valid"""
    print("\n🔍 Testing Snowflake configuration...")
    
    config_file = Path(__file__).parent / "snowflake_config.py"
    if not config_file.exists():
        print("  ❌ snowflake_config.py not found")
        print("  📝 Run: cp snowflake_config.template.py snowflake_config.py")
        return False
        
    try:
        sys.path.insert(0, str(config_file.parent))
        from snowflake_config import SNOWFLAKE_CONFIG
        
        required_keys = ['account', 'user', 'role', 'warehouse', 'database']
        missing_keys = [key for key in required_keys if key not in SNOWFLAKE_CONFIG]
        
        if missing_keys:
            print(f"  ❌ Missing required config keys: {missing_keys}")
            return False
            
        # Check if placeholder values are still there
        placeholder_values = ['your-account-identifier', 'your-username', 'your-password']
        for key, value in SNOWFLAKE_CONFIG.items():
            if str(value) in placeholder_values:
                print(f"  ⚠️ Placeholder value detected for '{key}': {value}")
                print("  📝 Please update snowflake_config.py with your actual credentials")
                return False
                
        print("  ✅ Configuration file looks valid")
        return True
        
    except ImportError as e:
        print(f"  ❌ Failed to import config: {e}")
        return False
    except Exception as e:
        print(f"  ❌ Configuration error: {e}")
        return False

def test_snowflake_connection():
    """Test actual connection to Snowflake"""
    print("\n🔍 Testing Snowflake connection...")
    
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from snowflake_config import SNOWFLAKE_CONFIG
        from snowflake.snowpark import Session
        
        print("  🔌 Attempting connection...")
        session = Session.builder.configs(SNOWFLAKE_CONFIG).create()
        
        # Test basic query
        result = session.sql("SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_DATABASE()").collect()
        
        print("  ✅ Connection successful!")
        print(f"    User: {result[0][0]}")
        print(f"    Role: {result[0][1]}")
        print(f"    Database: {result[0][2]}")
        
        session.close()
        return True
        
    except Exception as e:
        print(f"  ❌ Connection failed: {e}")
        print("\n  💡 Troubleshooting tips:")
        print("    - Verify your account identifier")
        print("    - Check username and password")
        print("    - Ensure your user has appropriate permissions")
        print("    - Check if your account allows connections from your IP")
        return False

def test_data_availability():
    """Test if required data tables are available"""
    print("\n🔍 Testing data table availability...")
    
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from snowflake_config import SNOWFLAKE_CONFIG
        from snowflake.snowpark import Session
        
        session = Session.builder.configs(SNOWFLAKE_CONFIG).create()
        
        # Test required tables
        tables = [
            'FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_DEPOTS',
            'FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_FLEET',
            'FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_DELIVERY_JOBS'
        ]
        
        all_tables_exist = True
        
        for table in tables:
            try:
                result = session.sql(f"SELECT COUNT(*) FROM {table}").collect()
                count = result[0][0]
                print(f"  ✅ {table}: {count} rows")
            except Exception as e:
                print(f"  ❌ {table}: {e}")
                all_tables_exist = False
        
        session.close()
        
        if not all_tables_exist:
            print("\n  💡 Some tables are missing. This might be because:")
            print("    - The lab deployment scripts haven't been run yet")
            print("    - Marketplace listings need to be installed")
            print("    - Database/schema configuration is different")
            
        return all_tables_exist
        
    except Exception as e:
        print(f"  ❌ Failed to test data availability: {e}")
        return False

def main():
    """Main test function"""
    print("🧪 NYC Beauty Supply Chain Optimizer - Connection Test")
    print("=" * 60)
    
    success = True
    
    # Run tests
    success &= test_imports()
    success &= test_config()
    success &= test_snowflake_connection()
    success &= test_data_availability()
    
    print("\n" + "=" * 60)
    
    if success:
        print("🎉 All tests passed! Your environment is ready.")
        print("🚀 Run: python run_local.py")
    else:
        print("❌ Some tests failed. Please review the issues above.")
        print("📖 See README.md for troubleshooting guidance.")
        
    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())
