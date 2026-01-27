#!/usr/bin/env python3
"""
Test the ROUTE_ASSISTANT agent via Snowflake REST API using Python requests.
"""

import json
import requests
import os
import configparser
import base64

def load_snowflake_config():
    """Load Snowflake connection config from ~/.snowflake/config.toml"""
    config_path = os.path.expanduser("~/.snowflake/config.toml")
    
    # Read the TOML file manually (simple parser)
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

def test_agent():
    """Test the ROUTE_ASSISTANT agent via REST API."""
    
    print("=" * 70)
    print("🚗 ROUTE_ASSISTANT Agent Test via REST API")
    print("=" * 70)
    
    # Load config
    config = load_snowflake_config()
    account = config.get('account', 'sfpscogs-aws_cas2')
    pat_token = config.get('password', '')
    
    # Build the base URL
    base_url = f"https://{account}.snowflakecomputing.com"
    endpoint = "/api/v2/databases/OPENROUTESERVICE_NATIVE_APP/schemas/CORE/agents/ROUTE_ASSISTANT:run"
    url = f"{base_url}{endpoint}"
    
    print(f"\n🔗 Endpoint: {url}")
    
    # Test query
    test_query = "Get driving directions from Union Square to Golden Gate Bridge in San Francisco"
    
    print(f"\n📤 Sending query to agent:")
    print(f"   '{test_query}'")
    print("-" * 70)
    
    # Build the request body
    request_body = {
        "messages": [{
            "role": "user",
            "content": [{
                "type": "text",
                "text": test_query
            }]
        }]
    }
    
    print(f"\n📝 Request body:")
    print(json.dumps(request_body, indent=2))
    
    # Headers
    headers = {
        "Authorization": f"Bearer {pat_token}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    
    print("\n🔄 Sending request to agent...")
    print("-" * 70)
    
    try:
        # Make the request with streaming for SSE
        response = requests.post(
            url,
            json=request_body,
            headers=headers,
            stream=True,
            timeout=120
        )
        
        print(f"\n📥 Response Status: {response.status_code}")
        
        if response.status_code == 200:
            print("\n📜 Streaming Response Events:")
            print("-" * 70)
            
            full_response = ""
            for line in response.iter_lines(decode_unicode=True):
                if line:
                    if line.startswith("event:"):
                        event_type = line.replace("event:", "").strip()
                        print(f"\n🔹 Event: {event_type}")
                    elif line.startswith("data:"):
                        data = line.replace("data:", "").strip()
                        try:
                            data_json = json.loads(data)
                            if "text" in data_json:
                                full_response += data_json.get("text", "")
                                print(f"   Text: {data_json.get('text', '')[:100]}...")
                            elif "content" in data_json:
                                print(f"   Content: {json.dumps(data_json.get('content', [])[:1], indent=4)[:200]}...")
                            else:
                                print(f"   Data: {json.dumps(data_json, indent=4)[:200]}...")
                        except json.JSONDecodeError:
                            print(f"   Raw: {data[:100]}...")
            
            if full_response:
                print("\n" + "=" * 70)
                print("📋 Full Agent Response:")
                print("=" * 70)
                print(full_response)
        else:
            print(f"\n❌ Error Response:")
            print(response.text)
            
    except requests.exceptions.Timeout:
        print("\n⏱️ Request timed out")
    except requests.exceptions.RequestException as e:
        print(f"\n❌ Request failed: {e}")

def test_procedures():
    """Test the underlying procedures work correctly."""
    
    print("\n" + "=" * 70)
    print("🔍 Testing Underlying Procedures")
    print("=" * 70)
    
    import subprocess
    
    procedures = [
        ("GET_ROUTE_DIRECTIONS", "From Fisherman's Wharf to Chinatown, San Francisco"),
        ("GET_ISOCHRONE_AREA", "Union Square, San Francisco', 10"),
        ("OPTIMIZE_DELIVERIES", "Restaurant in North Beach, Hotel in Union Square, Cafe in Mission District', 'Warehouse in SoMa, San Francisco', 2"),
    ]
    
    for proc_name, args in procedures:
        print(f"\n▶️  Testing {proc_name}...")
        
        if proc_name == "GET_ROUTE_DIRECTIONS":
            sql = f"CALL OPENROUTESERVICE_NATIVE_APP.CORE.{proc_name}('{args}')"
        else:
            sql = f"CALL OPENROUTESERVICE_NATIVE_APP.CORE.{proc_name}('{args})"
        
        result = subprocess.run(
            ['snow', 'sql', '-q', sql, '-c', 'ppaczewskisnowhouse', '-o', 'output_format=json'],
            capture_output=True, text=True, timeout=120
        )
        
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                if data:
                    print(f"   ✅ {proc_name} works!")
                    # Pretty print first 200 chars
                    result_str = json.dumps(data[0], indent=2)
                    print(f"   Result preview: {result_str[:300]}...")
            except:
                print(f"   ⚠️ Could not parse: {result.stdout[:200]}")
        else:
            print(f"   ❌ Failed: {result.stderr[:200]}")

if __name__ == "__main__":
    test_agent()
    
    print("\n" + "=" * 70)
    print("📋 Summary")
    print("=" * 70)
    print("""
The ROUTE_ASSISTANT agent is configured with 3 tools:
  • get_directions   → GET_ROUTE_DIRECTIONS procedure
  • get_isochrone    → GET_ISOCHRONE_AREA procedure  
  • optimize_routes  → OPTIMIZE_DELIVERIES procedure

Each tool uses AI-powered geocoding (claude-sonnet-4-5) to convert
natural language location descriptions to coordinates.
""")
