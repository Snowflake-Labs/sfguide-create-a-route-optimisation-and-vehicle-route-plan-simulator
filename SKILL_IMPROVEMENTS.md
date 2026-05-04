# Skill Improvements for SUMMIT Branch

## Summary
Two critical improvements to routing solution skills based on deployment experience.

## Modified Files

### 1. `.cortex/skills/route-optimization/SKILL.md`

**Changes:** Inline SQL commands in Steps 1, 2, and 4 (previously only referenced external files)

**Location: Step 1 - Set Query Tag**
Replace:
```markdown
**Goal:** Set session query tag for attribution tracking.

> See `references/sql-setup.md` for the SQL command.
```

With:
```markdown
**Goal:** Set session query tag for attribution tracking.

Execute:
\```sql
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1, "minor":0},"attributes":{"is_quickstart":1, "source":"sql"}}';
\```
```

**Location: Step 2 - Verify ORS Services**
Replace:
```markdown
**Goal:** Confirm all 4 ORS services are active (OPENROUTESERVICE, ROUTING_REVERSE_PROXY, VROOM, DOWNLOADER).

> See `references/sql-setup.md` for SHOW SERVICES, RESUME_ALL_SERVICES, and CHECK_HEALTH SQL.

**STOP** if ORS Native App is not installed.
```

With:
```markdown
**Goal:** Confirm all 4 ORS services are active (OPENROUTESERVICE, ROUTING_REVERSE_PROXY, VROOM, DOWNLOADER).

Execute:
\```sql
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
\```

If any services are SUSPENDED, resume them:
\```sql
CALL OPENROUTESERVICE_APP.CORE.RESUME_ALL_SERVICES();
SELECT OPENROUTESERVICE_APP.CORE.CHECK_HEALTH();
\```

**STOP** if ORS Native App is not installed.
```

**Location: Step 4 - Get Carto Overture Dataset**
Replace:
```markdown
**Goal:** Acquire Overture Maps Places dataset for POI data.

> See `references/sql-setup.md` for the Marketplace SQL.

**Output:** `OVERTURE_MAPS__PLACES` database available.
```

With:
```markdown
**Goal:** Acquire Overture Maps Places dataset for POI data.

Execute:
\```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
\```

> Requires IMPORT SHARE privilege. If profile error occurs, update user profile with first/last name and email. Full details in `references/sql-setup.md` Step 4.

**Output:** `OVERTURE_MAPS__PLACES` database available.
```

---

### 2. `.cortex/skills/build-routing-solution/SKILL.md`

**Changes:** 
1. Made Step 7 explicitly REQUIRED (not optional)
2. Added Workspace-compatible alternative for file uploads

**Location: Step 7 heading (line ~291)**
Replace:
```markdown
### Step 7: Load Seed Datasets

**Goal:** Pre-load Intro page routes, synthetic SF ebike data, and a pre-computed travel time matrix so the app is fully populated on first launch
```

With:
```markdown
### Step 7: Load Seed Datasets

> **IMPORTANT:** This step is **required** for fleet intelligence demos. Without seed data, the Control App will have empty dashboards and Fleet Data Studio will be the only way to generate telemetry data.

**Goal:** Pre-load Intro page routes, synthetic SF ebike data, and a pre-computed travel time matrix so the app is fully populated on first launch
```

**Location: Step 7.2 - Upload Parquet files (line ~303)**
Replace:
```markdown
2. **Upload Parquet files to stage:**

   > **Note:** The `datasets/` directory is at the **repository root**, not in this skill's directory. Run these commands from the repo root.

   \```bash
   snow stage copy datasets/intro/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/intro/ -c <connection> --overwrite && \
   snow stage copy datasets/synthetic_ebikes/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/metadata/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/metadata/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/matrix/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/matrix/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/matrix_jobs/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/matrix_jobs/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/region_catalog/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/region_catalog/ -c <connection> --recursive --overwrite
   \```
```

With:
```markdown
2. **Upload Parquet files to stage:**

   > **Note:** The `datasets/` directory is at the **repository root**, not in this skill's directory.

   **If using Snow CLI (local environment):** Run from repo root:
   \```bash
   snow stage copy datasets/intro/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/intro/ -c <connection> --overwrite && \
   snow stage copy datasets/synthetic_ebikes/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/synthetic_ebikes/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/metadata/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/metadata/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/matrix/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/matrix/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/matrix_jobs/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/matrix_jobs/ -c <connection> --overwrite --recursive && \
   snow stage copy datasets/region_catalog/ @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE/region_catalog/ -c <connection> --recursive --overwrite
   \```

   **If using Snowflake Workspace:** Use COPY FILES with workspace URI:
   \```sql
   COPY FILES
   INTO @OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE
   FROM 'snow://workspace/USER$.PUBLIC."<workspace-name>"/versions/live/datasets/'
   PATTERN='.*\\.parquet';
   \```
   Replace `<workspace-name>` with your actual workspace fully qualified name.
```

---

## Rationale

### Route Optimization Changes
**Problem:** AI agent skipped reading reference files and tried to construct SQL from memory, resulting in incorrect syntax.

**Solution:** Inline critical execution commands directly in the workflow steps. Reference files still provide context/troubleshooting but agents can't skip the exact SQL needed.

### Build Routing Solution Changes
**Problem 1:** Step 7 appeared optional, causing agents to skip seed data loading.
**Solution:** Added explicit "REQUIRED" flag at the top of Step 7.

**Problem 2:** `snow stage copy` commands don't work in Snowflake Workspaces (web environment).
**Solution:** Added COPY FILES alternative that works in Workspaces using the `snow://workspace/` URI pattern.

---

## Testing
These changes were validated during a full routing solution deployment in a Snowflake Workspace on May 1, 2026.

- ✅ Inline SQL prevented syntax errors
- ✅ Workspace COPY FILES successfully uploaded 25 Parquet files
- ✅ Seed data loaded correctly (474K telemetry points, 7.7K trips, 150 vehicles, 10K POIs)
- ✅ All demos functional after deployment

## Impact
- **Breaking:** None (additive changes only)
- **Benefits:** Prevents common deployment failures, enables Workspace deployments
