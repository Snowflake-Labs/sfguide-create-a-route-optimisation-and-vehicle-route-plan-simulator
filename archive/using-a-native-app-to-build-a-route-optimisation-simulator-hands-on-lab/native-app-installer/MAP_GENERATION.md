# Custom Map Generation Guide

Generate custom OpenStreetMap files for any region in the world using bounding box coordinates or city names.

## 🗺️ Overview

The installer includes powerful map generation tools that allow you to create `.osm.pbf` files for any geographic area. This is perfect for:

- **Testing routing in specific regions**
- **Creating demos for particular cities**
- **Working with areas not covered by preset maps**
- **Generating maps for customer locations**

## 🚀 Quick Start

### Option 1: Interactive Mode (Easiest)
```bash
./generate_map.sh --interactive
```

### Option 2: Generate by City Name
```bash
./generate_map.sh --city "London, UK" --output london.osm.pbf
```

### Option 3: Generate by Bounding Box
```bash
./generate_map.sh --bbox "-0.489,51.28,0.236,51.686" --output london.osm.pbf
```

### Option 4: Python Version (More Features)
```bash
python3 generate_map.py --interactive
```

## 📐 Understanding Bounding Boxes

A bounding box defines a rectangular area using four coordinates:

```
Format: xmin,ymin,xmax,ymax
Where:
  xmin = Western longitude  (-180 to 180)
  ymin = Southern latitude  (-90 to 90)
  xmax = Eastern longitude  (-180 to 180)
  ymax = Northern latitude  (-90 to 90)
```

### Example Bounding Boxes

| Location | Bounding Box | Description |
|----------|--------------|-------------|
| **Manhattan, NYC** | `-74.0479,40.7128,-73.9441,40.7831` | Dense urban area |
| **Central London** | `-0.1778,51.4893,-0.0762,51.5279` | City center |
| **San Francisco** | `-122.5149,37.7081,-122.3574,37.8085` | Full city |
| **Amsterdam Center** | `4.8372,52.3477,4.9419,52.3925` | Historic center |
| **Berlin Mitte** | `13.3501,52.4946,13.4286,52.5323` | Central district |

## 🛠️ Installation Requirements

### Required Tools
```bash
# Basic requirements (always needed)
curl                    # For downloading data
bc                      # For coordinate calculations

# Optional but recommended
jq                      # For city name geocoding
osmctools              # For PBF format conversion
```

### Install on Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install curl bc jq osmctools
```

### Install on macOS
```bash
brew install curl bc jq osmctools
```

## 📍 Finding Bounding Box Coordinates

### Method 1: Online Tools
1. **OpenStreetMap Export**: https://www.openstreetmap.org/export
   - Navigate to your area
   - Click "Export" → "Manually select a different area"
   - Drag to select your region
   - Copy the coordinates shown

2. **BBox Finder**: http://bboxfinder.com/
   - Draw a rectangle on the map
   - Copy the coordinates in the format: `xmin,ymin,xmax,ymax`

3. **Geofabrik Tools**: https://tools.geofabrik.de/calc/
   - Interactive map with coordinate display

### Method 2: City Name Geocoding
The tools can automatically find coordinates for cities:
```bash
./generate_map.sh --city "Tokyo, Japan" --output tokyo.osm.pbf
```

### Method 3: GPS Coordinates
If you have GPS coordinates, convert them to a bounding box:
```bash
# Center point: 40.7589, -73.9851 (Times Square)
# Add/subtract ~0.01 degrees for a small area around the point
./generate_map.sh --bbox "-73.9951,40.7489,-73.9751,40.7689" --output times_square.osm.pbf
```

## 📊 Map Size Guidelines

| Area Size | Coordinates Difference | Example | Download Time | File Size |
|-----------|----------------------|---------|---------------|-----------|
| **Small** | ~0.01° × 0.01° | Neighborhood | 30 seconds | 1-10 MB |
| **Medium** | ~0.1° × 0.1° | City district | 2-5 minutes | 10-100 MB |
| **Large** | ~0.5° × 0.5° | Metropolitan area | 10-30 minutes | 100-500 MB |
| **Very Large** | ~1.0° × 1.0° | Region/state | 30+ minutes | 500+ MB |

### Size Recommendations
- **Testing/Development**: Use small areas (neighborhoods)
- **Demos**: Use medium areas (city centers)
- **Production**: Use appropriate size for your use case
- **Large Areas**: Consider using Geofabrik extracts instead

## 🔧 Advanced Usage

### Custom Configuration
Edit the map generation scripts to customize:
- **Overpass API endpoint** (use different servers)
- **Timeout values** (for large downloads)
- **Output formats** (XML vs PBF)
- **Data filtering** (roads only, specific features)

### Batch Generation
Generate multiple maps:
```bash
#!/bin/bash
cities=(
    "London,UK:london"
    "Paris,France:paris"
    "Berlin,Germany:berlin"
)

for city_info in "${cities[@]}"; do
    IFS=':' read -r city filename <<< "$city_info"
    ./generate_map.sh --city "$city" --output "${filename}.osm.pbf"
done
```

### Integration with Installer
The main installer automatically offers map generation:
```bash
./install.sh
# Choose option 3 or 4 when prompted for map selection
```

## 🐛 Troubleshooting

### Common Issues

**1. Download Timeout**
```
Error: Request timed out
```
**Solution**: Use a smaller bounding box or try again later

**2. No Data Found**
```
Error: No OSM data in the specified area
```
**Solution**: Check coordinates are in correct order (xmin < xmax, ymin < ymax)

**3. Large File Warning**
```
Warning: Large area detected
```
**Solution**: Consider using smaller area or Geofabrik extracts

**4. osmconvert Not Found**
```
Warning: osmconvert not found. Only XML output available.
```
**Solution**: Install osmctools package

### Performance Tips

1. **Use Smaller Areas**: Start with small regions for testing
2. **Off-Peak Hours**: Download during off-peak hours for better performance
3. **Local Overpass**: Use local Overpass API instance for large-scale usage
4. **Caching**: Save generated maps for reuse

## 🌍 Alternative Data Sources

For very large areas or production use, consider these alternatives:

### Geofabrik Extracts
- **URL**: https://download.geofabrik.de/
- **Coverage**: Countries and regions
- **Format**: Ready-to-use .osm.pbf files
- **Update**: Daily updates

### BBBike Extracts
- **URL**: https://extract.bbbike.org/
- **Coverage**: Custom areas up to 24 million km²
- **Format**: Multiple formats including .osm.pbf
- **Features**: Web interface for area selection

### Planet OSM
- **URL**: https://planet.openstreetmap.org/
- **Coverage**: Entire world
- **Size**: ~100GB compressed
- **Use Case**: Complete global datasets

## 🔗 Integration Examples

### Use with ORS Configuration
After generating a custom map, update the ORS config:
```yaml
ors:
  engine:
    profile_default:
      build: 
        source_file: /home/ors/files/your_custom_map.osm.pbf
```

### Snowflake Upload
```bash
# Generate map
./generate_map.sh --city "Your City" --output your_city.osm.pbf

# Upload to Snowflake stage
snow stage copy your_city.osm.pbf @openrouteservice_setup.public.ors_spcs_stage -c your_connection
```

## 📚 Additional Resources

- [OpenStreetMap Wiki](https://wiki.openstreetmap.org/)
- [Overpass API Documentation](https://wiki.openstreetmap.org/wiki/Overpass_API)
- [OSM Data Formats](https://wiki.openstreetmap.org/wiki/OSM_file_formats)
- [Bounding Box Tutorial](https://wiki.openstreetmap.org/wiki/Bounding_Box)

---

**Happy Mapping!** 🗺️✨
