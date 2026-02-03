## Snowflake Notebook Standards

This rule defines how to author and deploy notebooks that run and can be edited directly in Snowflake, based on working examples in this repo and `deploy_notebooks.template.sql`.

### Core Principles
- Author notebooks with cells that execute in Snowflake (use SQL and Python cells supported by Snowflake Notebooks).
- Avoid local-only dependencies; rely on a Snowflake-managed environment via `environment.yml`.
- Ensure all database/schema/warehouse references use template variables from `dataops/event/variables.yml` at deployment time.
- Keep notebooks idempotent: use `CREATE OR REPLACE` / `IF NOT EXISTS` and safe guards.

### Deployment Template (required structure)
Deployment must follow `dataops/event/deploy_notebooks.template.sql`:
```sql
ALTER SESSION SET QUERY_TAG = '...';
USE ROLE {{ env.EVENT_ATTENDEE_ROLE }};
CREATE SCHEMA IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }};
CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_1;
CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_2;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/routing_setup.ipynb @{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_1 auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_1 auto_compress = false overwrite = true;

CREATE OR REPLACE NOTEBOOK {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.ROUTING_WITH_OPEN_ROUTES_WITH_AISQL
  FROM '@{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_1'
  MAIN_FILE = 'routing_setup.ipynb'
  QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
  COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Management with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"notebook"}}';
ALTER NOTEBOOK {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.ROUTING_WITH_OPEN_ROUTES_WITH_AISQL ADD LIVE VERSION FROM LAST;

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/notebooks/Fleet_Management_Setup.ipynb @{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_2 auto_compress = false overwrite = true;

CREATE OR REPLACE NOTEBOOK {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.FLEET_INTELLIGENCE_SETUP
  FROM '@{{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.NOTEBOOK_2'
  MAIN_FILE = 'Fleet_Management_Setup.ipynb'
  QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
  COMMENT = '{"origin":"sf_sit-is", "name":"Fleet Management with Open Route Service", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"notebook"}}';
ALTER NOTEBOOK {{ env.EVENT_DATABASE }}.{{ env.NOTEBOOKS_SCHEMA }}.FLEET_INTELLIGENCE_SETUP ADD LIVE VERSION FROM LAST;
```

### Notebook Authoring Guidelines
- Prefer SQL cells for DDL/DML that run in Snowflake; keep Python cells Snowflake-compatible.
- Use idempotent DDL (CREATE IF NOT EXISTS / CREATE OR REPLACE).
- Use geospatial functions consistently (e.g., `ST_MAKEPOINT`, `ST_DISTANCE`, `ST_DWITHIN`).
- Ensure variable references like `{{ env.EVENT_DATABASE }}` are used in deployment scripts, not hardcoded inside notebooks.
- When using Streamlit in notebooks, keep imports minimal and compatible with the provided environment.

### Environment Requirements (`dataops/event/notebooks/environment.yml`)
Minimum dependencies for editing and running notebooks in Snowflake:
```yaml
name: app_environment
channels:
  - snowflake
dependencies:
  - python=3.11.*
  - snowflake-snowpark-python=
  - streamlit=
  - pydeck=*
```
- Pin Python to a Snowflake-supported version (3.11.* is current in this repo).
- List only necessary packages; Snowflake supplies many built-ins.

### What “Good” Looks Like (from working notebooks)
- `routing_setup.ipynb`:
  - Uses SQL to generate sample data via `AI_COMPLETE`
  - Calls routing functions with clear database selector (`{{database}}` placeholder in text; resolved via context when deployed)
  - Demonstrates PyDeck rendering with Streamlit in a Python cell
  - Materializes results into tables for reuse (`CREATE TABLE IF NOT EXISTS ...`)
- `Fleet_Management_Setup.ipynb`:
  - Resumes required Snowflake services
  - Creates databases/schemas/tables idempotently
  - Uses analytic window functions and geospatial operations
  - Scales warehouse only when needed, then proceeds with transformations

### Editing in Snowflake (Live Version)
- After creation, run `ALTER NOTEBOOK ... ADD LIVE VERSION FROM LAST` so edits are enabled in the Snowflake UI.
- Make iterative edits in the Snowflake Notebook UI; redeploy only when structure changes (e.g., adding new notebook files).

### Quality Checklist
- [ ] Deployment uses the provided template (PUT, CREATE NOTEBOOK, ALTER NOTEBOOK ADD LIVE VERSION)
- [ ] All context values use `{{ env.* }}` in SQL templates
- [ ] Idempotent DDL used throughout
- [ ] Notebook Python cells import only environment.yml packages
- [ ] Queries run under `{{ env.EVENT_WAREHOUSE }}` and correct role
- [ ] Geospatial and analytics functions used correctly


