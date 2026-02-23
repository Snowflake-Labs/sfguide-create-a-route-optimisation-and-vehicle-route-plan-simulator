---
name: prerequisites-route-optimization-demo
description: "Check prerequisites for the Route Optimization demo project. Triggers: check demo route optimization prerequisites, route optimization prerequisites."
---

# Check ORS Prerequisite

Verifies that the OpenRouteService Native App is installed and running before proceeding with demo deployment.

## Prerequisites

- Active Snowflake connection with ACCOUNTADMIN role

## Workflow

### Step 1: Check OpenRouteService Native App

**Goal:** Verify the OpenRouteService Native App exists

**Actions:**

1. **Check** if the OpenRouteService Native App exists:
   ```sql
   SHOW APPLICATIONS LIKE 'OPENROUTESERVICE_NATIVE_APP';
   ```

2. **If the application does NOT exist:**
   - **STOP** and inform the user:
     > ⚠️ **OpenRouteService Native App is not installed.**
     > 
     > The demo requires the OpenRouteService Native App to provide routing functions.
     > 
     > Please install it first by following the **Install OpenRouteService Native App** quickstart:
     > - Complete the quickstart at: `../oss-install-openrouteservice-native-app/`
     > - Or run the skill directly:
     >   ```
     >   use the local skill from oss-install-openrouteservice-native-app/skills/deploy-route-optimizer
     >   ```
     > 
     > After installation, return and run this demo deployment skill again.
   - **Do NOT proceed** with the remaining steps

3. **If the application EXISTS**, proceed to Step 2

**Output:** OpenRouteService Native App exists

**Next:** Proceed to Step 2

### Step 2: Verify Services are Running

**Goal:** Confirm the ORS services are active

**Actions:**

1. **Check** services status:
   ```sql
   SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```

2. **Verify** all 4 services are running:
   - `OPENROUTESERVICE` - Main routing engine
   - `ROUTING_REVERSE_PROXY` - API gateway
   - `VROOM` - Vehicle routing optimization
   - `DOWNLOADER` - Map download service

3. **If services are not running:**
   - Inform user to activate the app via Snowsight:
     1. Navigate to **Data Products > Apps > OPENROUTESERVICE_NATIVE_APP**
     2. Click **Activate** if prompted
     3. Wait for services to show ✅ RUNNING in Service Manager
   - Wait for user confirmation before proceeding

**Output:** All OpenRouteService services verified as running

**Next:** ORS prerequisite check complete - ready for demo deployment

## Stopping Points

- ✋ Step 1: STOP if OpenRouteService Native App is not installed
- ✋ Step 2: Wait for user to activate app if services not running

## Output

OpenRouteService prerequisite check:
- Native App: ✅ Installed
- Services: ✅ Running

Ready to proceed with demo deployment.
