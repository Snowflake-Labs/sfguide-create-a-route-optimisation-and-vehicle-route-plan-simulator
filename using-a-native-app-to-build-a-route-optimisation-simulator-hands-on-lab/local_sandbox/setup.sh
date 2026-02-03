#!/bin/bash
# Quick setup script for NYC Beauty Supply Chain Optimizer local development

echo "🏗️ Setting up NYC Beauty Supply Chain Optimizer - Local Development"
echo "=================================================================="

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed."
    echo "Please install Python 3.11+ and try again."
    exit 1
fi

echo "✅ Python found: $(python3 --version)"

# Check if pip is available
if ! command -v pip3 &> /dev/null && ! command -v pip &> /dev/null; then
    echo "❌ pip is required but not found."
    echo "Please install pip and try again."
    exit 1
fi

echo "✅ pip found"

# Install dependencies
echo "📦 Installing Python dependencies..."
if command -v pip3 &> /dev/null; then
    pip3 install -r requirements.txt
else
    pip install -r requirements.txt
fi

if [ $? -eq 0 ]; then
    echo "✅ Dependencies installed successfully"
else
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Check if config file exists
if [ ! -f "snowflake_config.py" ]; then
    echo "⚙️ Creating Snowflake configuration template..."
    cp snowflake_config.template.py snowflake_config.py
    echo "✅ Configuration template created: snowflake_config.py"
    echo "📝 Please edit snowflake_config.py with your Snowflake connection details"
else
    echo "✅ Snowflake configuration already exists"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit snowflake_config.py with your Snowflake connection details"
echo "2. Run the app: python3 run_local.py"
echo ""
echo "For detailed instructions, see README.md"
