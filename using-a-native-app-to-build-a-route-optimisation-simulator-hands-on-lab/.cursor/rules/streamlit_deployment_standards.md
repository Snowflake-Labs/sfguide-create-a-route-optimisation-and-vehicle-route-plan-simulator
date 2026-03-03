## Streamlit Deployment Standards

This rule ensures all Streamlit applications follow the deployment template pattern from `dataops/event/deploy_streamlit.template.sql` and use variable substitution from `dataops/event/variables.yml`.

**CRITICAL**: Always use the modern `FROM @stage` syntax. Never use the legacy `ROOT_LOCATION` approach.

### Variable Mapping (from variables.yml)
```yaml
{{ env.EVENT_DATABASE }} → VEHICLE_ROUTING_SIMULATOR
{{ env.STREAMLIT_SCHEMA }} → STREAMLIT  
{{ env.EVENT_WAREHOUSE }} → DEFAULT_WH
{{ env.EVENT_ATTENDEE_ROLE }} → ATTENDEE_ROLE
{{ env.CI_PROJECT_DIR }} → Current project directory path
```

### Mandatory Template Structure
```sql
ALTER SESSION SET QUERY_TAG = '''{"origin":"sf_sit-is", "name":"[APP_NAME]", "version":{"major":1, "minor":0},"attributes":{"is_quickstart":0, "source":"sql"}}''';

USE ROLE {{ env.EVENT_ATTENDEE_ROLE }};
CREATE SCHEMA IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }};

CREATE STAGE IF NOT EXISTS {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_[N];

PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/[MAIN_FILE].py @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_[N] auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/environment.yml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_[N] auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/homepage/docs/stylesheets/extra.css @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_[N] auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/streamlit/config.toml @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_[N]/.streamlit/ auto_compress = false overwrite = true;
PUT file:///{{ env.CI_PROJECT_DIR}}/dataops/event/streamlit/logo.svg @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_[N] auto_compress = false overwrite = true;

CREATE OR REPLACE STREAMLIT {{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.[APP_NAME]
    FROM @{{ env.EVENT_DATABASE }}.{{ env.STREAMLIT_SCHEMA }}.STREAMLIT_[N]
    MAIN_FILE = '[MAIN_FILE].py'
    QUERY_WAREHOUSE = '{{ env.EVENT_WAREHOUSE }}'
    COMMENT = '{"origin":"sf_sit-is", "name":"[DESCRIPTIVE_NAME]", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":0, "source":"streamlit"}}';
```

### Critical Requirements
- Stage naming: STREAMLIT_1, STREAMLIT_2, ...; never reuse numbers
- Required assets: main py, environment.yml, extra.css, config.toml (in .streamlit/), logo.svg
- Naming: app names UPPERCASE_WITH_UNDERSCORES; file names lowercase_with_underscores.py
- JSON comment metadata must follow standard structure
- **MANDATORY**: Use `FROM @stage` syntax, never `ROOT_LOCATION`

### Variable Substitution Rules
Do not hardcode database/schema/role/warehouse; always use `{{ env.* }}` variables.

### File Path Standards
- Python apps: `dataops/event/streamlit/[filename].py`
- Env: `dataops/event/streamlit/environment.yml`
- CSS: `dataops/event/homepage/docs/stylesheets/extra.css`
- Config: `dataops/event/streamlit/streamlit/config.toml`
- Logo: `dataops/event/streamlit/logo.svg`

### Quality Checklist
- [ ] Next available STREAMLIT_N used
- [ ] All 5 required assets uploaded
- [ ] All variables use `{{ env.* }}`
- [ ] JSON comment standard
- [ ] Paths match project structure
- [ ] App name/naming conventions correct
- [ ] **MANDATORY**: Uses `FROM @stage` syntax (not `ROOT_LOCATION`)

### Legacy Syntax to Avoid
❌ **NEVER USE**:
```sql
-- Legacy approach - DO NOT USE
CREATE STREAMLIT app_name ROOT_LOCATION = '@stage';
ALTER STREAMLIT app_name SET ROOT_LOCATION = '@stage';
```

✅ **ALWAYS USE**:
```sql
-- Modern approach - REQUIRED
CREATE OR REPLACE STREAMLIT app_name FROM @stage MAIN_FILE = 'file.py' QUERY_WAREHOUSE = 'warehouse';
```


