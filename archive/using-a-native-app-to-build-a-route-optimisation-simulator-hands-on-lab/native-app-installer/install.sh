#!/bin/bash

# OpenRouteService Native App Installer for Snowflake
# This script automates the installation of the ORS Native App following Option 1 from the guide

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DEFAULT_CONNECTION_NAME="ors_connection"
DEFAULT_MAP_FILE="SanFrancisco.osm.pbf"
DEFAULT_CONFIG_FILE="ors-config.yml"

# Function to print colored output
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

# Function to check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check if snow CLI is installed
    if ! command -v snow &> /dev/null; then
        print_error "Snowflake CLI (snow) is not installed. Please install it first."
        echo "Installation guide: https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation"
        exit 1
    fi
    
    # Check if docker is installed and running
    if ! command -v docker &> /dev/null; then
        print_error "Docker is not installed. Please install Docker Desktop first."
        echo "Installation guide: https://docs.docker.com/get-docker/"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        print_error "Docker is not running. Please start Docker Desktop."
        exit 1
    fi
    
    print_success "Prerequisites check passed!"
}

# Function to get user input with defaults
get_user_input() {
    print_status "Gathering configuration information..."
    
    # Get connection name
    read -p "Enter Snowflake CLI connection name [${DEFAULT_CONNECTION_NAME}]: " CONNECTION_NAME
    CONNECTION_NAME=${CONNECTION_NAME:-$DEFAULT_CONNECTION_NAME}
    
    # Get map file preference
    echo ""
    echo "Map file options:"
    echo "1. Use default San Francisco map (${DEFAULT_MAP_FILE})"
    echo "2. Specify custom map file"
    echo "3. Generate custom map by bounding box coordinates"
    echo "4. Generate custom map by city name"
    read -p "Choose option [1]: " MAP_OPTION
    MAP_OPTION=${MAP_OPTION:-1}
    
    case "$MAP_OPTION" in
        2)
            read -p "Enter path to your .osm.pbf map file: " CUSTOM_MAP_FILE
            if [ ! -f "$CUSTOM_MAP_FILE" ]; then
                print_error "Map file not found: $CUSTOM_MAP_FILE"
                exit 1
            fi
            MAP_FILE=$(basename "$CUSTOM_MAP_FILE")
            MAP_PATH="$CUSTOM_MAP_FILE"
            ;;
        3)
            print_status "Generating custom map by bounding box..."
            read -p "Enter bounding box (xmin,ymin,xmax,ymax): " BBOX
            read -p "Enter map name [custom_map]: " CUSTOM_NAME
            CUSTOM_NAME=${CUSTOM_NAME:-custom_map}
            MAP_FILE="${CUSTOM_NAME}.osm.pbf"
            MAP_PATH="$MAP_FILE"
            
            if ./generate_map.sh --bbox "$BBOX" --output "$MAP_FILE"; then
                print_success "Custom map generated: $MAP_FILE"
            else
                print_error "Failed to generate custom map"
                exit 1
            fi
            ;;
        4)
            print_status "Generating custom map by city name..."
            read -p "Enter city or place name: " CITY_NAME
            read -p "Enter map name [${CITY_NAME// /_}]: " CUSTOM_NAME
            CUSTOM_NAME=${CUSTOM_NAME:-${CITY_NAME// /_}}
            MAP_FILE="${CUSTOM_NAME}.osm.pbf"
            MAP_PATH="$MAP_FILE"
            
            if ./generate_map.sh --city "$CITY_NAME" --output "$MAP_FILE"; then
                print_success "Custom map generated: $MAP_FILE"
            else
                print_error "Failed to generate custom map"
                exit 1
            fi
            ;;
        *)
            MAP_FILE="$DEFAULT_MAP_FILE"
            MAP_PATH="provider_setup/staged_files/$MAP_FILE"
            ;;
    esac
    
    print_success "Configuration gathered successfully!"
    echo "  Connection: $CONNECTION_NAME"
    echo "  Map file: $MAP_FILE"
}

# Function to test Snowflake connection
test_connection() {
    print_status "Testing Snowflake connection..."
    
    if snow connection test -c "$CONNECTION_NAME" &> /dev/null; then
        print_success "Snowflake connection test passed!"
    else
        print_error "Snowflake connection test failed. Please check your connection configuration."
        echo "Run: snow connection add --connection-name $CONNECTION_NAME"
        exit 1
    fi
}

# Function to setup Snowflake environment
setup_environment() {
    print_status "Setting up Snowflake environment..."
    
    # Execute environment setup SQL
    if snow sql -f provider_setup/env_setup.sql -c "$CONNECTION_NAME"; then
        print_success "Snowflake environment setup completed!"
    else
        print_error "Failed to setup Snowflake environment."
        exit 1
    fi
}

# Function to upload map and config files
upload_files() {
    print_status "Uploading map and configuration files..."
    
    # Upload map file
    if [ -f "$MAP_PATH" ]; then
        print_status "Uploading map file: $MAP_FILE"
        if snow stage copy "$MAP_PATH" @openrouteservice_setup.public.ors_spcs_stage -c "$CONNECTION_NAME"; then
            print_success "Map file uploaded successfully!"
        else
            print_error "Failed to upload map file."
            exit 1
        fi
    else
        print_error "Map file not found: $MAP_PATH"
        exit 1
    fi
    
    # Update config file with correct map filename
    CONFIG_PATH="provider_setup/staged_files/$DEFAULT_CONFIG_FILE"
    if [ -f "$CONFIG_PATH" ]; then
        # Create a temporary config file with the correct map filename
        TEMP_CONFIG="/tmp/ors-config-temp.yml"
        sed "s|source_file: .*|source_file: /home/ors/files/$MAP_FILE|g" "$CONFIG_PATH" > "$TEMP_CONFIG"
        
        print_status "Uploading configuration file: $DEFAULT_CONFIG_FILE"
        if snow stage copy "$TEMP_CONFIG" @openrouteservice_setup.public.ors_spcs_stage/$DEFAULT_CONFIG_FILE -c "$CONNECTION_NAME"; then
            print_success "Configuration file uploaded successfully!"
            rm "$TEMP_CONFIG"
        else
            print_error "Failed to upload configuration file."
            rm "$TEMP_CONFIG"
            exit 1
        fi
    else
        print_error "Configuration file not found: $CONFIG_PATH"
        exit 1
    fi
    
    # Refresh stage metadata
    print_status "Refreshing stage metadata..."
    snow sql -q "ALTER STAGE openrouteservice_setup.public.ors_spcs_stage REFRESH;" -c "$CONNECTION_NAME"
}

# Function to build and push Docker images
build_and_push_images() {
    print_status "Building and pushing Docker images..."
    
    # Update the spcs_setup.sh script with the correct connection name
    TEMP_SCRIPT="/tmp/spcs_setup_temp.sh"
    sed "s/<CONNECTION_NAME>/$CONNECTION_NAME/g" provider_setup/spcs_setup.sh > "$TEMP_SCRIPT"
    chmod +x "$TEMP_SCRIPT"
    
    # Execute the script
    if bash "$TEMP_SCRIPT"; then
        print_success "Docker images built and pushed successfully!"
        rm "$TEMP_SCRIPT"
    else
        print_error "Failed to build and push Docker images."
        rm "$TEMP_SCRIPT"
        exit 1
    fi
}

# Function to deploy the native app
deploy_app() {
    print_status "Deploying the native app..."
    
    if snow app run -c "$CONNECTION_NAME"; then
        print_success "Native app deployed successfully!"
    else
        print_error "Failed to deploy native app."
        exit 1
    fi
}

# Function to provide post-installation instructions
post_install_instructions() {
    print_success "Installation completed successfully!"
    echo ""
    echo "=== POST-INSTALLATION STEPS ==="
    echo ""
    echo "1. Open Snowsight in your browser"
    echo "2. Navigate to: Data Products >> Apps"
    echo "3. Find and select: openrouteservice_native_app"
    echo "4. Grant the required privileges via the UI"
    echo "5. Click the 'Activate' button in the upper right corner"
    echo "6. Wait 1-2 minutes for the first launch to complete"
    echo ""
    echo "=== TESTING THE APP ==="
    echo ""
    echo "After activation, you can test the APIs using the built-in Streamlit interface."
    echo ""
    echo "=== TROUBLESHOOTING ==="
    echo ""
    echo "If services are suspended, manually resume them:"
    echo "  ALTER SERVICE CORE.ORS_SERVICE RESUME;"
    echo "  ALTER SERVICE CORE.ROUTING_GATEWAY_SERVICE RESUME;"
    echo "  ALTER SERVICE CORE.VROOM_SERVICE RESUME;"
    echo "  ALTER SERVICE CORE.DOWNLOADER RESUME;"
    echo ""
    echo "Check container logs for any issues:"
    echo "  https://docs.snowflake.com/en/developer-guide/snowpark-container-services/monitoring-services"
    echo ""
    print_success "Happy routing! 🚗"
}

# Main installation flow
main() {
    echo "========================================"
    echo "OpenRouteService Native App Installer"
    echo "========================================"
    echo ""
    
    check_prerequisites
    get_user_input
    test_connection
    setup_environment
    upload_files
    build_and_push_images
    deploy_app
    post_install_instructions
}

# Run the installer
main "$@"
