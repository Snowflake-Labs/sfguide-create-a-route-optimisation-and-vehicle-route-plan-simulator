@echo off
REM Quick setup script for NYC Beauty Supply Chain Optimizer local development (Windows)

echo 🏗️ Setting up NYC Beauty Supply Chain Optimizer - Local Development
echo ==================================================================

REM Check if Python is installed
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Python 3 is required but not installed.
    echo Please install Python 3.11+ and try again.
    pause
    exit /b 1
)

echo ✅ Python found
python --version

REM Install dependencies
echo 📦 Installing Python dependencies...
pip install -r requirements.txt

if %errorlevel% neq 0 (
    echo ❌ Failed to install dependencies
    pause
    exit /b 1
)

echo ✅ Dependencies installed successfully

REM Check if config file exists
if not exist "snowflake_config.py" (
    echo ⚙️ Creating Snowflake configuration template...
    copy snowflake_config.template.py snowflake_config.py
    echo ✅ Configuration template created: snowflake_config.py
    echo 📝 Please edit snowflake_config.py with your Snowflake connection details
) else (
    echo ✅ Snowflake configuration already exists
)

echo.
echo 🎉 Setup complete!
echo.
echo Next steps:
echo 1. Edit snowflake_config.py with your Snowflake connection details
echo 2. Run the app: python run_local.py
echo.
echo For detailed instructions, see README.md
echo.
pause
