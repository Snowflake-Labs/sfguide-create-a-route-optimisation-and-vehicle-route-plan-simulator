---
name: "matrix-builder-redesign"
created: "2026-03-20T15:02:37.489Z"
status: pending
---

# Plan: Matrix Builder Redesign — Background Compute, Inventory & Expanded Resolutions

## Problem Statement

The current matrix builder has several limitations:

1. Only supports resolutions 7-9 (need 5-10)
2. Build progress is stored in-memory — lost on page refresh or SPCS restart
3. No inventory view of completed matrices
4. No individual deletion of computed matrices
5. No routing profile selection (hardcoded `driving-car`)

## Architecture Decision: Snowflake Tasks + Tracking Table

**Why Tasks?** Tasks run independently of the SPCS control app. Even if the container restarts, the Task continues executing. Combined with a `MATRIX_BUILD_JOBS` tracking table, we get:

- **Persistence**: Job state survives SPCS restarts and page refreshes
- **Observability**: Status readable from table at any time
- **Independence**: No dependency on the control app being alive during computation
- **Cleanup**: Tasks are dropped after completion (one-shot execution via EXECUTE TASK on suspended tasks)

**Alternative considered**: SQL API async polling — rejected because statement handles are lost if SPCS restarts.

---

## 1. SQL Changes (setup\_script.sql)

### 1a. MATRIX\_BUILD\_JOBS Tracking Table

```
CREATE TABLE IF NOT EXISTS travel_matrix.MATRIX_BUILD_JOBS (
  JOB_ID VARCHAR DEFAULT UUID_STRING(),
  REGION VARCHAR,
  PROFILE VARCHAR,
  RESOLUTION VARCHAR,        -- 'RES5' through 'RES10'
  STATUS VARCHAR,            -- PENDING, RUNNING, COMPLETE, ERROR, CANCELLED
  STAGE VARCHAR DEFAULT 'NOT_STARTED',  -- NOT_STARTED, HEXAGONS, WORK_QUEUE, BUILDING, FLATTENING, COMPLETE
  HEXAGONS NUMBER DEFAULT 0,
  WORK_QUEUE_ROWS NUMBER DEFAULT 0,
  RAW_ROWS NUMBER DEFAULT 0,
  MATRIX_ROWS NUMBER DEFAULT 0,
  PCT_COMPLETE FLOAT DEFAULT 0,
  ERROR_MSG VARCHAR,
  TASK_NAME VARCHAR,
  CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  STARTED_AT TIMESTAMP_NTZ,
  COMPLETED_AT TIMESTAMP_NTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE travel_matrix.MATRIX_BUILD_JOBS TO APPLICATION ROLE app_user;
```

### 1b. New Procedures

**LAUNCH\_MATRIX\_BUILD(P\_REGION, P\_PROFILE, P\_RESOLUTIONS\_CSV)**

- Parses CSV of resolutions (e.g., 'RES5,RES7,RES9')

- For each resolution:

  1. Inserts a PENDING row into MATRIX\_BUILD\_JOBS
  2. Calls ENSURE\_MATRIX\_TABLES to create target tables
  3. Creates a suspended task: `CREATE TASK IF NOT EXISTS travel_matrix.MATRIX_TASK_{region}_{profile}_{res}`
  4. Task body calls `BUILD_MATRIX_TASK_WRAPPER` with job\_id, region, profile, resolution
  5. `EXECUTE TASK` to trigger async execution

- Returns JSON array of job\_ids

**BUILD\_MATRIX\_TASK\_WRAPPER(P\_JOB\_ID, P\_REGION, P\_PROFILE, P\_RES, P\_MATRIX\_FN)**

- Wraps BUILD\_MATRIX\_FOR\_REGION with progress updates to MATRIX\_BUILD\_JOBS

- Updates STAGE and counts at each step:

  - After HEXAGONS: stage='HEXAGONS', hexagons=count
  - After WORK\_QUEUE: stage='WORK\_QUEUE', work\_queue\_rows=count
  - During BUILDING: stage='BUILDING', raw\_rows updated periodically
  - After FLATTEN: stage='COMPLETE', matrix\_rows=count

- On error: STATUS='ERROR', ERROR\_MSG=message

- On success: STATUS='COMPLETE', COMPLETED\_AT=now

- Drops the task after completion

**GET\_BUILD\_STATUS()**

- Returns JSON of all jobs from MATRIX\_BUILD\_JOBS
- For RUNNING jobs, also queries actual table counts for live progress
- Includes supplementary TASK\_HISTORY check for edge cases

**GET\_MATRIX\_INVENTORY()**

- Scans INFORMATION\_SCHEMA.TABLES in TRAVEL\_MATRIX schema
- Groups by region/profile/resolution (parses table names)
- Returns JSON: \[{region, profile, resolution, matrix\_rows, list\_rows, created\_at}]

**DELETE\_MATRIX\_CONFIG(P\_REGION, P\_PROFILE, P\_RES)**

- Drops all 4 tables for the given region/profile/resolution
- Deletes corresponding rows from MATRIX\_BUILD\_JOBS
- Returns confirmation

### 1c. Expand Resolution Support (5-10)

**BUILD\_HEXAGONS** — new step sizes:

| Resolution | Hex Edge (m) | Step Size | Hex/sq-deg (est) |
| ---------- | ------------ | --------- | ---------------- |
| 5          | 8,544        | 0.15      | \~45             |
| 6          | 3,229        | 0.06      | \~300            |
| 7          | 1,221        | 0.02      | \~2,000          |
| 8          | 461          | 0.008     | \~13,500         |
| 9          | 174          | 0.003     | \~90,000         |
| 10         | 66           | 0.001     | \~630,000        |

**BUILD\_WORK\_QUEUE** — new k-ring values:

| Res | Cutoff (mi) | k-ring |
| --- | ----------- | ------ |
| 5   | 200         | 16     |
| 6   | 100         | 22     |
| 7   | 50          | 33     |
| 8   | 10          | 17     |
| 9   | 2           | 9      |
| 10  | 0.5         | 5      |

**MATRIX\_PROGRESS** — update to check resolutions 5-10 (or better: query MATRIX\_BUILD\_JOBS table instead of hardcoded resolution loop).

---

## 2. Server Changes (server/index.ts)

### Remove in-memory state

- Delete `matrixBuildStates` object entirely

### New/Modified Endpoints

**`POST /api/matrix/build`** (modified)

- Accepts: `{ region, profile, resolutions: [5,7,9] }`
- Calls `LAUNCH_MATRIX_BUILD(region, profile, 'RES5,RES7,RES9')`
- Returns: `{ status: 'launched', jobs: [...] }`
- No longer runs async build in-process

**`GET /api/matrix/status`** (modified)

- Calls `GET_BUILD_STATUS()` — reads from tracking table
- Returns all active/recent jobs with progress

**`GET /api/matrix/inventory`** (new)

- Calls `GET_MATRIX_INVENTORY()`
- Returns all completed matrix configs with row counts

**`DELETE /api/matrix/:region/:profile/:resolution`** (new)

- Calls `DELETE_MATRIX_CONFIG(region, profile, resolution)`
- Returns confirmation

**`GET /api/matrix/existing`** (modified)

- Expand resolution scan from \[7,8,9] to \[5,6,7,8,9,10]

---

## 3. UI Changes (MatrixBuilder.tsx)

### New Layout Structure

```
┌──────────────────────────────────────────────────┐
│ Travel Time Matrix Builder                       │
├──────────────────────────────────────────────────┤
│ ◆ Matrix Inventory (existing configs)            │
│ ┌────────┬──────────┬─────┬────────┬──────────┐ │
│ │ Region │ Profile  │ Res │ Pairs  │ Actions  │ │
│ ├────────┼──────────┼─────┼────────┼──────────┤ │
│ │ SF     │ driving  │ 7   │ 42.3K  │ [Delete] │ │
│ │ SF     │ driving  │ 8   │ 312K   │ [Delete] │ │
│ └────────┴──────────┴─────┴────────┴──────────┘ │
├──────────────────────────────────────────────────┤
│ ◆ Active Builds (in-progress tasks)             │
│ ┌────────────────────────────────────────────┐   │
│ │ SF / driving-car / RES9  ▓▓▓▓▓░░░ 62%     │   │
│ │ Stage: BUILDING · 28K/45K origins          │   │
│ └────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────┤
│ ◆ New Build                                      │
│ 1. Select Region    [San Francisco ▼]            │
│ 2. Select Profile   [driving-car ▼]              │
│ 3. Select Resolutions                            │
│    □ Res 5 — Regional (8.5km)  ~45 hex  200mi   │
│    □ Res 6 — District (3.2km)  ~300 hex 100mi   │
│    ☑ Res 7 — Long Range (1.2km) ~2K hex 50mi    │
│    ☑ Res 8 — Delivery (460m)  ~13K hex  10mi    │
│    ☑ Res 9 — Last Mile (174m) ~90K hex  2mi     │
│    □ Res 10 — Hyperlocal (66m) ~630K hex 0.5mi  │
│ 4. Resource Estimate                             │
│    Total Pairs: ~2.1M  Time: ~1h 8m  Credits: 2 │
│ 5. Cost Comparison (table)                       │
│                        [Build Matrix]            │
└──────────────────────────────────────────────────┘
```

### Key UI Changes

- **Inventory table** at top — shows all completed matrices, delete button per row
- **Active builds** section — polls `/api/matrix/status` every 5s, shows progress bars
- **Profile dropdown** — `driving-car`, `driving-hgv`, `cycling-electric`, etc.
- **Resolution picker** — expanded to 5-10 with appropriate labels and estimates
- **Polling resilient** — status comes from DB, survives refresh

### Resolution Metadata (for UI)

```
const RES_LABELS: Record<number, string> = {
  10: 'Hyperlocal (66m)',
  9: 'Last Mile (174m)',
  8: 'Delivery Zone (460m)',
  7: 'Long Range (1.2km)',
  6: 'District (3.2km)',
  5: 'Regional (8.5km)',
};

const RES_CUTOFFS: Record<number, number> = {
  10: 0.5, 9: 2, 8: 10, 7: 50, 6: 100, 5: 200
};
```

---

## 4. Additional Ideas

1. **Auto-cleanup of old tasks**: The BUILD\_MATRIX\_TASK\_WRAPPER drops the task on completion. For error cases, add a cleanup procedure that drops orphaned tasks.

2. **Cancel button**: Add a `CANCEL_MATRIX_BUILD` procedure that:

   - Drops the running task (which stops the build)
   - Updates MATRIX\_BUILD\_JOBS status to CANCELLED

3. **Warehouse selector**: Let user pick warehouse size for builds (XS for small regions, M/L for large). The task's WAREHOUSE parameter controls this.

4. **Resume support**: BUILD\_TRAVEL\_TIME\_RANGE already has resume capability (checks max SEQ\_ID). If a build fails mid-way, a "Resume" button could re-launch from where it left off.

5. **Multi-region batch**: Allow selecting multiple regions to build in parallel (each gets its own task).

6. **Notifications**: Use Snowflake's task error notification feature to alert on failures.

---

## 5. Deployment

1. Update `setup_script.sql` with all new procedures
2. Update `server/index.ts` with new endpoints
3. Update `MatrixBuilder.tsx` with new UI
4. Update `types.ts` with new interfaces
5. Bump Docker image to `v1.0.7`
6. Build and push: `docker build --platform linux/amd64 -t ...ors_control_app:v1.0.7`
7. Update YAML: `ors_control_app_service.yaml` image tag → v1.0.7
8. Deploy: `snow app run --connection fleet_test_evals`
9. Test: Start a build, refresh the page, verify progress persists
