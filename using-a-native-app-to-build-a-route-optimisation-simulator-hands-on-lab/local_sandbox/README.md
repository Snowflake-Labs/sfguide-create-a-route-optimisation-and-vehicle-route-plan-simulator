# 🏗️ Local Development Sandbox

This sandbox allows you to run the **NYC Beauty Supply Chain Optimizer** Streamlit app locally for development and testing purposes.

## 📋 Prerequisites

1. **Python 3.11+** installed on your system
2. **Access to a Snowflake account** with the lab data
3. **Git** (to clone this repository)

## 🚀 Quick Start

### Option A: Automated Setup (Recommended)

```bash
# Navigate to the sandbox directory
cd local_sandbox

# For Unix/Linux/macOS
./setup.sh

# For Windows
setup.bat
```

### Option B: Manual Setup

```bash
# Navigate to the sandbox directory
cd local_sandbox

# Install Python dependencies
pip install -r requirements.txt
```

### 2. Configure Snowflake Connection

```bash
# Copy the configuration template
cp snowflake_config.template.py snowflake_config.py

# Edit the configuration file with your Snowflake details
# Use your favorite editor (nano, vim, vscode, etc.)
nano snowflake_config.py
```

**Required Configuration:**
```python
SNOWFLAKE_CONFIG = {
    'account': 'your-account-identifier',
    'user': 'your-username', 
    'password': 'your-password',
    'role': 'your-role',
    'warehouse': 'your-warehouse',
    'database': 'your-database',
    'schema': 'your-schema'
}
```

### 3. Test Your Setup (Optional but Recommended)

```bash
# Test your connection and data availability
python test_connection.py
```

This will verify:
- ✅ All required packages are installed
- ✅ Snowflake configuration is valid
- ✅ Connection to Snowflake works
- ✅ Required data tables are accessible

### 4. Run the Application

```bash
# Option 1: Use the runner script (recommended)
python run_local.py

# Option 2: Run Streamlit directly
streamlit run nyc_beauty_routing_local.py
```

The app will automatically open in your browser at `http://localhost:8501`

## 🔧 Configuration Details

### Snowflake Connection Options

**Option 1: Username/Password Authentication**
```python
SNOWFLAKE_CONFIG = {
    'account': 'your-account-identifier',
    'user': 'your-username', 
    'password': 'your-password',
    'role': 'your-role',
    'warehouse': 'your-warehouse',
    'database': 'your-database',
    'schema': 'your-schema'
}
```

**Option 2: Key Pair Authentication (Recommended for Security)**
```python
SNOWFLAKE_CONFIG = {
    'account': 'your-account-identifier',
    'user': 'your-username',
    'private_key_path': '/path/to/your/private_key.p8',
    'role': 'your-role',
    'warehouse': 'your-warehouse', 
    'database': 'your-database',
    'schema': 'your-schema'
}
```

### Required Data Tables

The app expects these tables to exist in your Snowflake environment:
- `FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_DEPOTS`
- `FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_FLEET`  
- `FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_DELIVERY_JOBS`

These are created automatically when you run the lab deployment scripts.

## 🛠️ Development Features

### What Works Locally
- ✅ **Snowflake connectivity** - Connect to your Snowflake environment
- ✅ **Data visualization** - View depot locations and fleet information  
- ✅ **Interactive maps** - Pydeck map layers with depot visualization
- ✅ **UI components** - All Streamlit interface elements
- ✅ **Real-time development** - Hot reload when you save changes

### Limitations in Local Mode
- ⚠️ **Route optimization** - Requires the native app to be installed in Snowflake
- ⚠️ **Advanced routing functions** - Some features need the full Snowflake environment
- ⚠️ **Marketplace data** - Limited to what's available in your environment

## 🔍 Troubleshooting

### Common Issues

**1. "Failed to connect to Snowflake"**
- Check your `snowflake_config.py` credentials
- Verify your Snowflake account is accessible
- Ensure your user has the required permissions

**2. "Table not found" errors**
- Run the lab deployment scripts first to create the required tables
- Verify you're connecting to the correct database/schema
- Check that marketplace listings are properly installed

**3. "Module not found" errors**  
- Ensure all dependencies are installed: `pip install -r requirements.txt`
- Use a Python virtual environment to avoid conflicts

**4. Streamlit won't start**
- Check that port 8501 is not in use by another application
- Try: `streamlit run nyc_beauty_routing_local.py --server.port 8502`

### Getting Help

1. **Check the connection status** in the sidebar when the app loads
2. **Review error messages** - they often contain specific guidance
3. **Compare with the deployed version** in Snowflake to see full functionality

## 📁 File Structure

```
local_sandbox/
├── README.md                           # This file
├── requirements.txt                    # Python dependencies
├── snowflake_config.template.py       # Configuration template
├── snowflake_config.py                # Your config (create this)
├── nyc_beauty_routing_local.py        # Local version of the app
└── run_local.py                       # Runner script
```

## 🚀 Deploying to Production

When you're ready to deploy your changes:

1. **Copy your changes** to the main app file:
   ```bash
   # Copy local changes back to the main app
   cp nyc_beauty_routing_local.py ../dataops/event/streamlit/nyc_beauty_routing.py
   ```

2. **Test in the full environment** using the deployment scripts

3. **Deploy using the lab CI/CD pipeline**

## 🔒 Security Notes

- **Never commit `snowflake_config.py`** - it contains sensitive credentials
- **Use key pair authentication** for production environments  
- **Rotate credentials regularly** and follow your organization's security policies
- **Use environment variables** for CI/CD deployments

---

**Happy Developing! 🎉**

This sandbox provides a full development environment for iterating on your Streamlit apps before deploying to the Snowflake environment.
