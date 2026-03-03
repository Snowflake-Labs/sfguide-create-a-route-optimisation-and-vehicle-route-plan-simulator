#!/bin/bash

# Risk Intelligence Test Instance Setup Script

echo "🚀 Risk Intelligence Test Instance Setup"
echo "========================================"

# Check if Python is available
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed."
    exit 1
fi

# Check if pip is available
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 is required but not installed."
    exit 1
fi

# Install requirements
echo "📦 Installing Python requirements..."
pip3 install -r requirements.txt

# Check if config file exists
if [ ! -f "snowflake_config.py" ]; then
    echo "⚠️  Configuration file not found."
    echo "📝 Creating snowflake_config.py from template..."
    cp snowflake_config.template.py snowflake_config.py
    echo "✅ Please edit snowflake_config.py with your credentials before proceeding."
    echo ""
    echo "Required changes:"
    echo "  - Update 'user' with your username"
    echo "  - Update 'password' with your password"
    echo "  - Verify 'account' is SFSEHOL-TEST_RISK_NATIVE_APP_EZCXJH"
    echo "  - Set appropriate 'role' (e.g., ATTENDEE_ROLE)"
    echo ""
    echo "After updating the config, run:"
    echo "  python3 test_risk_intelligence_connection.py"
    echo "  python3 setup_risk_intelligence_test.py"
    exit 0
fi

# Test connection
echo "🔗 Testing Snowflake connection..."
python3 test_risk_intelligence_connection.py

# Check if test was successful
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Connection test completed!"
    echo ""
    echo "Next steps:"
    echo "1. Run setup if needed: python3 setup_risk_intelligence_test.py"
    echo "2. Access Streamlit apps through Snowflake UI"
    echo "3. Navigate to Applications → RISK_INTELLIGENCE_DEMO"
else
    echo ""
    echo "❌ Connection test failed. Please check your configuration."
    echo "Edit snowflake_config.py and try again."
fi
