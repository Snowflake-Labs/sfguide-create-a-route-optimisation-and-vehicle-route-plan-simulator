#!/bin/bash

# OpenStreetMap Custom Map Generator (Shell Script Version)
# Generates .osm.pbf files for specified bounding box coordinates

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

# Function to show usage
show_usage() {
    echo "OpenStreetMap Custom Map Generator"
    echo ""
    echo "Usage:"
    echo "  $0 --bbox \"xmin,ymin,xmax,ymax\" --output \"filename.osm.pbf\""
    echo "  $0 --city \"City Name\" --output \"filename.osm.pbf\""
    echo "  $0 --interactive"
    echo ""
    echo "Examples:"
    echo "  # Generate map for Manhattan"
    echo "  $0 --bbox \"-74.0479,40.7128,-73.9441,40.7831\" --output manhattan.osm.pbf"
    echo ""
    echo "  # Generate map for London (by city name)"
    echo "  $0 --city \"London, UK\" --output london.osm.pbf"
    echo ""
    echo "  # Interactive mode"
    echo "  $0 --interactive"
    echo ""
    echo "Bounding box format: xmin,ymin,xmax,ymax (longitude,latitude)"
    echo "  xmin/xmax: longitude (-180 to 180)"
    echo "  ymin/ymax: latitude (-90 to 90)"
}

# Function to check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check curl
    if ! command -v curl &> /dev/null; then
        print_error "curl is required but not installed"
        exit 1
    fi
    
    # Check jq for JSON parsing
    if ! command -v jq &> /dev/null; then
        print_warning "jq not found. City geocoding will not work."
        print_status "Install jq: sudo apt-get install jq (Ubuntu) or brew install jq (macOS)"
    fi
    
    # Check osmconvert for PBF conversion
    if ! command -v osmconvert &> /dev/null; then
        print_warning "osmconvert not found. Only XML output will be available."
        print_status "Install osmctools: sudo apt-get install osmctools (Ubuntu) or brew install osmctools (macOS)"
    fi
    
    print_success "Prerequisites check completed"
}

# Function to validate bounding box
validate_bbox() {
    local bbox="$1"
    IFS=',' read -r xmin ymin xmax ymax <<< "$bbox"
    
    # Check if we have 4 coordinates
    if [[ -z "$xmin" || -z "$ymin" || -z "$xmax" || -z "$ymax" ]]; then
        print_error "Bounding box must have exactly 4 coordinates: xmin,ymin,xmax,ymax"
        return 1
    fi
    
    # Check coordinate ranges (basic validation)
    if (( $(echo "$xmin < -180 || $xmin > 180" | bc -l) )); then
        print_error "xmin longitude must be between -180 and 180"
        return 1
    fi
    
    if (( $(echo "$xmax < -180 || $xmax > 180" | bc -l) )); then
        print_error "xmax longitude must be between -180 and 180"
        return 1
    fi
    
    if (( $(echo "$ymin < -90 || $ymin > 90" | bc -l) )); then
        print_error "ymin latitude must be between -90 and 90"
        return 1
    fi
    
    if (( $(echo "$ymax < -90 || $ymax > 90" | bc -l) )); then
        print_error "ymax latitude must be between -90 and 90"
        return 1
    fi
    
    # Check logical order
    if (( $(echo "$xmin >= $xmax" | bc -l) )); then
        print_error "xmin must be less than xmax"
        return 1
    fi
    
    if (( $(echo "$ymin >= $ymax" | bc -l) )); then
        print_error "ymin must be less than ymax"
        return 1
    fi
    
    # Calculate area and warn if large
    local width=$(echo "$xmax - $xmin" | bc -l)
    local height=$(echo "$ymax - $ymin" | bc -l)
    local area=$(echo "$width * $height" | bc -l)
    
    if (( $(echo "$area > 1.0" | bc -l) )); then
        print_warning "Large area detected (${area} deg²). Download may be slow or fail."
        print_warning "Consider using a smaller bounding box."
    fi
    
    return 0
}

# Function to geocode city name
geocode_city() {
    local city="$1"
    
    if ! command -v jq &> /dev/null; then
        print_error "jq is required for city geocoding"
        return 1
    fi
    
    print_status "Geocoding city: $city"
    
    # URL encode the city name
    local encoded_city=$(echo "$city" | sed 's/ /%20/g')
    
    # Query Nominatim
    local response=$(curl -s "https://nominatim.openstreetmap.org/search?q=${encoded_city}&format=json&limit=1&addressdetails=1" || echo "[]")
    
    if [[ "$response" == "[]" || -z "$response" ]]; then
        print_error "City '$city' not found"
        return 1
    fi
    
    # Extract bounding box
    local bbox_array=$(echo "$response" | jq -r '.[0].boundingbox // empty')
    
    if [[ -z "$bbox_array" ]]; then
        print_error "No bounding box found for '$city'"
        return 1
    fi
    
    # Parse bounding box [south, north, west, east] -> [west, south, east, north]
    local south=$(echo "$bbox_array" | jq -r '.[0]')
    local north=$(echo "$bbox_array" | jq -r '.[1]')
    local west=$(echo "$bbox_array" | jq -r '.[2]')
    local east=$(echo "$bbox_array" | jq -r '.[3]')
    
    # Return in our format: xmin,ymin,xmax,ymax
    echo "$west,$south,$east,$north"
    
    local display_name=$(echo "$response" | jq -r '.[0].display_name // "Unknown"')
    print_success "Found: $display_name"
    print_status "Bounding box: $west,$south,$east,$north"
    
    return 0
}

# Function to build Overpass query
build_overpass_query() {
    local bbox="$1"
    IFS=',' read -r xmin ymin xmax ymax <<< "$bbox"
    
    # Overpass query to get all data in the bounding box
    cat << EOF
[out:xml][timeout:300][bbox:${ymin},${xmin},${ymax},${xmax}];
(
  relation;
  way;
  node;
);
out meta;
EOF
}

# Function to download OSM data
download_osm_data() {
    local bbox="$1"
    local output_file="$2"
    
    print_status "Downloading OSM data from Overpass API..."
    
    # Build query
    local query=$(build_overpass_query "$bbox")
    
    # Create temporary file for XML
    local temp_xml="${output_file%.osm.pbf}.osm"
    
    print_status "Querying Overpass API (this may take several minutes)..."
    
    # Download data
    if curl -X POST \
        -H "Content-Type: text/plain" \
        -d "$query" \
        --max-time 600 \
        --output "$temp_xml" \
        "https://overpass-api.de/api/interpreter"; then
        
        local file_size=$(du -h "$temp_xml" | cut -f1)
        print_success "Downloaded OSM data (${file_size})"
        
        # Convert to PBF if osmconvert is available
        if command -v osmconvert &> /dev/null; then
            print_status "Converting to PBF format..."
            if osmconvert "$temp_xml" -o="$output_file"; then
                local pbf_size=$(du -h "$output_file" | cut -f1)
                print_success "Created PBF file: $output_file (${pbf_size})"
                rm "$temp_xml"
                return 0
            else
                print_error "Failed to convert to PBF format"
                print_status "XML file available at: $temp_xml"
                return 1
            fi
        else
            # Rename XML file to have .osm extension
            local xml_output="${output_file%.osm.pbf}.osm"
            mv "$temp_xml" "$xml_output"
            print_warning "osmconvert not available. Saved as XML: $xml_output"
            print_status "To convert to PBF: osmconvert $xml_output -o=$output_file"
            return 0
        fi
    else
        print_error "Failed to download OSM data"
        return 1
    fi
}

# Function for interactive mode
interactive_mode() {
    echo "=" * 50
    echo "OpenStreetMap Custom Map Generator"
    echo "=" * 50
    echo ""
    
    echo "How would you like to specify the area?"
    echo "1. City/Place name (requires jq)"
    echo "2. Manual bounding box coordinates"
    echo "3. Popular preset areas"
    echo ""
    
    read -p "Enter choice (1-3): " choice
    
    local bbox=""
    local output_name=""
    
    case "$choice" in
        1)
            if ! command -v jq &> /dev/null; then
                print_error "jq is required for city geocoding"
                return 1
            fi
            
            read -p "Enter city or place name: " city
            if [[ -n "$city" ]]; then
                bbox=$(geocode_city "$city")
                if [[ $? -eq 0 ]]; then
                    output_name=$(echo "$city" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g').osm.pbf
                else
                    return 1
                fi
            fi
            ;;
        2)
            echo ""
            echo "Enter bounding box coordinates:"
            echo "Format: xmin,ymin,xmax,ymax (longitude,latitude)"
            echo "Example: -0.489,51.28,0.236,51.686 (Greater London)"
            echo ""
            
            read -p "Bounding box: " bbox
            output_name="custom_area.osm.pbf"
            ;;
        3)
            echo ""
            echo "Preset areas:"
            echo "1. Manhattan, NYC"
            echo "2. Central London"
            echo "3. San Francisco"
            echo "4. Amsterdam Center"
            echo "5. Berlin Mitte"
            echo ""
            
            read -p "Select preset (1-5): " preset_choice
            
            case "$preset_choice" in
                1) bbox="-74.0479,40.7128,-73.9441,40.7831"; output_name="manhattan_nyc.osm.pbf" ;;
                2) bbox="-0.1778,51.4893,-0.0762,51.5279"; output_name="central_london.osm.pbf" ;;
                3) bbox="-122.5149,37.7081,-122.3574,37.8085"; output_name="san_francisco.osm.pbf" ;;
                4) bbox="4.8372,52.3477,4.9419,52.3925"; output_name="amsterdam_center.osm.pbf" ;;
                5) bbox="13.3501,52.4946,13.4286,52.5323"; output_name="berlin_mitte.osm.pbf" ;;
                *) print_error "Invalid selection"; return 1 ;;
            esac
            
            print_status "Selected bounding box: $bbox"
            ;;
        *)
            print_error "Invalid choice"
            return 1
            ;;
    esac
    
    if [[ -z "$bbox" ]]; then
        print_error "No valid area specified"
        return 1
    fi
    
    # Get output filename
    read -p "Output filename [$output_name]: " user_output
    output_file="${user_output:-$output_name}"
    
    # Ensure .osm.pbf extension
    if [[ "$output_file" != *.osm.pbf ]]; then
        output_file="${output_file}.osm.pbf"
    fi
    
    # Validate and download
    if validate_bbox "$bbox"; then
        print_status "Generating map for bounding box: $bbox"
        print_status "Output file: $output_file"
        echo ""
        
        read -p "Proceed with download? (y/N): " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            download_osm_data "$bbox" "$output_file"
        else
            print_status "Download cancelled"
            return 1
        fi
    else
        return 1
    fi
}

# Main function
main() {
    local bbox=""
    local city=""
    local output="custom_map.osm.pbf"
    local interactive=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --bbox)
                bbox="$2"
                shift 2
                ;;
            --city)
                city="$2"
                shift 2
                ;;
            --output)
                output="$2"
                shift 2
                ;;
            --interactive)
                interactive=true
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done
    
    check_prerequisites
    
    if [[ "$interactive" == true ]]; then
        interactive_mode
    elif [[ -n "$city" ]]; then
        bbox=$(geocode_city "$city")
        if [[ $? -eq 0 ]] && validate_bbox "$bbox"; then
            download_osm_data "$bbox" "$output"
        else
            exit 1
        fi
    elif [[ -n "$bbox" ]]; then
        if validate_bbox "$bbox"; then
            download_osm_data "$bbox" "$output"
        else
            exit 1
        fi
    else
        print_error "No area specified. Use --bbox, --city, or --interactive"
        show_usage
        exit 1
    fi
}

# Check if bc is available for calculations
if ! command -v bc &> /dev/null; then
    print_error "bc (calculator) is required but not installed"
    print_status "Install: sudo apt-get install bc (Ubuntu) or brew install bc (macOS)"
    exit 1
fi

# Run main function
main "$@"
