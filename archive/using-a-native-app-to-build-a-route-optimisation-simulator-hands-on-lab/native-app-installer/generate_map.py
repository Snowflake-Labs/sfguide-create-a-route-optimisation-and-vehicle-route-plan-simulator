#!/usr/bin/env python3
"""
OpenStreetMap Custom Map Generator
Generates .osm.pbf files for specified bounding box coordinates

Usage:
    python generate_map.py --bbox "xmin,ymin,xmax,ymax" --output "my_map.osm.pbf"
    python generate_map.py --city "London" --output "london.osm.pbf"
    python generate_map.py --interactive
"""

import argparse
import requests
import json
import sys
import os
import time
from typing import Tuple, Optional
import subprocess

# Colors for output
class Colors:
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    BLUE = '\033[0;34m'
    NC = '\033[0m'  # No Color

def print_status(msg: str):
    print(f"{Colors.BLUE}[INFO]{Colors.NC} {msg}")

def print_success(msg: str):
    print(f"{Colors.GREEN}[SUCCESS]{Colors.NC} {msg}")

def print_warning(msg: str):
    print(f"{Colors.YELLOW}[WARNING]{Colors.NC} {msg}")

def print_error(msg: str):
    print(f"{Colors.RED}[ERROR]{Colors.NC} {msg}")

class MapGenerator:
    def __init__(self):
        self.overpass_url = "https://overpass-api.de/api/interpreter"
        self.nominatim_url = "https://nominatim.openstreetmap.org/search"
        
    def geocode_city(self, city_name: str) -> Optional[Tuple[float, float, float, float]]:
        """
        Geocode a city name to get bounding box coordinates
        Returns (xmin, ymin, xmax, ymax) or None if not found
        """
        print_status(f"Geocoding city: {city_name}")
        
        params = {
            'q': city_name,
            'format': 'json',
            'limit': 1,
            'extratags': 1,
            'addressdetails': 1
        }
        
        try:
            response = requests.get(self.nominatim_url, params=params, timeout=30)
            response.raise_for_status()
            
            results = response.json()
            if not results:
                print_error(f"City '{city_name}' not found")
                return None
                
            result = results[0]
            bbox = result.get('boundingbox')
            
            if not bbox or len(bbox) != 4:
                print_error(f"No bounding box found for '{city_name}'")
                return None
                
            # Nominatim returns [south, north, west, east]
            # We need [west, south, east, north] = [xmin, ymin, xmax, ymax]
            ymin, ymax, xmin, xmax = map(float, bbox)
            
            print_success(f"Found {result.get('display_name', city_name)}")
            print_status(f"Bounding box: {xmin:.6f},{ymin:.6f},{xmax:.6f},{ymax:.6f}")
            
            return (xmin, ymin, xmax, ymax)
            
        except requests.RequestException as e:
            print_error(f"Failed to geocode city: {e}")
            return None
    
    def validate_bbox(self, bbox: Tuple[float, float, float, float]) -> bool:
        """Validate bounding box coordinates"""
        xmin, ymin, xmax, ymax = bbox
        
        # Check coordinate ranges
        if not (-180 <= xmin <= 180 and -180 <= xmax <= 180):
            print_error("Longitude must be between -180 and 180")
            return False
            
        if not (-90 <= ymin <= 90 and -90 <= ymax <= 90):
            print_error("Latitude must be between -90 and 90")
            return False
            
        # Check logical order
        if xmin >= xmax:
            print_error("xmin must be less than xmax")
            return False
            
        if ymin >= ymax:
            print_error("ymin must be less than ymax")
            return False
            
        # Check size (warn if too large)
        width = xmax - xmin
        height = ymax - ymin
        area = width * height
        
        if area > 1.0:  # Roughly 100km x 100km at equator
            print_warning(f"Large area detected ({area:.2f} deg²). Download may be slow or fail.")
            print_warning("Consider using a smaller bounding box or a regional extract service.")
            
        return True
    
    def build_overpass_query(self, bbox: Tuple[float, float, float, float]) -> str:
        """Build Overpass API query for the bounding box"""
        xmin, ymin, xmax, ymax = bbox
        
        # Overpass query to get all data in the bounding box
        query = f"""
        [out:xml][timeout:300][bbox:{ymin},{xmin},{ymax},{xmax}];
        (
          relation;
          way;
          node;
        );
        out meta;
        """
        
        return query.strip()
    
    def download_osm_data(self, bbox: Tuple[float, float, float, float], output_file: str) -> bool:
        """Download OSM data for the bounding box"""
        print_status("Downloading OSM data from Overpass API...")
        
        query = self.build_overpass_query(bbox)
        
        try:
            # Make the request
            response = requests.post(
                self.overpass_url,
                data=query,
                timeout=600,  # 10 minutes timeout
                stream=True
            )
            response.raise_for_status()
            
            # Save to temporary XML file first
            temp_xml = output_file.replace('.osm.pbf', '.osm')
            
            print_status(f"Saving OSM XML data to {temp_xml}")
            with open(temp_xml, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            print_success(f"Downloaded OSM data ({os.path.getsize(temp_xml) / 1024 / 1024:.1f} MB)")
            
            # Convert XML to PBF format
            if self.convert_to_pbf(temp_xml, output_file):
                # Clean up temporary XML file
                os.remove(temp_xml)
                return True
            else:
                print_error("Failed to convert to PBF format")
                return False
                
        except requests.RequestException as e:
            print_error(f"Failed to download OSM data: {e}")
            return False
        except Exception as e:
            print_error(f"Unexpected error: {e}")
            return False
    
    def convert_to_pbf(self, xml_file: str, pbf_file: str) -> bool:
        """Convert OSM XML to PBF format using osmconvert"""
        print_status("Converting OSM XML to PBF format...")
        
        # Check if osmconvert is available
        if not self.check_osmconvert():
            print_error("osmconvert not found. Please install it first.")
            print_status("Installation instructions:")
            print_status("  Ubuntu/Debian: sudo apt-get install osmctools")
            print_status("  macOS: brew install osmctools")
            print_status("  Or download from: https://wiki.openstreetmap.org/wiki/Osmconvert")
            return False
        
        try:
            # Run osmconvert to convert XML to PBF
            cmd = ['osmconvert', xml_file, '-o=' + pbf_file]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            
            if result.returncode == 0:
                print_success(f"Created PBF file: {pbf_file} ({os.path.getsize(pbf_file) / 1024 / 1024:.1f} MB)")
                return True
            else:
                print_error(f"osmconvert failed: {result.stderr}")
                return False
                
        except subprocess.TimeoutExpired:
            print_error("osmconvert timed out")
            return False
        except Exception as e:
            print_error(f"Failed to convert to PBF: {e}")
            return False
    
    def check_osmconvert(self) -> bool:
        """Check if osmconvert is available"""
        try:
            subprocess.run(['osmconvert', '--help'], capture_output=True, timeout=5)
            return True
        except (subprocess.TimeoutExpired, FileNotFoundError):
            return False
    
    def interactive_mode(self):
        """Interactive mode for map generation"""
        print("=" * 50)
        print("OpenStreetMap Custom Map Generator")
        print("=" * 50)
        print()
        
        # Choose input method
        print("How would you like to specify the area?")
        print("1. City/Place name (automatic bounding box)")
        print("2. Manual bounding box coordinates")
        print("3. Popular preset areas")
        
        choice = input("\nEnter choice (1-3): ").strip()
        
        bbox = None
        output_name = None
        
        if choice == "1":
            city = input("Enter city or place name: ").strip()
            if city:
                bbox = self.geocode_city(city)
                output_name = city.lower().replace(' ', '_').replace(',', '') + '.osm.pbf'
        
        elif choice == "2":
            print("\nEnter bounding box coordinates:")
            print("Format: xmin,ymin,xmax,ymax (longitude,latitude)")
            print("Example: -0.489,51.28,0.236,51.686 (Greater London)")
            
            bbox_str = input("Bounding box: ").strip()
            try:
                coords = [float(x.strip()) for x in bbox_str.split(',')]
                if len(coords) == 4:
                    bbox = tuple(coords)
                    output_name = "custom_area.osm.pbf"
                else:
                    print_error("Please provide exactly 4 coordinates")
            except ValueError:
                print_error("Invalid coordinate format")
        
        elif choice == "3":
            presets = {
                "1": ("Manhattan, NYC", (-74.0479, 40.7128, -73.9441, 40.7831)),
                "2": ("Central London", (-0.1778, 51.4893, -0.0762, 51.5279)),
                "3": ("San Francisco", (-122.5149, 37.7081, -122.3574, 37.8085)),
                "4": ("Amsterdam Center", (4.8372, 52.3477, 4.9419, 52.3925)),
                "5": ("Berlin Mitte", (13.3501, 52.4946, 13.4286, 52.5323))
            }
            
            print("\nPreset areas:")
            for key, (name, _) in presets.items():
                print(f"{key}. {name}")
            
            preset_choice = input("\nSelect preset (1-5): ").strip()
            if preset_choice in presets:
                name, bbox = presets[preset_choice]
                output_name = name.lower().replace(' ', '_').replace(',', '') + '.osm.pbf'
                print_status(f"Selected: {name}")
        
        if not bbox:
            print_error("No valid area specified")
            return False
        
        # Get output filename
        default_output = output_name or "custom_map.osm.pbf"
        output_file = input(f"\nOutput filename [{default_output}]: ").strip() or default_output
        
        # Ensure .osm.pbf extension
        if not output_file.endswith('.osm.pbf'):
            output_file += '.osm.pbf'
        
        # Validate and download
        if self.validate_bbox(bbox):
            print_status(f"Generating map for bounding box: {bbox}")
            print_status(f"Output file: {output_file}")
            
            confirm = input("\nProceed with download? (y/N): ").strip().lower()
            if confirm in ['y', 'yes']:
                return self.download_osm_data(bbox, output_file)
        
        return False

def parse_bbox(bbox_str: str) -> Tuple[float, float, float, float]:
    """Parse bounding box string into coordinates"""
    try:
        coords = [float(x.strip()) for x in bbox_str.split(',')]
        if len(coords) != 4:
            raise ValueError("Bounding box must have exactly 4 coordinates")
        return tuple(coords)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"Invalid bounding box format: {e}")

def main():
    parser = argparse.ArgumentParser(
        description="Generate custom OpenStreetMap .osm.pbf files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Interactive mode
  python generate_map.py --interactive
  
  # Generate map for London by city name
  python generate_map.py --city "London, UK" --output london.osm.pbf
  
  # Generate map using bounding box coordinates
  python generate_map.py --bbox "-0.489,51.28,0.236,51.686" --output london.osm.pbf
  
  # Manhattan, NYC
  python generate_map.py --bbox "-74.0479,40.7128,-73.9441,40.7831" --output manhattan.osm.pbf

Bounding box format: xmin,ymin,xmax,ymax (longitude,latitude)
        """
    )
    
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--bbox', type=parse_bbox, 
                      help='Bounding box coordinates: xmin,ymin,xmax,ymax')
    group.add_argument('--city', type=str,
                      help='City or place name to geocode')
    group.add_argument('--interactive', action='store_true',
                      help='Interactive mode')
    
    parser.add_argument('--output', type=str, default='custom_map.osm.pbf',
                       help='Output filename (default: custom_map.osm.pbf)')
    
    args = parser.parse_args()
    
    generator = MapGenerator()
    
    try:
        if args.interactive:
            success = generator.interactive_mode()
        else:
            bbox = None
            
            if args.city:
                bbox = generator.geocode_city(args.city)
                if not bbox:
                    return 1
            else:
                bbox = args.bbox
            
            if generator.validate_bbox(bbox):
                success = generator.download_osm_data(bbox, args.output)
            else:
                return 1
        
        if success:
            print_success("Map generation completed successfully!")
            return 0
        else:
            print_error("Map generation failed")
            return 1
            
    except KeyboardInterrupt:
        print_error("\nOperation cancelled by user")
        return 1
    except Exception as e:
        print_error(f"Unexpected error: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
