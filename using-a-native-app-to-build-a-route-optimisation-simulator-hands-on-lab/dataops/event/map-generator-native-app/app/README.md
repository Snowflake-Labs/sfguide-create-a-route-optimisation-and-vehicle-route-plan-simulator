# OpenStreetMap Generator Native App

Generate custom OpenStreetMap files for any location worldwide directly within Snowflake.

## 🌟 Features

- **🌍 Global Coverage**: Generate maps for any location worldwide
- **🏙️ City Search**: Find locations by city or place name using geocoding
- **📐 Precise Coordinates**: Use exact bounding box coordinates
- **🎯 Popular Presets**: Quick access to major cities and regions
- **📊 Generation History**: Track all your map generations with detailed metrics
- **⚡ Fast Processing**: Powered by Snowflake's cloud infrastructure
- **🔒 Secure Access**: External API access through Snowflake integrations

## 🚀 Quick Start

1. **Install the App**: Grant required privileges and activate
2. **Open Streamlit Interface**: Access the interactive map generator
3. **Choose Generation Method**: 
   - City/Place name (e.g., "London, UK")
   - Bounding box coordinates (e.g., "-0.1778,51.4893,-0.0762,51.5279")
   - Preset areas (Manhattan, Central London, etc.)
4. **Generate Map**: Click generate and wait for processing
5. **Download**: Access your custom .osm file from the generated maps stage

## 📐 Coordinate Format

Bounding boxes use the format: `xmin,ymin,xmax,ymax`
- **xmin/xmax**: Longitude (-180 to 180)
- **ymin/ymax**: Latitude (-90 to 90)

### Example Coordinates:
- **Manhattan, NYC**: `-74.0479,40.7128,-73.9441,40.7831`
- **Central London**: `-0.1778,51.4893,-0.0762,51.5279`
- **San Francisco**: `-122.5149,37.7081,-122.3574,37.8085`

## 🛠️ Technical Details

### Data Sources
- **OpenStreetMap**: Via Overpass API for map data
- **Nominatim**: For geocoding city names to coordinates

### External Access Requirements
This app requires external network access to:
- `overpass-api.de:443` - OpenStreetMap data download
- `nominatim.openstreetmap.org:443` - City geocoding

### Generated Files
- **Format**: OSM XML (compatible with routing engines)
- **Storage**: Snowflake internal stage (`core.generated_maps`)
- **Tracking**: Complete generation history with metrics

## 📊 Usage Examples

### Generate by City Name
```sql
CALL core.generate_map('city', 
  PARSE_JSON('{"city_name": "London, UK", "output_filename": "london.osm"}')
);
```

### Generate by Coordinates
```sql
CALL core.generate_map('bbox', 
  PARSE_JSON('{"bbox": "-0.1778,51.4893,-0.0762,51.5279", "output_filename": "london_center.osm"}')
);
```

### View Generation History
```sql
SELECT * FROM core.map_generation_history;
```

### Get Preset Areas
```sql
SELECT * FROM TABLE(core.get_preset_areas());
```

## 🎯 Use Cases

- **Route Planning**: Generate maps for OpenRouteService, OSRM, or Valhalla
- **Logistics Optimization**: Create custom routing datasets for delivery planning
- **Urban Analysis**: Extract city data for transportation studies
- **Demo Preparation**: Quick map generation for specific customer locations
- **Development Testing**: Create test datasets for routing applications

## ⚠️ Limitations

- **Area Size**: Large areas (>1 deg²) may fail or take very long to process
- **Rate Limits**: Subject to OpenStreetMap API rate limits
- **Data Freshness**: Maps reflect current OpenStreetMap data at generation time
- **Format**: Currently generates OSM XML format only

## 🆘 Troubleshooting

### Common Issues

**Generation Timeout**: Reduce area size or try again later
**City Not Found**: Try different spelling or include country/region
**Large File Warning**: Consider using smaller bounding box
**Network Errors**: Check external access integration configuration

### Support

For technical issues:
1. Check the generation history for error details
2. Verify external access integration is properly configured
3. Ensure network rules allow access to required domains
4. Review Snowflake logs for detailed error information

## 📚 Resources

- [OpenStreetMap](https://www.openstreetmap.org/) - Source data
- [Overpass API](https://overpass-api.de/) - Data extraction service
- [Nominatim](https://nominatim.org/) - Geocoding service
- [Snowflake Native Apps](https://docs.snowflake.com/en/developer-guide/native-apps/) - Platform documentation

---

**Data License**: Generated maps contain OpenStreetMap data © OpenStreetMap contributors, licensed under ODbL.
