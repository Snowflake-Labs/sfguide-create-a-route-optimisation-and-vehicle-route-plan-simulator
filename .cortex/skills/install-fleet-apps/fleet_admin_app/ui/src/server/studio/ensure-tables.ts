// Studio table DDL ensure helper. Idempotent CREATE TABLE IF NOT EXISTS for
// the FACT/DIM tables that startGeneration() writes into. Extracted from
// jobs.ts so the orchestrator stays focused on job lifecycle.

import { log } from '../diagnostics';
import { UNIFIED_DB, UNIFIED_SCHEMA } from './sql-helpers';

// Tracking tags (AGENTS.md). `source` is "app" because every one of these
// CREATEs is issued by the admin app's Node process at container boot - not by
// an installer .sql file. 19 of these literals said "sql", which is wrong for
// the object type in the sense that matters: a consumer asking "which objects
// did the app create" matched none of them. Two JOB_STATE literals in this same
// file already said "app", so the file contradicted itself. Hoisted to consts
// so the value cannot drift per-statement again.
const TRACK = `{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}`;
const TRACK_JOB_EVENTS = `{"origin":"sf_sit-is-fleet","name":"oss-studio-job-events","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}`;
const TRACK_JOB_STATE = `{"origin":"sf_sit-is-fleet","name":"oss-studio-job-state","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}`;

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

export async function ensureTables(snowSql: SnowSqlFn): Promise<void> {
  // `optional: true` means "best effort": a failure is logged and skipped
  // instead of aborting ensureTables. Used for the HYBRID TABLE create, which is
  // legitimately unavailable on Google Cloud, in trial accounts, and in US
  // SnowGov regions, and which always has a standard-table fallback immediately
  // after it.
  const ddls: { sql: string; db: string; schema: string; optional?: boolean }[] = [
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_VEHICLE_TELEMETRY (
      TELEMETRY_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      VEHICLE_ID VARCHAR, TRIP_ID VARCHAR,
      TS TIMESTAMP_NTZ, LATITUDE FLOAT, LONGITUDE FLOAT, POINT_GEOM GEOGRAPHY,
      SPEED_KMH FLOAT, HEADING_DEG FLOAT, POSTED_SPEED_KMH FLOAT,
      STATUS VARCHAR(30), IS_SPEEDING BOOLEAN, IS_HOS_VIOLATION BOOLEAN, IS_DETOUR BOOLEAN,
      GPS_ACCURACY_M FLOAT, LOCATION_ID VARCHAR, LOCATION_TYPE VARCHAR(30),
      ORS_PROFILE VARCHAR(30), BATTERY_PCT FLOAT, ODOMETER_KM FLOAT, POINT_INDEX INT,
      JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_TRIPS (
      TRIP_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR,
      VEHICLE_TYPE VARCHAR(20), REGION VARCHAR(100),
      ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR,
      ORIGIN_LAT FLOAT, ORIGIN_LON FLOAT, ORIGIN GEOGRAPHY,
      DESTINATION_LAT FLOAT, DESTINATION_LON FLOAT, DESTINATION GEOGRAPHY,
      ROUTE_GEOG GEOGRAPHY, DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT,
      PLANNED_ROUTE_GEOG GEOGRAPHY, PLANNED_DISTANCE_KM FLOAT,
      IS_DETOUR BOOLEAN, DETOUR_DISTANCE_KM FLOAT,
      TRIP_START TIMESTAMP_NTZ, TRIP_END TIMESTAMP_NTZ,
      STATUS VARCHAR(20), ORS_PROFILE VARCHAR(30),
      TRIP_KIND VARCHAR(16),
      JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Empty-miles support: tag each trip leg LADEN vs EMPTY (repositioning /
    // deadhead). Idempotent ALTER so existing FACT_TRIPS tables pick the column
    // up; legacy rows default to LADEN so the contract's COALESCE stays correct.
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_TRIPS ADD COLUMN IF NOT EXISTS TRIP_KIND VARCHAR(16) DEFAULT 'LADEN'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_FLEET (
      VEHICLE_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      ORS_PROFILE VARCHAR(30), SHIFT_TYPE VARCHAR(30),
      SHIFT_START_HOUR INT, SHIFT_END_HOUR INT,
      HOME_LOCATION_ID VARCHAR, DRIVER_PROFILE VARCHAR(20),
      OPERATING_MODE VARCHAR(30), BASE_SPEED_KMH FLOAT, BATTERY_RANGE_KM FLOAT,
      JOB_ID VARCHAR,
      WEIGHT_TONS NUMBER(6,2), HEIGHT_M NUMBER(4,2), LENGTH_M NUMBER(4,2),
      WIDTH_M NUMBER(4,2), AXLELOAD_T NUMBER(4,2), HAZMAT BOOLEAN, VEHICLE_SUBTYPE VARCHAR(16),
      -- Dispatch state. A "ghost" is a vehicle the generator deliberately parks
      -- at its home POI for a stretch of days (config.ghost_trailer), emitting
      -- only IDLE pings with TRIP_ID NULL. When the window covers the whole
      -- horizon the vehicle has NO trips and NO schedule rows at all, so it has
      -- no route to draw and its single unbroken IDLE span otherwise tops the
      -- dwell leaderboard ahead of genuinely busy vehicles. Persisting the
      -- window is what lets the dwell contract and the agent tell "parked all
      -- week" apart from "dwelled a lot at customer sites".
      IS_GHOST BOOLEAN, GHOST_START_DAY INT, GHOST_END_DAY INT
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_POIS (
      LOCATION_ID VARCHAR, REGION VARCHAR(100), NAME VARCHAR,
      LOCATION_TYPE VARCHAR(30), CATEGORY VARCHAR(50),
      LAT FLOAT, LNG FLOAT, POINT_GEOM GEOGRAPHY, SOURCE VARCHAR(20),
      JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_TRIP_SCHEDULE (
      SCHEDULE_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR,
      VEHICLE_TYPE VARCHAR(20), REGION VARCHAR(100),
      TRIP_DATE DATE, TRIP_SEQ INT,
      ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR,
      PLANNED_START TIMESTAMP_NTZ, PLANNED_END TIMESTAMP_NTZ,
      SHIFT_TYPE VARCHAR(30), ORS_PROFILE VARCHAR(30),
      DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, STATUS VARCHAR(20),
      JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Migration: rename legacy table for existing deploys.
    { sql: `ALTER TABLE IF EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_DELIVERIES RENAME TO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_OFFERS`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_OFFERS (
      OFFER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      SOURCE VARCHAR(30),
      PICKUP_POI_ID VARCHAR, PICKUP_LAT FLOAT, PICKUP_LON FLOAT, PICKUP_GEOM GEOGRAPHY,
      DROPOFF_POI_ID VARCHAR, DROPOFF_LAT FLOAT, DROPOFF_LON FLOAT, DROPOFF_GEOM GEOGRAPHY,
      PICKUP_FROM_TS TIMESTAMP_NTZ, PICKUP_TO_TS TIMESTAMP_NTZ,
      WEIGHT_KG NUMBER, PRODUCT VARCHAR, PRICE_USD NUMBER, HAZMAT BOOLEAN,
      LISTING_TEXT VARCHAR, POSTED_AT TIMESTAMP_NTZ,
      JOB_ID VARCHAR,
      VEHICLE_EQUIPMENT VARCHAR(30), DISTANCE_KM FLOAT, PRICE_PER_KM_USD FLOAT,
      PARTNER_ID VARCHAR, STATUS VARCHAR(20)
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Vehicle-agnostic offers - idempotent enrichment ALTERs so older
    // deployments pick the columns up on next boot.
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_OFFERS ADD COLUMN IF NOT EXISTS VEHICLE_EQUIPMENT VARCHAR(30)`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_OFFERS ADD COLUMN IF NOT EXISTS DISTANCE_KM FLOAT`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_OFFERS ADD COLUMN IF NOT EXISTS PRICE_PER_KM_USD FLOAT`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_OFFERS ADD COLUMN IF NOT EXISTS PARTNER_ID VARCHAR`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_OFFERS ADD COLUMN IF NOT EXISTS STATUS VARCHAR(20)`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Delivery marketplace - partner directory and lane history per preset.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_PARTNERS (
      PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      NAME VARCHAR, COUNTRY VARCHAR(4),
      CREDIT_SCORE NUMBER, PAYMENT_DAYS_AVG NUMBER, KYC_STATUS VARCHAR(20),
      BLACKLIST_FLAG BOOLEAN, FOUNDED_YEAR NUMBER,
      JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_PARTNER_HISTORY (
      PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      ORIGIN_COUNTRY VARCHAR(4), DEST_COUNTRY VARCHAR(4),
      VEHICLE_EQUIPMENT VARCHAR(30),
      SHIPPED_AT TIMESTAMP_NTZ, COST_PER_KM FLOAT,
      OUTCOME VARCHAR(20),
      JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Deliveries rename migration for EXISTING installs (guarded no-op on fresh
    // installs / when the old column is absent): rename the pre-rename
    // FACT_PARTNER_HISTORY columns so generation INSERTs (VEHICLE_EQUIPMENT /
    // COST_PER_KM) match. Runs before any generation insert.
    { sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_PARTNER_HISTORY RENAME COLUMN EQUIPMENT TO VEHICLE_EQUIPMENT;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_PARTNER_HISTORY RENAME COLUMN EUR_PER_KM TO COST_PER_KM;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // All region-keyed (no VEHICLE_TYPE - they describe the place/area,
    // not the fleet) and JOB_ID-versioned like DIM_POIS. V_*_CURRENT
    // projection views live in init.ts.
    // -----------------------------------------------------------------
    // Location anchors: PACE/health centres, key sites, depots, delivery
    // stops. Sourced from Overture Places (category-filtered) + Overture
    // Buildings centroids (depots). Retires the static DEMO_* + CareConnect CSV.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_ANCHORS (
      ANCHOR_ID VARCHAR, REGION VARCHAR(100), ANCHOR_TYPE VARCHAR(40),
      NAME VARCHAR, CATEGORY VARCHAR(60),
      LAT FLOAT, LNG FLOAT, GEOM GEOGRAPHY,
      ADDRESS VARCHAR, CITY VARCHAR, STATE VARCHAR, POSTCODE VARCHAR,
      SOURCE VARCHAR(40), JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Participant/passenger locations: a raw sample of real Overture addresses
    // within a straight-line radius (ST_DWITHIN) of the region's HEALTH_FACILITY
    // anchors. The emergency-response wizard's isochrone step filters this raw
    // sample at demo time. Dataset-versioned via JOB_ID.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_PARTICIPANTS (
      PARTICIPANT_ID VARCHAR, REGION VARCHAR(100),
      LAT FLOAT, LNG FLOAT, GEOM GEOGRAPHY,
      ADDRESS VARCHAR, CITY VARCHAR, STATE VARCHAR, POSTCODE VARCHAR,
      NEAREST_ANCHOR_ID VARCHAR, SOURCE VARCHAR(40), JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Hazard / disaster zones: FEMA NRI (+ optional Divisions boundary).
    // Generalises emergency-response's V_ZIP_RISK to any region.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_HAZARD_ZONES (
      ZONE_ID VARCHAR, REGION VARCHAR(100), STATE VARCHAR, COUNTY VARCHAR, FIPS VARCHAR(10),
      HAZARD_TYPE VARCHAR(40), RISK_SCORE FLOAT, RISK_RATING VARCHAR(40), RISK_LEVEL INT,
      GEOM GEOGRAPHY, SOURCE VARCHAR(40), JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Area demographics: SafeGraph Open Census (block-group) joined to region.
    // Retires the static DEMO_AREA_DEMOGRAPHICS.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_AREA_DEMOGRAPHICS (
      AREA_ID VARCHAR, REGION VARCHAR(100), AREA_TYPE VARCHAR(20),
      STATE_FIPS VARCHAR(4), COUNTY_FIPS VARCHAR(8),
      LAT FLOAT, LNG FLOAT, GEOM GEOGRAPHY,
      TOTAL_POPULATION NUMBER, MEDIAN_AGE FLOAT, MEDIAN_HOUSEHOLD_INCOME NUMBER,
      POP_ELDERLY NUMBER, POP_CHILDREN NUMBER, POPULATION_DENSITY FLOAT,
      SOURCE VARCHAR(40), JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Demand catalog: neutral category-derived handling tiers (no domain
    // labels). Retires the static DEMO_DEMAND_CATALOG.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_DEMAND_CATALOG (
      ITEM_ID VARCHAR, REGION VARCHAR(100), CATEGORY VARCHAR(60),
      DEMAND_TIER INT, TIER_LABEL VARCHAR(40), HANDLING VARCHAR(60),
      JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // -----------------------------------------------------------------
    // Route-optimization PLACES + LOOKUP. Generated as first-class,
    // JOB_ID-versioned Studio output (engine/places.ts) so a fresh install is
    // seed-complete without the external SEED_ROUTE_OPTIMIZATION_REGION proc
    // (which may be absent). The CREATE IF NOT EXISTS covers a clean account;
    // the ALTER ADD COLUMN backfills JOB_ID on tables that pre-exist from the
    // legacy Overture import / marketplace path.
    // -----------------------------------------------------------------
    { sql: `CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION
      COMMENT = '${TRACK}'`, db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION' },
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES (
      REGION VARCHAR, GEOMETRY GEOGRAPHY, PHONES VARCHAR, CATEGORY VARCHAR,
      NAME VARCHAR, ADDRESS VARIANT, ALTERNATE VARIANT, JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION' },
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP (
      REGION VARCHAR, INDUSTRY VARCHAR, PA VARCHAR, PB VARCHAR, PC VARCHAR,
      IND ARRAY, IND2 ARRAY, CTYPE ARRAY, STYPE ARRAY,
      SOURCE_TABLE VARCHAR, DEPOT_CTYPE ARRAY, DEPOT_LABEL VARCHAR, JOB_ID VARCHAR
    ) COMMENT = '${TRACK}'`, db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION' },
    { sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR`, db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION' },
    { sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR`, db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION' },
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.GENERATION_JOBS (
      JOB_ID VARCHAR, PRESET_ID VARCHAR, PRESET_NAME VARCHAR, REGION VARCHAR(100),
      ORS_PROFILE VARCHAR(30), NUM_VEHICLES INT,
      START_DATE VARCHAR, END_DATE VARCHAR,
      STATUS VARCHAR(20), CONFIG VARIANT,
      POINTS_GENERATED INT DEFAULT 0, TRIPS_GENERATED INT DEFAULT 0,
      ERROR_MESSAGE VARCHAR, STARTED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
      COMPLETED_AT TIMESTAMP_NTZ, LOG_TEXT VARIANT
    ) COMMENT = '${TRACK}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    { sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS ADD COLUMN IF NOT EXISTS PRESET_ID VARCHAR;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    { sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS ADD COLUMN IF NOT EXISTS HEARTBEAT_AT TIMESTAMP_NTZ;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    { sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS ADD COLUMN IF NOT EXISTS LOG_TEXT VARIANT;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.JOB_EVENTS (
      JOB_ID VARCHAR,
      SEQ NUMBER AUTOINCREMENT START 1 INCREMENT 1,
      EVENT_TS TIMESTAMP_NTZ DEFAULT SYSDATE(),
      EVENT_TYPE VARCHAR(30),
      PAYLOAD VARIANT
    ) COMMENT = '${TRACK_JOB_EVENTS}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    // Durable Studio job state (Tenet 5b). The authoritative live state used to
    // be the in-memory `activeJobs` Map in jobs.ts, which a container restart
    // loses - hence the 'orphan' cancel mode and the boot-time stale-job
    // reconcile. This table is the write-through durable copy: frequent
    // single-row UPDATE by JOB_ID, which is the one workload shape that earns a
    // HYBRID TABLE here (an enforced PK plus row-store writes), unlike the
    // 1-43 row config tables that stay standard.
    //
    // Two statements on purpose. Hybrid tables are unavailable on Google Cloud,
    // in trial accounts, and in US SnowGov regions, so the HYBRID create is
    // allowed to fail and the following standard CREATE IF NOT EXISTS becomes
    // the fallback (it no-ops when the hybrid one succeeded). Same shape either
    // way; only PK enforcement is lost. Do NOT collapse these into one.
    { sql: `CREATE HYBRID TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.JOB_STATE (
      JOB_ID           VARCHAR(64) NOT NULL PRIMARY KEY,
      REGION           VARCHAR(100),
      VEHICLE_TYPE     VARCHAR(20),
      PRESET_NAME      VARCHAR,
      ORS_PROFILE      VARCHAR(30),
      STATUS           VARCHAR(20) NOT NULL,
      POINTS_GENERATED NUMBER DEFAULT 0,
      TRIPS_GENERATED  NUMBER DEFAULT 0,
      ABORT_REQUESTED  BOOLEAN DEFAULT FALSE,
      STALLED          BOOLEAN DEFAULT FALSE,
      ERROR_MESSAGE    VARCHAR,
      STARTED_AT       TIMESTAMP_NTZ,
      LAST_PROGRESS_AT TIMESTAMP_NTZ,
      COMPLETED_AT     TIMESTAMP_NTZ
    ) COMMENT = '${TRACK_JOB_STATE}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE', optional: true },
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.JOB_STATE (
      JOB_ID           VARCHAR(64) NOT NULL PRIMARY KEY,
      REGION           VARCHAR(100),
      VEHICLE_TYPE     VARCHAR(20),
      PRESET_NAME      VARCHAR,
      ORS_PROFILE      VARCHAR(30),
      STATUS           VARCHAR(20) NOT NULL,
      POINTS_GENERATED NUMBER DEFAULT 0,
      TRIPS_GENERATED  NUMBER DEFAULT 0,
      ABORT_REQUESTED  BOOLEAN DEFAULT FALSE,
      STALLED          BOOLEAN DEFAULT FALSE,
      ERROR_MESSAGE    VARCHAR,
      STARTED_AT       TIMESTAMP_NTZ,
      LAST_PROGRESS_AT TIMESTAMP_NTZ,
      COMPLETED_AT     TIMESTAMP_NTZ
    ) COMMENT = '${TRACK_JOB_STATE}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    { sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE FLEET_INTELLIGENCE.CORE.JOB_EVENTS ADD COLUMN IF NOT EXISTS EVENT_TS TIMESTAMP_NTZ DEFAULT SYSDATE();
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    // Dataset versioning registry. Each Studio run = one immutable dataset
    // keyed by JOB_ID. At most one IS_ACTIVE = TRUE per (REGION, VEHICLE_TYPE).
    // Downstream consumers read via V_*_CURRENT views (see init.ts) which
    // join to this table and filter on IS_ACTIVE = TRUE.
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.DIM_DATASETS (
      DATASET_ID    VARCHAR,
      REGION        VARCHAR(100),
      VEHICLE_TYPE  VARCHAR(20),
      LABEL         VARCHAR,
      IS_ACTIVE     BOOLEAN DEFAULT TRUE,
      CREATED_AT    TIMESTAMP_NTZ DEFAULT SYSDATE(),
      ROW_COUNTS    VARIANT,
      NOTES         VARCHAR
    ) COMMENT = '${TRACK}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    // Idempotent backfill from existing data. Latest JOB_ID per
    // (REGION, VEHICLE_TYPE) -> IS_ACTIVE = TRUE; older JOB_IDs (if any
    // survived prior cleanRegionScope deletions) -> IS_ACTIVE = FALSE.
    // Skipped row-by-row via NOT EXISTS so re-runs are safe.
    { sql: `INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_DATASETS
      (DATASET_ID, REGION, VEHICLE_TYPE, LABEL, IS_ACTIVE, CREATED_AT)
      WITH all_jobs AS (
        SELECT REGION, VEHICLE_TYPE, JOB_ID, MAX(POSTED_AT) AS LAST_TS
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS
        WHERE JOB_ID IS NOT NULL AND REGION IS NOT NULL AND VEHICLE_TYPE IS NOT NULL
        GROUP BY REGION, VEHICLE_TYPE, JOB_ID
        UNION ALL
        SELECT REGION, VEHICLE_TYPE, JOB_ID, NULL
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
        WHERE JOB_ID IS NOT NULL AND REGION IS NOT NULL AND VEHICLE_TYPE IS NOT NULL
        GROUP BY REGION, VEHICLE_TYPE, JOB_ID
        UNION ALL
        SELECT REGION, VEHICLE_TYPE, JOB_ID, MAX(TRIP_START)
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
        WHERE JOB_ID IS NOT NULL AND REGION IS NOT NULL AND VEHICLE_TYPE IS NOT NULL
        GROUP BY REGION, VEHICLE_TYPE, JOB_ID
      ),
      collapsed AS (
        SELECT REGION, VEHICLE_TYPE, JOB_ID, MAX(LAST_TS) AS LAST_TS
        FROM all_jobs
        GROUP BY REGION, VEHICLE_TYPE, JOB_ID
      ),
      ranked AS (
        SELECT REGION, VEHICLE_TYPE, JOB_ID, LAST_TS,
               ROW_NUMBER() OVER (PARTITION BY REGION, VEHICLE_TYPE
                                  ORDER BY LAST_TS DESC NULLS LAST, JOB_ID DESC) AS RN
        FROM collapsed
      )
      SELECT
        r.JOB_ID,
        r.REGION,
        r.VEHICLE_TYPE,
        'backfilled @ ' || TO_VARCHAR(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI'),
        (r.RN = 1),
        COALESCE(r.LAST_TS, CURRENT_TIMESTAMP)
      FROM ranked r
      WHERE NOT EXISTS (
        SELECT 1 FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
        WHERE d.DATASET_ID = r.JOB_ID
      )`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
  ];
  for (const { sql, db, schema, optional } of ddls) {
    try {
      await snowSql(sql, db, schema);
    } catch (e: any) {
      const raw = e.message || '';
      // Best-effort DDL: never abort the boot path, and never escalate to the
      // privilege hint below (a missing CREATE HYBRID TABLE grant, or a region
      // where hybrid tables do not exist at all, must both fall through to the
      // standard-table fallback rather than failing the whole app).
      if (optional) {
        log('WARN', 'Studio', `Optional DDL skipped on ${db}.${schema}: ${raw.slice(0, 200)}`);
        continue;
      }
      if (raw.includes('Insufficient privileges') || raw.includes('42501') || raw.includes('access control')) {
        const hint = `Missing privileges on ${db}.${schema}. ` +
          `Run the Data Studio setup SQL from SKILL.md Step 6.3 as ACCOUNTADMIN, ` +
          `or re-run deploy.sh which grants all required privileges automatically.`;
        log('ERROR', 'Studio', hint);
        throw new Error(hint);
      }
      // Snowflake's ALTER TABLE ... ADD COLUMN IF NOT EXISTS can raise a
      // spurious compile-time "ambiguous column name" / "already exists" error
      // when the column is already present. Treat as a no-op so legacy backfill
      // ALTERs cannot abort startGeneration.
      if (/ambiguous column name/i.test(raw) || /already exists/i.test(raw)) {
        log('INFO', 'Studio', `DDL no-op on ${db}.${schema}: ${raw.slice(0, 160)}`);
        continue;
      }
      const msg = `DDL error (${db}.${schema}): ${raw.slice(0, 200)}`;
      console.error(`[Studio] ${msg}`);
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
}
