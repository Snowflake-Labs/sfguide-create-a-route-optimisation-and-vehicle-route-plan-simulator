# 🚀 Quick Start Guide

Get your OpenRouteService Native App running in Snowflake in under 10 minutes!

## Step 1: Prerequisites (2 minutes)

### Install Required Tools
```bash
# Install Snowflake CLI (if not already installed)
# Visit: https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation

# Install Docker Desktop (if not already installed)  
# Visit: https://docs.docker.com/get-docker/

# Verify installations
snow --version
docker --version
```

### Create Snowflake Connection
```bash
# Create a new connection (replace with your details)
snow connection add --connection-name ors_connection
```

## Step 2: Validate Setup (30 seconds)

```bash
cd native-app-installer
./validate.sh
```

Fix any issues reported by the validation script.

## Step 3: Install (5-7 minutes)

```bash
./install.sh
```

The installer will:
- ✅ Setup Snowflake environment
- ✅ Upload map files (or generate custom maps!)
- ✅ Build Docker containers
- ✅ Deploy the native app

### 🗺️ Map Options During Install
When prompted, you can:
1. **Use default San Francisco map** (fastest)
2. **Upload your own .osm.pbf file**
3. **Generate custom map by coordinates** ⭐ NEW!
4. **Generate custom map by city name** ⭐ NEW!

**Example custom map generation:**
```
Choose option [1]: 4
Enter city or place name: London, UK
Enter map name [London_UK]: london
```

## Step 4: Activate App (1 minute)

1. Open **Snowsight** in your browser
2. Go to **Data Products** → **Apps**
3. Find **openrouteservice_native_app**
4. Click **Grant Privileges** → **Activate**

## Step 5: Test (30 seconds)

The app opens with a Streamlit interface containing API examples. Try:

- **Directions**: Get routes between points
- **Isochrones**: Find reachable areas
- **Optimization**: Solve vehicle routing problems

## 🎉 You're Done!

Your OpenRouteService is now running in Snowflake with:
- ✅ Routing engine (OpenRouteService)
- ✅ Optimization engine (VROOM)  
- ✅ API gateway
- ✅ Map downloader service

## Next Steps

- Explore the API examples in the Streamlit app
- Upload your own map files for different regions
- Integrate with your existing Snowflake applications
- Check out the full documentation in `README.md`

## Need Help?

- **Validation fails**: Check `README.md` troubleshooting section
- **Installation errors**: Review the error messages and container logs
- **App won't activate**: Ensure you have proper Snowflake privileges

---
**Total time: ~10 minutes** ⏱️
