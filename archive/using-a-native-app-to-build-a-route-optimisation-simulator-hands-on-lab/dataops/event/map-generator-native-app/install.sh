#!/bin/bash

# OpenStreetMap Generator Native App Installer
# This script deploys the OSM Generator as a Snowflake Native App

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Configuration
DEFAULT_CONNECTION_NAME="osm_generator_connection"

echo "========================================"
echo "OpenStreetMap Generator Native App"
echo "========================================"
echo ""

# Get connection name
read -p "Enter Snowflake CLI connection name [$DEFAULT_CONNECTION_NAME]: " CONNECTION_NAME
CONNECTION_NAME=${CONNECTION_NAME:-$DEFAULT_CONNECTION_NAME}

# Test connection
print_status "Testing Snowflake connection..."
if snow connection test -c "$CONNECTION_NAME" &> /dev/null; then
    print_success "Connection test passed!"
else
    print_error "Connection test failed. Please check your connection configuration."
    echo "Run: snow connection add --connection-name $CONNECTION_NAME"
    exit 1
fi

# Deploy the native app
print_status "Deploying OpenStreetMap Generator Native App..."

if snow app run -c "$CONNECTION_NAME"; then
    print_success "Native app deployed successfully!"
else
    print_error "Failed to deploy native app."
    exit 1
fi

# Post-installation instructions
print_success "Installation completed successfully!"
echo ""
echo "=== NEXT STEPS ==="
echo ""
echo "1. Open Snowsight in your browser"
echo "2. Navigate to: Data Products >> Apps"
echo "3. Find and select: osm_generator_app"
echo "4. Grant the required privileges:"
echo "   - External Access Integration (for OSM APIs)"
echo "   - Create Network Rule (for API access)"
echo "   - Create Stage (for file storage)"
echo "5. Click 'Activate' to enable the app"
echo "6. Open the Streamlit interface to start generating maps"
echo ""
echo "=== FEATURES ==="
echo ""
echo "🌍 Generate maps for any location worldwide"
echo "🏙️ Search by city name or coordinates"
echo "🎯 Use preset areas for popular cities"
echo "📊 Track generation history and metrics"
echo "⚡ Fast processing with Snowflake infrastructure"
echo ""
echo "=== USAGE ==="
echo ""
echo "The app provides an interactive Streamlit interface where you can:"
echo "- Enter city names (e.g., 'London, UK')"
echo "- Specify bounding box coordinates"
echo "- Choose from preset popular areas"
echo "- View generation history and download files"
echo ""
echo "Generated maps are stored in the 'core.generated_maps' stage"
echo "and can be used with routing engines like OpenRouteService."
echo ""
print_success "Happy mapping! 🗺️"
