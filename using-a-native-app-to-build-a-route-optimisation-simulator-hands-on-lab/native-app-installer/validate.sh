#!/bin/bash

# Validation script for OpenRouteService Native App Installer
# This script checks if all prerequisites are met before installation

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[CHECK]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[⚠]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Initialize counters
CHECKS_PASSED=0
CHECKS_FAILED=0
WARNINGS=0

# Function to increment counters
pass_check() {
    print_success "$1"
    ((CHECKS_PASSED++))
}

fail_check() {
    print_error "$1"
    ((CHECKS_FAILED++))
}

warn_check() {
    print_warning "$1"
    ((WARNINGS++))
}

echo "========================================"
echo "OpenRouteService Installer Validation"
echo "========================================"
echo ""

# Check 1: Snowflake CLI
print_status "Checking Snowflake CLI installation..."
if command -v snow &> /dev/null; then
    SNOW_VERSION=$(snow --version 2>/dev/null | head -n1)
    pass_check "Snowflake CLI found: $SNOW_VERSION"
else
    fail_check "Snowflake CLI not found. Install from: https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation"
fi

# Check 2: Docker
print_status "Checking Docker installation..."
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version)
    pass_check "Docker found: $DOCKER_VERSION"
    
    # Check if Docker is running
    print_status "Checking if Docker is running..."
    if docker info &> /dev/null; then
        pass_check "Docker daemon is running"
    else
        fail_check "Docker daemon is not running. Please start Docker Desktop."
    fi
else
    fail_check "Docker not found. Install from: https://docs.docker.com/get-docker/"
fi

# Check 3: Required files
print_status "Checking required installation files..."

REQUIRED_FILES=(
    "install.sh"
    "app/manifest.yml"
    "app/setup_script.sql"
    "provider_setup/env_setup.sql"
    "provider_setup/spcs_setup.sh"
    "provider_setup/staged_files/SanFrancisco.osm.pbf"
    "provider_setup/staged_files/ors-config.yml"
    "snowflake.yml"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        pass_check "Found: $file"
    else
        fail_check "Missing: $file"
    fi
done

# Check 4: Directory structure
print_status "Checking directory structure..."

REQUIRED_DIRS=(
    "app"
    "code_artifacts/streamlit"
    "provider_setup"
    "services/openrouteservice"
    "services/gateway"
    "services/downloader"
    "services/vroom"
    "setup"
)

for dir in "${REQUIRED_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        pass_check "Found directory: $dir"
    else
        fail_check "Missing directory: $dir"
    fi
done

# Check 5: File permissions
print_status "Checking file permissions..."
if [ -x "install.sh" ]; then
    pass_check "install.sh is executable"
else
    warn_check "install.sh is not executable (will be fixed automatically)"
fi

if [ -f "provider_setup/spcs_setup.sh" ]; then
    if [ -x "provider_setup/spcs_setup.sh" ]; then
        pass_check "spcs_setup.sh is executable"
    else
        warn_check "spcs_setup.sh is not executable (will be fixed during installation)"
    fi
fi

# Check 6: Map file size
print_status "Checking map file..."
MAP_FILE="provider_setup/staged_files/SanFrancisco.osm.pbf"
if [ -f "$MAP_FILE" ]; then
    MAP_SIZE=$(du -h "$MAP_FILE" | cut -f1)
    pass_check "Map file size: $MAP_SIZE"
    
    # Check if file is reasonable size (not empty, not too large)
    MAP_SIZE_BYTES=$(stat -f%z "$MAP_FILE" 2>/dev/null || stat -c%s "$MAP_FILE" 2>/dev/null || echo "0")
    if [ "$MAP_SIZE_BYTES" -lt 1000000 ]; then  # Less than 1MB
        warn_check "Map file seems very small ($MAP_SIZE). Verify it's a valid OSM file."
    elif [ "$MAP_SIZE_BYTES" -gt 5000000000 ]; then  # Greater than 5GB
        warn_check "Map file is very large ($MAP_SIZE). Consider using external stage for upload."
    fi
fi

# Check 7: Snowflake connections
print_status "Checking Snowflake CLI connections..."
if command -v snow &> /dev/null; then
    CONNECTION_COUNT=$(snow connection list --format json 2>/dev/null | jq length 2>/dev/null || echo "0")
    if [ "$CONNECTION_COUNT" -gt 0 ]; then
        pass_check "Found $CONNECTION_COUNT Snowflake CLI connection(s)"
        echo ""
        echo "Available connections:"
        snow connection list 2>/dev/null || echo "  (Unable to list connections)"
    else
        warn_check "No Snowflake CLI connections found. You'll need to create one before installation."
        echo "  Run: snow connection add --connection-name ors_connection"
    fi
fi

# Summary
echo ""
echo "========================================"
echo "Validation Summary"
echo "========================================"
echo ""
echo -e "Checks passed: ${GREEN}$CHECKS_PASSED${NC}"
echo -e "Checks failed: ${RED}$CHECKS_FAILED${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"
echo ""

if [ $CHECKS_FAILED -eq 0 ]; then
    if [ $WARNINGS -eq 0 ]; then
        print_success "All checks passed! Ready to install."
        echo ""
        echo "Run: ./install.sh"
    else
        print_warning "Validation passed with warnings. Review warnings above."
        echo ""
        echo "You can proceed with: ./install.sh"
    fi
    exit 0
else
    print_error "Validation failed. Please fix the issues above before installing."
    exit 1
fi
