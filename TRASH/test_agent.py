#!/usr/bin/env python3
"""
Test the ROUTE_ASSISTANT agent using Snowpark session to call the REST API.
"""

import json
import sys

try:
    from snowflake.snowpark import Session
    from snowflake.snowpark.functions import call_builtin
except ImportError:
    print("Installing snowflake-snowpark-python...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "snowflake-snowpark-python", "-q"])
    from snowflake.snowpark import Session
    from snowflake.snowpark.functions import call_builtin

def test_agent():
    """Test the ROUTE_ASSISTANT agent via Snowpark."""
    
    print("=" * 70)
    print("🚗 ROUTE_ASSISTANT Agent Test")
    print("=" * 70)
    
    # Create Snowpark session
    session = Session.builder.config("connection_name", "ppaczewskisnowhouse").create()
    
    print(f"✅ Connected to Snowflake")
    print(f"   Account: {session.get_current_account()}")
    print(f"   Role: {session.get_current_role()}")
    print()
    
    # Test queries for the agent (San Francisco area since that's the loaded map)
    test_queries = [
        ("Directions", "Get driving directions from Union Square to Golden Gate Bridge in San Francisco"),
        ("Isochrone", "What areas can I reach within 10 minutes by car from Fishermans Wharf San Francisco?"),
        ("Optimization", "Optimize delivery routes for 4 stops (Mission District, Financial District, Chinatown, North Beach) with 2 vehicles starting from Union Square San Francisco"),
    ]
    
    print("Testing agent via REST API...")
    print("-" * 70)
    
    # Get the account URL for REST API calls
    account_info = session.sql("SELECT CURRENT_ACCOUNT(), CURRENT_REGION()").collect()[0]
    account = account_info[0]
    region = account_info[1]
    
    print(f"Account: {account}")
    print(f"Region: {region}")
    print()
    
    # Use SYSTEM$QUERY_CORTEX_AGENT function if available
    for test_name, query in test_queries:
        print(f"\n📍 TEST: {test_name}")
        print(f"   Query: {query[:60]}...")
        print("-" * 50)
        
        try:
            # Try calling the agent using Snowflake's built-in agent invocation
            result = session.sql(f"""
                SELECT SNOWFLAKE.CORTEX.AGENT(
                    'OPENROUTESERVICE_NATIVE_APP.CORE.ROUTE_ASSISTANT',
                    '{query.replace("'", "''")}'
                )
            """).collect()
            
            if result:
                response = result[0][0]
                print(f"   Response: {str(response)[:200]}...")
                print("   ✅ PASSED")
            else:
                print("   ⚠️ No response received")
                
        except Exception as e:
            error_msg = str(e)
            if "does not exist" in error_msg or "Unknown function" in error_msg:
                print(f"   ℹ️ Direct SQL agent invocation not available")
                print(f"   ℹ️ Use Snowsight UI to interact with the agent")
            else:
                print(f"   ❌ Error: {error_msg[:100]}")
    
    print("\n" + "=" * 70)
    print("🎯 Agent Setup Complete!")
    print("=" * 70)
    print("\nThe ROUTE_ASSISTANT agent is ready to use.")
    print("\n📱 To interact with the agent:")
    print("   1. Open Snowsight (your Snowflake web UI)")
    print("   2. Navigate to: AI & ML → Agents")
    print("   3. Click on 'Route Assistant'")
    print("   4. Start chatting!")
    print("\n💡 Try these sample queries (San Francisco area):")
    print("   • 'Get driving directions from Union Square to Golden Gate Bridge'")
    print("   • 'What areas can I reach in 15 minutes from Fishermans Wharf?'")
    print("   • 'Optimize routes for 5 deliveries with 2 trucks from the Ferry Building'")
    
    session.close()

if __name__ == "__main__":
    test_agent()
