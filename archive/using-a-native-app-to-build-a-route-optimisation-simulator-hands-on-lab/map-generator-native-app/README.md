# OpenStreetMap Generator - Snowflake Native App

A powerful Snowflake Native App that generates custom OpenStreetMap files for any location worldwide using external access integrations.

## 🌟 Overview

This native app allows you to generate custom `.osm` files directly within Snowflake by leveraging:
- **OpenStreetMap Overpass API** for map data extraction
- **Nominatim API** for geocoding city names to coordinates
- **Snowflake External Access Integrations** for secure API communication
- **Interactive Streamlit UI** for easy map generation

## 🚀 Features

### 🌍 **Global Map Generation**
- Generate maps for any location worldwide
- Support for cities, regions, countries, or custom areas
- Real-time data from OpenStreetMap

### 🎯 **Multiple Input Methods**
- **City Names**: "London, UK", "Manhattan, New York", "Tokyo, Japan"
- **Bounding Box Coordinates**: Precise coordinate specification
- **Preset Areas**: Quick access to popular cities and regions

### 📊 **Comprehensive Tracking**
- Generation history with detailed metrics
- File size and processing time tracking
- Error logging and troubleshooting information

### ⚡ **High Performance**
- Powered by Snowflake's cloud infrastructure
- Parallel processing capabilities
- Automatic retry and error handling

## 📦 Installation

### Prerequisites
- Snowflake account with Native Apps support
- Snowflake CLI installed and configured
- Appropriate privileges for creating native apps

### Quick Install
```bash
# Clone or download this repository
cd map-generator-native-app

# Run the installer
./install.sh
```

### Manual Installation
```bash
# Deploy using Snowflake CLI
snow app run -c your_connection_name
```

## 🛠️ Configuration

### External Access Requirements
The app requires external network access to these domains:
- `overpass-api.de:443` - OpenStreetMap data download
- `nominatim.openstreetmap.org:443` - City name geocoding

These are automatically configured through the external access integration.

### Required Privileges
During installation, you'll need to grant:
- **External Access Integration**: For API communication
- **Create Network Rule**: For defining allowed endpoints
- **Create Stage**: For storing generated map files

## 📐 Usage

### Coordinate Format
Bounding boxes use the format: `xmin,ymin,xmax,ymax`
- **xmin/xmax**: Longitude (-180 to 180)
- **ymin/ymax**: Latitude (-90 to 90)

### Example Coordinates
| Location | Bounding Box | Area Size |
|----------|--------------|-----------|
| **Manhattan, NYC** | `-74.0479,40.7128,-73.9441,40.7831` | ~60 km² |
| **Central London** | `-0.1778,51.4893,-0.0762,51.5279` | ~40 km² |
| **San Francisco** | `-122.5149,37.7081,-122.3574,37.8085` | ~120 km² |
| **Amsterdam Center** | `4.8372,52.3477,4.9419,52.3925` | ~25 km² |

### Streamlit Interface

#### 🏠 **Home Page**
- Overview of recent activity
- Quick access to popular areas
- Feature highlights and getting started guide

#### 🗺️ **Generate Map**
- **City Search**: Enter any city or place name
- **Coordinate Input**: Specify exact bounding box coordinates  
- **Preset Areas**: Choose from popular predefined locations
- **Real-time Preview**: See location details before generation

#### 📊 **Generation History**
- Complete history of all map generations
- Filtering by status, type, and date
- Performance metrics and file information
- Error details for troubleshooting

#### 🎯 **Preset Areas**
- Quick access to major cities worldwide
- One-click generation for popular locations
- Detailed area descriptions and coordinates

### SQL API

#### Generate Map by City
```sql
CALL core.generate_map('city', 
  PARSE_JSON('{"city_name": "London, UK", "output_filename": "london.osm"}')
);
```

#### Generate Map by Coordinates
```sql
CALL core.generate_map('bbox', 
  PARSE_JSON('{"bbox": "-0.1778,51.4893,-0.0762,51.5279", "output_filename": "london_center.osm"}')
);
```

#### View Generation History
```sql
SELECT * FROM core.map_generation_history 
ORDER BY request_timestamp DESC;
```

#### Get Available Preset Areas
```sql
SELECT * FROM TABLE(core.get_preset_areas());
```

#### Geocode City Name
```sql
SELECT core.geocode_city('Paris, France') as geocode_result;
```

## 📁 File Management

### Generated Files
- **Storage**: `core.generated_maps` stage
- **Format**: OSM XML (compatible with routing engines)
- **Naming**: User-specified or auto-generated from area name
- **Access**: Full read/write access through the app

### File Operations
```sql
-- List generated files
LIST @core.generated_maps;

-- Download file
GET @core.generated_maps/london.osm file:///local/path/;

-- Remove old files
REMOVE @core.generated_maps/old_map.osm;
```

## 🎯 Use Cases

### **Route Planning & Navigation**
- Generate maps for OpenRouteService, OSRM, or Valhalla
- Create custom routing datasets for specific regions
- Support for different transportation modes

### **Logistics & Delivery**
- Optimize delivery routes for specific areas
- Create maps for warehouse catchment analysis
- Support last-mile delivery planning

### **Urban Planning & Analysis**
- Extract city infrastructure data
- Analyze transportation networks
- Support urban mobility studies

### **Application Development**
- Generate test datasets for routing applications
- Create demo maps for customer presentations
- Support development and testing workflows

## ⚡ Performance Guidelines

### Area Size Recommendations
- **Small** (< 0.01 deg²): Neighborhoods, districts - Fast generation
- **Medium** (0.01-0.1 deg²): Cities, metropolitan areas - Moderate time
- **Large** (0.1-1.0 deg²): Regions, states - Slower generation
- **Very Large** (> 1.0 deg²): May fail or timeout

### Optimization Tips
1. **Start Small**: Test with small areas first
2. **Use Presets**: Leverage predefined popular areas
3. **Monitor History**: Check past generations for optimal sizes
4. **Peak Hours**: Avoid peak times for large area generation

## 🐛 Troubleshooting

### Common Issues

#### **Generation Timeout**
- **Cause**: Area too large or API overloaded
- **Solution**: Use smaller bounding box or try again later

#### **City Not Found**
- **Cause**: Ambiguous or misspelled city name
- **Solution**: Include country/region or try alternative spelling

#### **Network Errors**
- **Cause**: External access integration issues
- **Solution**: Verify integration configuration and network rules

#### **Large File Warnings**
- **Cause**: Area size exceeds recommended limits
- **Solution**: Split into smaller areas or use regional extracts

### Debugging Steps
1. Check generation history for error details
2. Verify external access integration status
3. Test with smaller, known-good coordinates
4. Review Snowflake logs for detailed error information

## 🔒 Security & Privacy

### Data Handling
- **No Personal Data**: Only geographic coordinates processed
- **Temporary Storage**: API responses not permanently stored
- **Secure Communication**: All API calls use HTTPS
- **Access Control**: Managed through Snowflake's security model

### External Dependencies
- **OpenStreetMap**: Public geographic data (ODbL license)
- **Overpass API**: Public API for OSM data extraction
- **Nominatim**: Public geocoding service

## 📚 Technical Architecture

### Components
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Streamlit UI  │    │  Python UDFs    │    │ External APIs   │
│                 │◄──►│                  │◄──►│                 │
│ - Map Generator │    │ - Geocoding      │    │ - Overpass API  │
│ - History View  │    │ - Data Download  │    │ - Nominatim     │
│ - Preset Areas  │    │ - Validation     │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 ▼
                    ┌──────────────────────┐
                    │   Snowflake Storage  │
                    │                      │
                    │ - Generated Maps     │
                    │ - Request History    │
                    │ - Metadata Tables    │
                    └──────────────────────┘
```

### Data Flow
1. **User Input**: City name or coordinates via Streamlit
2. **Geocoding**: Convert city names to coordinates (if needed)
3. **Validation**: Check coordinate ranges and area size
4. **API Call**: Request map data from Overpass API
5. **Processing**: Download and validate OSM data
6. **Storage**: Save generated map to Snowflake stage
7. **Tracking**: Record generation metrics and history

## 🔄 Updates & Maintenance

### Version Management
- **Semantic Versioning**: Major.Minor.Patch format
- **Backward Compatibility**: Maintained across minor versions
- **Migration Scripts**: Provided for major version upgrades

### Monitoring
- **Generation Metrics**: Success rates, processing times
- **Error Tracking**: Detailed error logs and patterns
- **Usage Analytics**: Popular areas and generation trends

## 📄 License & Attribution

### Application License
This Snowflake Native App is provided under the MIT License.

### Data License
Generated maps contain OpenStreetMap data:
- **Copyright**: © OpenStreetMap contributors
- **License**: Open Database License (ODbL)
- **Attribution**: Required when using generated maps

### API Services
- **Overpass API**: Provided by the OpenStreetMap community
- **Nominatim**: Provided by the OpenStreetMap Foundation

## 🆘 Support

### Getting Help
1. **Documentation**: Check this README and app documentation
2. **Generation History**: Review error messages in the app
3. **Snowflake Logs**: Check native app logs for detailed errors
4. **Community**: OpenStreetMap and Snowflake community forums

### Reporting Issues
When reporting issues, please include:
- Error messages from generation history
- Coordinates or city names that failed
- Snowflake account region and app version
- Steps to reproduce the issue

---

**Happy Mapping!** 🗺️✨

*Generate custom maps for any location worldwide, powered by Snowflake's cloud infrastructure and OpenStreetMap's comprehensive geographic data.*
