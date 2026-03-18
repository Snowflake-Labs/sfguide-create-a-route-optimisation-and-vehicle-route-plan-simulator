#!/bin/bash

# Troubleshooting script for OpenRouteService Native App
# This script helps diagnose common issues

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
    echo -e "${GREEN}[OK]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get connection name
CONNECTION_NAME=${1:-"ors_connection"}

echo "========================================"
echo "OpenRouteService Troubleshooting Tool"
echo "========================================"
echo "Connection: $CONNECTION_NAME"
echo ""

# Function to check Snowflake objects
check_snowflake_objects() {
    print_status "Checking Snowflake objects..."
    
    # Check database
    if snow sql -q "SHOW DATABASES LIKE 'OPENROUTESERVICE_SETUP'" -c "$CONNECTION_NAME" --format json | grep -q "OPENROUTESERVICE_SETUP"; then
        print_success "Database OPENROUTESERVICE_SETUP exists"
    else
        print_error "Database OPENROUTESERVICE_SETUP not found"
        echo "  Run: snow sql -f provider_setup/env_setup.sql -c $CONNECTION_NAME"
    fi
    
    # Check stages
    STAGES=("ORS_SPCS_STAGE" "ORS_GRAPHS_SPCS_STAGE" "ORS_ELEVATION_CACHE_SPCS_STAGE")
    for stage in "${STAGES[@]}"; do
        if snow sql -q "SHOW STAGES LIKE '$stage' IN OPENROUTESERVICE_SETUP.PUBLIC" -c "$CONNECTION_NAME" --format json | grep -q "$stage"; then
            print_success "Stage $stage exists"
        else
            print_error "Stage $stage not found"
        fi
    done
    
    # Check image repository
    if snow sql -q "SHOW IMAGE REPOSITORIES IN OPENROUTESERVICE_SETUP.PUBLIC" -c "$CONNECTION_NAME" --format json | grep -q "IMAGE_REPOSITORY"; then
        print_success "Image repository exists"
    else
        print_error "Image repository not found"
    fi
}

# Function to check uploaded files
check_uploaded_files() {
    print_status "Checking uploaded files..."
    
    # List files in ORS stage
    FILES_OUTPUT=$(snow sql -q "LIST @OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE" -c "$CONNECTION_NAME" --format json 2>/dev/null || echo "[]")
    
    if echo "$FILES_OUTPUT" | grep -q "SanFrancisco.osm.pbf\|\.osm\.pbf"; then
        print_success "Map file found in stage"
    else
        print_error "No map file found in stage"
        echo "  Upload with: snow stage copy your_map.osm.pbf @openrouteservice_setup.public.ors_spcs_stage -c $CONNECTION_NAME"
    fi
    
    if echo "$FILES_OUTPUT" | grep -q "ors-config.yml"; then
        print_success "Configuration file found in stage"
    else
        print_error "Configuration file not found in stage"
        echo "  Upload with: snow stage copy provider_setup/staged_files/ors-config.yml @openrouteservice_setup.public.ors_spcs_stage -c $CONNECTION_NAME"
    fi
}

# Function to check Docker images
check_docker_images() {
    print_status "Checking Docker images in repository..."
    
    IMAGES_OUTPUT=$(snow sql -q "SHOW IMAGES IN IMAGE REPOSITORY OPENROUTESERVICE_SETUP.PUBLIC.IMAGE_REPOSITORY" -c "$CONNECTION_NAME" --format json 2>/dev/null || echo "[]")
    
    EXPECTED_IMAGES=("openrouteservice" "vroom-docker" "routing_reverse_proxy" "downloader")
    
    for image in "${EXPECTED_IMAGES[@]}"; do
        if echo "$IMAGES_OUTPUT" | grep -q "$image"; then
            print_success "Image $image found"
        else
            print_error "Image $image not found"
            echo "  Rebuild with: ./provider_setup/spcs_setup.sh (after updating connection name)"
        fi
    done
}

# Function to check native app
check_native_app() {
    print_status "Checking native app deployment..."
    
    # Check application package
    if snow sql -q "SHOW APPLICATION PACKAGES LIKE 'OPENROUTESERVICE_NATIVE_APP_PKG'" -c "$CONNECTION_NAME" --format json | grep -q "OPENROUTESERVICE_NATIVE_APP_PKG"; then
        print_success "Application package exists"
    else
        print_error "Application package not found"
        echo "  Deploy with: snow app run -c $CONNECTION_NAME"
    fi
    
    # Check application
    if snow sql -q "SHOW APPLICATIONS LIKE 'OPENROUTESERVICE_NATIVE_APP'" -c "$CONNECTION_NAME" --format json | grep -q "OPENROUTESERVICE_NATIVE_APP"; then
        print_success "Application exists"
    else
        print_error "Application not found"
        echo "  Deploy with: snow app run -c $CONNECTION_NAME"
    fi
}

# Function to check services status
check_services_status() {
    print_status "Checking service status..."
    
    SERVICES=("ORS_SERVICE" "ROUTING_GATEWAY_SERVICE" "VROOM_SERVICE" "DOWNLOADER")
    
    for service in "${SERVICES[@]}"; do
        SERVICE_STATUS=$(snow sql -q "SHOW SERVICES LIKE '$service' IN OPENROUTESERVICE_NATIVE_APP.CORE" -c "$CONNECTION_NAME" --format json 2>/dev/null || echo "[]")
        
        if echo "$SERVICE_STATUS" | grep -q "$service"; then
            STATUS=$(echo "$SERVICE_STATUS" | jq -r '.[0].status' 2>/dev/null || echo "UNKNOWN")
            case "$STATUS" in
                "RUNNING")
                    print_success "Service $service is RUNNING"
                    ;;
                "SUSPENDED")
                    print_warning "Service $service is SUSPENDED"
                    echo "  Resume with: ALTER SERVICE CORE.$service RESUME;"
                    ;;
                *)
                    print_warning "Service $service status: $STATUS"
                    ;;
            esac
        else
            print_error "Service $service not found"
        fi
    done
}

# Function to show recent logs
show_recent_logs() {
    print_status "Checking recent service logs..."
    
    echo ""
    echo "To view detailed logs, run these commands in Snowsight:"
    echo ""
    echo "-- OpenRouteService logs"
    echo "SELECT SYSTEM\$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE', '0', 'openrouteservice', 50);"
    echo ""
    echo "-- Gateway logs"
    echo "SELECT SYSTEM\$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE', '0', 'routing-gateway', 50);"
    echo ""
    echo "-- VROOM logs"
    echo "SELECT SYSTEM\$GET_SERVICE_LOGS('OPENROUTESERVICE_NATIVE_APP.CORE.VROOM_SERVICE', '0', 'vroom-engine', 50);"
    echo ""
}

# Function to provide common solutions
show_common_solutions() {
    print_status "Common solutions:"
    echo ""
    echo "1. Services suspended:"
    echo "   ALTER SERVICE CORE.ORS_SERVICE RESUME;"
    echo "   ALTER SERVICE CORE.ROUTING_GATEWAY_SERVICE RESUME;"
    echo "   ALTER SERVICE CORE.VROOM_SERVICE RESUME;"
    echo "   ALTER SERVICE CORE.DOWNLOADER RESUME;"
    echo ""
    echo "2. Refresh stage after file upload:"
    echo "   ALTER STAGE OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE REFRESH;"
    echo ""
    echo "3. Rebuild and redeploy app:"
    echo "   snow app teardown -c $CONNECTION_NAME"
    echo "   snow app run -c $CONNECTION_NAME"
    echo ""
    echo "4. Check compute pool status:"
    echo "   SHOW COMPUTE POOLS;"
    echo ""
}

# Main troubleshooting flow
main() {
    check_snowflake_objects
    echo ""
    check_uploaded_files
    echo ""
    check_docker_images
    echo ""
    check_native_app
    echo ""
    check_services_status
    echo ""
    show_recent_logs
    echo ""
    show_common_solutions
    
    echo "========================================"
    echo "Troubleshooting complete!"
    echo "========================================"
}

# Check if connection name provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 [connection_name]"
    echo "Using default connection: $CONNECTION_NAME"
    echo ""
fi

# Test connection first
if ! snow connection test -c "$CONNECTION_NAME" &> /dev/null; then
    print_error "Cannot connect to Snowflake with connection: $CONNECTION_NAME"
    echo "Available connections:"
    snow connection list
    exit 1
fi

main "$@"
