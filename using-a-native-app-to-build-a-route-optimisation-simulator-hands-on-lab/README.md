# Fleet Intelligence Lab - Route Optimization Simulator

This repository contains a hands-on lab for building a route optimization simulator using Snowflake, Streamlit, and the Open Route Service (ORS) Native App. The project demonstrates fleet intelligence, vehicle routing optimization, and geospatial analysis for delivery scenarios.

## Overview

This project contains the configuration to automate the setup of Hands on Labs. The DataOps HOL engine provisions new attendee accounts (AKA child accounts) for an event and runs all configuration defined in this project. 

## Build a Hands on Lab

### Getting Started 

You will first fork this project to configure a particular HOL. Once you have your new repo, the easiest way to develop solutions is via the Develop button in the repo. This launches a web IDE with the project preloaded. 

![develop](dataops/event/homepage/docs/assets/develop.png)

### Repository Structure

The following SQL scripts are used to setup an attendee account. Written as Jinja templates, the scripts make use of the variables available when the pipeline runs. We will cover the details of each file in following sections. 

| Script                          | Location                                                                                                       | Description                                                       |
|---------------------------------|----------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| configure_attendee_account.sql  | [dataops/event/configure_attendee_account.template.sql](dataops/event/configure_attendee_account.template.sql) | This script configures the attendee account.                      |
| deploy_notebooks.sql            | [dataops/event/deploy_notebooks.template.sql](dataops/event/deploy_notebooks.template.sql)                     | This script deploys an example notebook to the attendee account.  |
| deploy_streamlit.sql            | [dataops/event/deploy_streamlit.template.sql](dataops/event/deploy_streamlit.template.sql)                     | This script deploys an example Streamlit app to the attendee account. |

### Add Project Variables

The first step is defining variables used in the setup scripts. You can add these variables from your repository > Settings > CI/CD > Variables. Defaults are set in [variables.yml](dataops/event/variables.yml).

![ci-cd](dataops/event/homepage/docs/assets/ci-cd-data-sharing.png)

This is the full list of variables that are referenced in the setup scripts. 

| Variable Name                 | Description                                                     |
|-------------------------------|-----------------------------------------------------------------|
| EVENT_WAREHOUSE               | The warehouse created in the attendee account.                  |
| EVENT_DATABASE                | The database created in the attendee account.                  |
| EVENT_SCHEMA                  | The schema created in the attendee account.                     |
| EVENT_ATTENDEE_ROLE           | The role created in the attendee account for the attendee user. |
| EVENT_USER_NAME               | The user name for the attendee user.                            |
| EVENT_USER_PASSWORD           | The password for the attendee user.                             |
| EVENT_ADMIN_NAME              | The user name for the admin user.                               |
| EVENT_ADMIN_PASSWORD          | The password for the admin user.                                |
| EVENT_DATA_SHARING            | The flag to enable data sharing with the attendee account.      |
| EVENT_DEPLOY_NOTEBOOKS        | The flag to enable notebook deployment to the attendee account. |
| NOTEBOOKS_SCHEMA              | The schema for the example notebook.                            |
| EVENT_DEPLOY_STREAMLIT        | The flag to enable Streamlit app deployment to the attendee account. |
| STREAMLIT_SCHEMA              | The schema for the example Streamlit app.                       |

### Core Account Setup

Alter [dataops/event/share_data_to_attendee.template.sql](dataops/event/share_data_to_attendee.template.sql) to configure core details in child accounts, such as databases, roles, and data. Most custom setup will be added at the end of the script. You can think of this as a setup script from a quickstart. 

### Notebooks

1. **Upload Files** - Add the relevant ipynb and environment.yml files to the dataops/event/notebooks folder. 
2. **Alter Setup Script** - Alter [dataops/event/deploy_notebooks.template.sql](dataops/event/deploy_notebooks.template.sql) to deploy the notebook to each child account. The relevant pieces of the script are below. You will alter `example_notebook.ipynb` to your notebook and change `EXAMPLE_NOTEBOOK` to the name you would like in Snowflake. Duplicate all of this code if your solution has more than one notebook. 
```sql
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/example_notebook.ipynb @{{ env.DATAOPS_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.EXAMPLE_NOTEBOOK_STAGE auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/environment.yml @{{ env.DATAOPS_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.EXAMPLE_NOTEBOOK_STAGE auto_compress = false overwrite = true;

CREATE OR REPLACE NOTEBOOK {{ env.DATAOPS_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.EXAMPLE_NOTEBOOK
    FROM '@{{ env.DATAOPS_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.EXAMPLE_NOTEBOOK_STAGE'
    MAIN_FILE = 'example_notebook.ipynb'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}';

ALTER NOTEBOOK {{ env.DATAOPS_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.EXAMPLE_NOTEBOOK ADD LIVE VERSION FROM LAST;

```

### Streamlit

1. **Upload Files** - Add the relevant ipynb and environment.yml files to the dataops/event/streamlit folder. 
2. **Alter Setup Script** - Alter [dataops/event/deploy_notebooks.template.sql](dataops/event/deploy_streamlit.template.sql) to deploy the app to each child account. The relevant pieces of the script are below. You will alter `app.py` to your app file and change `EXAMPLE_STREAMLIT` to the name you would like in Snowflake. Duplicate all of this code if your solution has more than one app.
```sql
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/app.py @{{ env.DATAOPS_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.EXAMPLE_STREAMLIT_STAGE auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @{{ env.DATAOPS_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.EXAMPLE_STREAMLIT_STAGE auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT {{ env.DATAOPS_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.EXAMPLE_STREAMLIT
    ROOT_LOCATION = '@{{ env.DATAOPS_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.EXAMPLE_STREAMLIT_STAGE'
    MAIN_FILE = 'app.py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}';
```

### Data Sharing

Follow these steps to share data into child accounts:
1. **Access Data Sharing Snowflake Account** - you can share data to child account by creating a organization listing in the Innovation Showcase data sharing [Snowflake account](https://ljb99524.snowflakecomputing.com/). Reach out to the Innovation Showcase team for help with credentials.
2. **Materialize Data in Snowflake Account** - load your data into the account or materialize a share.
3. **Create Internal Marketplace Listing** - Create an internal marketplace listing. Make sure all accounts in the org have access to it. 
![create-listing](dataops/event/homepage/docs/assets/internal-marketplace.png)
4. **Publish the listing** - Note the ULL as you will need this in the next step
![ULL](dataops/event/homepage/docs/assets/ull.png)
5. **Enable Data Sharing in DataOps Project** - Navigate to Settings > CI/CD > Variables and add EVENT_DATA_SHARING variable to "true".
6. **Alter Setup Script** - Change [dataops/event/share_data_to_attendee.template.sql](dataops/event/share_data_to_attendee.template.sql) to mount the ULL in each account and grant imported privileges. 

```sql
{% if env.EVENT_DATA_SHARING == "true" %}
use role accountadmin;
create database if not exists <child_db_name> from listing ORGDATACLOUD$INTERNAL$<ULL>;
grant imported privileges on database <child_db_name> to role PUBLIC;
grant imported privileges on database <child_db_name> to role event_role;
{% endif %}
```

### Attendee Instructions

Attendee Instructions are available for each attendee when they are provisioned an account. Add all relevant documentation for attendees to complete their HOL. Here are the steps to develop the instructions:

1. **Alter [index.md](dataops/event/homepage/docs/index.md)** - This is the default landing page for attendees and should give a high level overview of the HOL.
2. **Create other pages** - Create new markdown files in the dataops/event/homepage/docs folder. These will be the subsequent pages in your attendee instructions. 
3. **Add new pages to site** - Add your new markdown files under the Event header of [mkdocs.yml](dataops/event/homepage/mkdocs.yml)
```yml
nav:
  - Event:
      - index.md
      - step1.md
```
4. **Preview Your Docs** - to run the homepage in a develop workspace, run the following commands:
```bash
cd dataops/event/homepage
$(pyenv which pip) install -U -r requirements.txt
mkdocs serve
```

## Other Reference Information

The following sections contain other details about how we configure events. You shouldn't need to adjust these when configuring your project. 

### Pipeline overview table

The automated setup is done using jobs located at [pipelines/includes/local_includes/](pipelines/includes/local_includes/). The DataOps jobs handle running the SQL scripts referenced in the configuration section. 

| Job                        | Stage                    | Description                                                   |
|----------------------------|--------------------------|---------------------------------------------------------------|
| Initialise Pipeline        | Pipeline Initialisation  | This job sets up the pipeline.                                |
| Build Homepage             | Pipeline Initialisation  | This job builds the event instructions specific for attendee. |
| Share Data To Attendee     | Data Sharing             | (Optional) This job shares data with the attendee account.    |
| Configure Attendee Account | Attendee Account Setup   | This job configures the attendee account.                     |
| Deploy Notebooks           | Additional Configuration | This job deploys notebooks to the attendee account.           |
| Deploy Streamlit           | Additional Configuration | This job deploys Streamlit to the attendee account.           |

### Event Configuration Variables from Event Management App

These variables are set for each event when it is created. Feel free to reference them in the attendee instructions if relevant. 

| Variable Name                 | Description                                               |
|-------------------------------|-----------------------------------------------------------|
| EVENT_NAME                    | The name of the event.                                    |
| EVENT_SLUG                    | The slug of the event.                                    |
| EVENT_START_DATETIME          | The start date and time of the event.                     |
| EVENT_END_DATETIME            | The end date and time of the event.                       |
| EVENT_DECOMMISSION_DATETIME   | The decommission date and time of the event.              |
| EVENT_CHILD_ACCOUNT_NAME      | The name of the attendee account.                         |
| EVENT_CHILD_ACCOUNT_SLUG      | The slug of the attendee account.                         |
| EVENT_ORG_NAME                | The org name where the attendee accounts are provisioned. |

### Attendee Account Outputs for Go App

The following file defines the outputs of the attendee account setup. These variables are used to pass information to the attendee through the Event Management App. In particular, these variables are used in the Go App and is configured via markdown when the event is created. 

[dataops/event/attendee_account_outputs.template.env](dataops/event/attendee_account_outputs.template.env)

At the end of the Configure Attendee Account job, this .env file gets created as a job artifact. The Event Management App reads this file to get the content.

## Route Optimization Development Guide

### Route Geometry Extraction from OPTIMIZATION Service

The `OPEN_ROUTE_SERVICE_NEW_YORK.CORE.OPTIMIZATION` function returns route geometry as **arrays of coordinate pairs** directly in the optimization results. Here's the correct extraction pattern:

#### OPTIMIZATION Result Structure
```json
{
  "routes": [
    {
      "vehicle": 1,
      "geometry": [
        [-73.96447, 40.7731],    // [longitude, latitude] pairs
        [-73.96401, 40.77374], 
        [-73.96356, 40.77438],
        // ... hundreds more coordinate pairs for road-based routing
      ],
      "steps": [...],
      "duration": 2245
    }
  ]
}
```

#### CORRECT Geometry Extraction Pattern for PyDeck Visualization
```python
# Step 1: Extract route details with geometry from optimization results
route_details = routes_df.select(
    col('VALUE')['vehicle'].astype(IntegerType()).alias('VEHICLE_INTEGER_ID'),
    col('VALUE')['geometry'].alias('GEOMETRY'),  # Array of [lon,lat] pairs
    col('VALUE')['duration'].alias('DURATION'),
    col('VALUE')['steps'].alias('STEPS')
)

# Step 2: Check if geometry exists and is populated
first_geometry = route_details.select(col('GEOMETRY')).limit(1).collect()[0][0]
if first_geometry is not None:
    # Step 3: Extract geometry and wrap with object_construct (CRITICAL for PyDeck)
    optimized_route_geometry = route_details.select('VEHICLE_ID', col('GEOMETRY').alias('GEO'))
    optimized_route_geometry = optimized_route_geometry.with_column('GEO', 
        object_construct(lit('coordinates'), col('GEO')))
    
    # Step 4: Add vehicle colors for visualization
    vehicle_colors_df = session.create_dataframe([
        {'VEHICLE_ID': vid, 'R': colors[0], 'G': colors[1], 'B': colors[2]} 
        for vid, colors in vehicle_colors.items()
    ])
    optimized_route_geometry = optimized_route_geometry.join(vehicle_colors_df, 'VEHICLE_ID')
    
    # Step 5: Convert to pandas
    data_for_map = optimized_route_geometry.select('GEO', 'VEHICLE_ID', 'R', 'G', 'B').to_pandas()
    
    # Step 6: CRITICAL - Extract coordinates using json.loads with lambda function
    data_for_map["coordinates"] = data_for_map["GEO"].apply(lambda row: json.loads(row)["coordinates"])
    
    # Step 7: Create final route coordinates DataFrame for PyDeck
    route_coordinates = data_for_map[['VEHICLE_ID', 'coordinates', 'R', 'G', 'B']].copy()
    
    # Step 8: Configure PyDeck PathLayer
    route_paths_layer = pdk.Layer(
        type="PathLayer",
        data=route_coordinates,
        pickable=True,
        get_color=["R", "G", "B"],
        width_min_pixels=4,
        width_max_pixels=7,
        get_path="coordinates",  # Uses the extracted coordinate arrays
        get_width=5
    )
```

**Key Requirements for PyDeck Visualization**:
- **MUST use object_construct**: `object_construct(lit('coordinates'), col('GEO'))` to create proper JSON structure
- **MUST use json.loads with lambda**: `data["GEO"].apply(lambda row: json.loads(row)["coordinates"])` to extract arrays
- **Import json module**: Add `import json` at the top of your file
- **Always verify geometry exists**: Check `first_geometry is not None` before processing
- **Road-based coordinates**: Geometry includes actual routing along roads, not straight lines

**✅ REQUIRED STEPS FOR PYDECK COMPATIBILITY**:
1. **Wrap geometry**: Use `object_construct(lit('coordinates'), col('GEO'))` 
2. **Convert to pandas**: Get GEO column as JSON strings
3. **Parse with lambda**: Apply `lambda row: json.loads(row)["coordinates"]` to extract coordinate arrays
4. **Create final DataFrame**: Select only `['VEHICLE_ID', 'coordinates', 'R', 'G', 'B']` for PyDeck

**❌ COMMON MISTAKES TO AVOID**:
- Don't try direct extraction without object_construct - PyDeck needs JSON structure
- Don't skip the json.loads step - coordinates must be properly parsed arrays
- Don't assume PyDeck can handle raw Snowflake arrays - they need JSON conversion
- Don't forget to import json module - lambda function will fail without it

**🔧 DEBUGGING TIP**: 
If you see "Route Geometry Error: 'coordinates'" check that:
- `data_for_map["coordinates"]` contains arrays like `[[-73.96447, 40.7731], [-73.96401, 40.77374], ...]`
- Not strings or None values
