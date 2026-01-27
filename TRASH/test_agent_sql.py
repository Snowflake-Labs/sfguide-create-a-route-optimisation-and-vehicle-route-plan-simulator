#!/usr/bin/env python3
"""
Test the ROUTE_ASSISTANT agent via Snowflake REST API.
"""

import json
import subprocess
import os

def run_snow_sql(query):
    """Execute SQL via snow CLI and return result."""
    result = subprocess.run(
        ['snow', 'sql', '-q', query, '-c', 'ppaczewskisnowhouse', '-o', 'output_format=json'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except:
        return result.stdout

def test_agent():
    """Test the ROUTE_ASSISTANT agent."""
    
    print("=" * 70)
    print("🚗 ROUTE_ASSISTANT Agent Test")
    print("=" * 70)
    
    # Test query
    test_query = "Get driving directions from Union Square to Golden Gate Bridge in San Francisco"
    
    # Build the agent request JSON
    agent_request = json.dumps({
        "agent": "OPENROUTESERVICE_NATIVE_APP.CORE.ROUTE_ASSISTANT",
        "messages": [{
            "role": "user", 
            "content": [{"type": "text", "text": test_query}]
        }]
    })
    
    print(f"\n📤 Sending query to agent:")
    print(f"   '{test_query}'")
    print("-" * 70)
    
    # Call agent via SQL
    sql = f"SELECT SNOWFLAKE.CORTEX.AGENT_PREVIEW('{agent_request}')"
    
    result = run_snow_sql(sql)
    
    if result:
        print(f"\n📥 Agent Response:")
        print(json.dumps(result, indent=2) if isinstance(result, (dict, list)) else result)
    else:
        print("\n⚠️ No response from agent via SQL function")
        print("\nNote: The agent may need to be invoked via:")
        print("  1. Snowsight UI: AI & ML → Agents → Route Assistant")
        print("  2. REST API: POST /api/v2/databases/.../agents/ROUTE_ASSISTANT:run")

if __name__ == "__main__":
    test_agent()
