# OpenRouteService Native App Installer

This installer provides a streamlined way to deploy the OpenRouteService (ORS) Native App in Snowflake, following **Option 1** from the original guide.

## 🚀 Quick Start

```bash
# Clone or download this installer
cd native-app-installer

# Run the automated installer
./install.sh
```

## 📋 Prerequisites

Before running the installer, ensure you have:

### 1. Snowflake Account
- **Non-trial account required** (trial accounts are not supported)
- Account must support Snowpark Container Services

### 2. Snowflake CLI
- Install from: https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation
- Verify installation: `snow --version`

### 3. Docker Desktop
- Install from: https://docs.docker.com/get-docker/
- Must be running during installation
- Verify: `docker --version` and `docker info`

### 4. Snowflake CLI Connection
Create a connection before running the installer:
```bash
snow connection add --connection-name ors_connection
```

## 🛠 Installation Process

The installer automates the following steps:

### 1. **Environment Setup**
- Creates `OPENROUTESERVICE_SETUP` database
- Creates internal stages for maps, graphs, and elevation cache
- Creates image repository

### 2. **File Upload**
- Uploads map file (default: San Francisco)
- Uploads ORS configuration file
- Refreshes stage metadata

### 3. **Docker Image Build & Push**
- Builds 4 container images:
  - OpenRouteService (routing engine)
  - VROOM (optimization service)
  - Gateway (API proxy)
  - Downloader (map downloader)
- Pushes images to Snowflake image repository

### 4. **Native App Deployment**
- Deploys the application package
- Creates the native app instance

## 🗺 Map Options

### 1. Default Map (Recommended for Testing)
- **San Francisco** (`SanFrancisco.osm.pbf`)
- Size: ~50MB
- Good for initial testing and demos

### 2. Generate Custom Maps ⭐ NEW!
Create maps for any location using bounding box coordinates:

```bash
# Interactive mode (easiest)
./generate_map.sh --interactive

# By city name
./generate_map.sh --city "London, UK" --output london.osm.pbf

# By coordinates (xmin,ymin,xmax,ymax)
./generate_map.sh --bbox "-74.0479,40.7128,-73.9441,40.7831" --output manhattan.osm.pbf
```

**Popular Examples:**
- **Manhattan**: `-74.0479,40.7128,-73.9441,40.7831`
- **Central London**: `-0.1778,51.4893,-0.0762,51.5279`
- **Amsterdam Center**: `4.8372,52.3477,4.9419,52.3925`

See [MAP_GENERATION.md](MAP_GENERATION.md) for detailed guide.

### 3. Pre-built Maps
Use existing OpenStreetMap extracts:

**Map Sources:**
- [BBBike](https://download.bbbike.org/osm) - City-specific extracts
- [Geofabrik](https://download.geofabrik.de) - Country/region extracts

**Size Guidelines:**
- **< 250MB**: Upload via web interface
- **< 5GB**: Use `snow stage copy` or `PUT` command
- **> 5GB**: Load to cloud storage first, then copy

## ⚙️ Configuration

### ORS Configuration File
The installer uses `provider_setup/staged_files/ors-config.yml` with these default profiles:
- `driving-car` - Standard car routing
- `cycling-road` - Bicycle routing  
- `driving-hgv` - Heavy goods vehicle routing

### Compute Resources
- **Default**: Small compute pool
- **For large maps**: Increase `XMX` memory in `services/openrouteservice/openrouteservice.yaml`

## 🔧 Post-Installation

### 1. Activate the App
1. Open Snowsight
2. Navigate to **Data Products** → **Apps**
3. Select `openrouteservice_native_app`
4. Grant required privileges
5. Click **Activate**

### 2. Test the Installation
The app includes a Streamlit interface with API testing examples.

### 3. Service Management
Services auto-suspend after 4 hours. To resume:
```sql
ALTER SERVICE CORE.ORS_SERVICE RESUME;
ALTER SERVICE CORE.ROUTING_GATEWAY_SERVICE RESUME;
ALTER SERVICE CORE.VROOM_SERVICE RESUME;
ALTER SERVICE CORE.DOWNLOADER RESUME;
```

## 🐛 Troubleshooting

### Common Issues

**1. Docker not running**
```bash
# Start Docker Desktop, then verify:
docker info
```

**2. Snowflake connection issues**
```bash
# Test your connection:
snow connection test -c your_connection_name
```

**3. Map file too large**
- Use external stage for files > 5GB
- Increase compute pool size for large maps

**4. Memory issues during graph creation**
- Check container logs
- Increase `XMX` value in OpenRouteService configuration
- Use larger compute pool

### Container Logs
Check logs for detailed error information:
```sql
-- View service logs in Snowsight
SELECT SYSTEM$GET_SERVICE_LOGS('CORE.ORS_SERVICE', '0', 'openrouteservice', 100);
```

## 📁 Directory Structure

```
native-app-installer/
├── install.sh                 # Main installation script
├── README.md                  # This file
├── app/                       # Native app definition
│   ├── manifest.yml
│   ├── setup_script.sql
│   └── README.md
├── code_artifacts/            # Streamlit app
│   └── streamlit/
├── provider_setup/            # Setup scripts and files
│   ├── env_setup.sql
│   ├── spcs_setup.sh
│   └── staged_files/
│       ├── SanFrancisco.osm.pbf
│       └── ors-config.yml
├── services/                  # Container service definitions
│   ├── openrouteservice/
│   ├── gateway/
│   ├── downloader/
│   └── vroom/
├── setup/
│   └── shared_content.sql
└── snowflake.yml             # Snowflake CLI project config
```

## 🔗 API Endpoints

After installation, the following APIs are available:

- **Directions**: Point-to-point routing
- **Isochrones**: Reachability analysis
- **Matrix**: Distance/time matrices
- **Optimization**: Vehicle routing optimization (via VROOM)

## 📚 Additional Resources

- [Original Snowflake Guide](https://quickstarts.snowflake.com/guide/Create-a-Route-Optimisation-and-Vehicle-Route-Plan-Simulator)
- [OpenRouteService Documentation](https://openrouteservice.org/dev/)
- [Snowpark Container Services](https://docs.snowflake.com/en/developer-guide/snowpark-container-services/)
- [VROOM Optimization](https://vroom-project.org/)

## 🆘 Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review container logs
3. Consult the original documentation
4. Check Snowflake community forums

---

**Happy Routing!** 🚗🗺️