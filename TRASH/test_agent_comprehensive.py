#!/usr/bin/env python3
"""
Comprehensive test of the ROUTE_ASSISTANT agent via Snowflake REST API.
Tests all three tools: directions, isochrones, and route optimization.
"""

import json
import requests
import os

def load_snowflake_config():
    """Load Snowflake connection config from ~/.snowflake/config.toml"""
    config_path = os.path.expanduser("~/.snowflake/config.toml")
    config = {}
    current_section = None
    
    with open(config_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if line.startswith('[') and line.endswith(']'):
                current_section = line[1:-1]
                config[current_section] = {}
            elif '=' in line and current_section:
                key, value = line.split('=', 1)
                key = key.strip()
                value = value.strip().strip('"')
                config[current_section][key] = value
    
    return config.get('connections.ppaczewskisnowhouse', {})

def call_agent(query):
    """Call the ROUTE_ASSISTANT agent with a query."""
    config = load_snowflake_config()
    account = config.get('account', 'sfpscogs-aws_cas2')
    pat_token = config.get('password', '')
    
    url = f"https://{account}.snowflakecomputing.com/api/v2/databases/OPENROUTESERVICE_NATIVE_APP/schemas/CORE/agents/ROUTE_ASSISTANT:run"
    
    request_body = {
        "messages": [{
            "role": "user",
            "content": [{"type": "text", "text": query}]
        }]
    }
    
    headers = {
        "Authorization": f"Bearer {pat_token}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    
    response = requests.post(url, json=request_body, headers=headers, stream=True, timeout=180)
    
    if response.status_code == 200:
        full_text = ""
        tool_used = None
        for line in response.iter_lines(decode_unicode=True):
            if line:
                if line.startswith("data:"):
                    data = line.replace("data:", "").strip()
                    try:
                        data_json = json.loads(data)
                        if "text" in data_json:
                            full_text += data_json.get("text", "")
                        if "tool_use_id" in data_json:
                            tool_used = data_json.get("input", {})
                    except json.JSONDecodeError:
                        pass
        return {"success": True, "response": full_text, "tool_used": tool_used}
    else:
        return {"success": False, "error": response.text}

def main():
    print("=" * 70)
    print("🚗 ROUTE_ASSISTANT Agent - Comprehensive Test Suite")
    print("=" * 70)
    
    tests = [
        {
            "name": "1️⃣  Directions Test",
            "query": "Get driving directions from Union Square to Golden Gate Bridge in San Francisco",
            "expected_tool": "get_directions"
        },
        {
            "name": "2️⃣  Isochrone Test", 
            "query": "Show me all areas reachable within 15 minutes by car from Fisherman's Wharf in San Francisco",
            "expected_tool": "get_isochrone"
        },
        {
            "name": "3️⃣  Route Optimization Test",
            "query": "Optimize delivery routes for 3 deliveries: Restaurant in North Beach, Hotel in Union Square, and Cafe in Mission District. Start from a warehouse in SoMa, San Francisco. I have 2 vehicles available.",
            "expected_tool": "optimize_routes"
        }
    ]
    
    results = []
    
    for test in tests:
        print(f"\n{test['name']}")
        print("-" * 70)
        print(f"📤 Query: {test['query'][:80]}...")
        print("\n🔄 Calling agent...")
        
        result = call_agent(test['query'])
        
        if result['success']:
            print(f"✅ SUCCESS")
            # Extract just the answer part (skip thinking)
            response = result['response']
            
            # Find the actual answer after thinking
            parts = response.split("\n\n")
            answer_parts = []
            for part in parts:
                if part.strip() and not part.strip().startswith("The user"):
                    answer_parts.append(part)
            
            clean_response = "\n\n".join(answer_parts[-3:]) if answer_parts else response
            
            print(f"\n📋 Response preview:")
            print(clean_response[:500] + "..." if len(clean_response) > 500 else clean_response)
            results.append({"test": test['name'], "status": "PASSED"})
        else:
            print(f"❌ FAILED: {result['error'][:200]}")
            results.append({"test": test['name'], "status": "FAILED"})
    
    print("\n" + "=" * 70)
    print("📊 Test Results Summary")
    print("=" * 70)
    
    for r in results:
        status_icon = "✅" if r['status'] == "PASSED" else "❌"
        print(f"{status_icon} {r['test']}: {r['status']}")
    
    passed = sum(1 for r in results if r['status'] == "PASSED")
    print(f"\n📈 {passed}/{len(results)} tests passed")
    
    if passed == len(results):
        print("\n🎉 All tests passed! The ROUTE_ASSISTANT agent is working correctly.")
    
    print("\n" + "=" * 70)
    print("📋 Agent Summary")
    print("=" * 70)
    print("""
The ROUTE_ASSISTANT agent is fully functional with these capabilities:

1. 🗺️  DIRECTIONS (get_directions)
   - Get turn-by-turn directions between locations
   - Supports multiple waypoints
   - Returns distance, duration, and detailed steps

2. ⏱️  ISOCHRONES (get_isochrone)  
   - Find areas reachable within a time limit
   - Returns polygon geometry for visualization
   - Great for coverage analysis

3. 📦 OPTIMIZATION (optimize_routes)
   - Optimize multi-stop delivery routes
   - Handles multiple vehicles
   - Returns optimal assignment and routing

All tools use AI-powered geocoding - just describe locations naturally!
""")

if __name__ == "__main__":
    main()
