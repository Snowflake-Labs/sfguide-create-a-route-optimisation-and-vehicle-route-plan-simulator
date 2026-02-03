#!/usr/bin/env python3
"""
Local development runner for NYC Beauty Supply Chain Optimizer
"""

import subprocess
import sys
import os
from pathlib import Path

def check_requirements():
    """Check if required packages are installed"""
    try:
        import streamlit
        import snowflake.snowpark
        print("✅ Required packages are installed")
        return True
    except ImportError as e:
        print(f"❌ Missing required packages: {e}")
        print("Please run: pip install -r requirements.txt")
        return False

def check_config():
    """Check if snowflake config exists"""
    config_file = Path(__file__).parent / "snowflake_config.py"
    if config_file.exists():
        print("✅ Snowflake configuration found")
        return True
    else:
        print("❌ Snowflake configuration not found")
        print("Please copy snowflake_config.template.py to snowflake_config.py and fill in your details")
        return False

def run_streamlit():
    """Run the Streamlit app"""
    app_file = Path(__file__).parent / "nyc_beauty_routing_local.py"
    
    print(f"🚀 Starting Streamlit app: {app_file}")
    print("📱 The app will open in your browser automatically")
    print("🛑 Press Ctrl+C to stop the server")
    
    try:
        subprocess.run([
            sys.executable, "-m", "streamlit", "run", 
            str(app_file),
            "--server.headless", "false",
            "--server.runOnSave", "true",
            "--browser.gatherUsageStats", "false"
        ])
    except KeyboardInterrupt:
        print("\n✋ Streamlit server stopped")

def main():
    """Main function"""
    print("🏗️  NYC Beauty Supply Chain Optimizer - Local Development")
    print("=" * 60)
    
    # Check prerequisites
    if not check_requirements():
        return 1
    
    if not check_config():
        return 1
    
    # Run the app
    run_streamlit()
    return 0

if __name__ == "__main__":
    sys.exit(main())
