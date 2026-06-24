// Studio table DDL ensure helper. Idempotent CREATE TABLE IF NOT EXISTS for
// the FACT/DIM tables that startGeneration() writes into. Extracted from
// jobs.ts so the orchestrator stays focused on job lifecycle.

import { log } from '../diagnostics';
import { UNIFIED_DB, UNIFIED_SCHEMA } from './sql-helpers';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

export async function ensureTables(snowSql: SnowSqlFn): Promise<void> {
  const ddls: { sql: string; db: string; schema: string }[] = [
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_VEHICLE_TELEMETRY (
      TELEMETRY_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      VEHICLE_ID VARCHAR, TRIP_ID VARCHAR,
      TS TIMESTAMP_NTZ, LATITUDE FLOAT, LONGITUDE FLOAT, POINT_GEOM GEOGRAPHY,
      SPEED_KMH FLOAT, HEADING_DEG FLOAT, POSTED_SPEED_KMH FLOAT,
      STATUS VARCHAR(30), IS_SPEEDING BOOLEAN, IS_HOS_VIOLATION BOOLEAN, IS_DETOUR BOOLEAN,
      GPS_ACCURACY_M FLOAT, LOCATION_ID VARCHAR, LOCATION_TYPE VARCHAR(30),
      ORS_PROFILE VARCHAR(30), BATTERY_PCT FLOAT, ODOMETER_KM FLOAT, POINT_INDEX INT,
      JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
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
      JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_FLEET (
      VEHICLE_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      ORS_PROFILE VARCHAR(30), SHIFT_TYPE VARCHAR(30),
      SHIFT_START_HOUR INT, SHIFT_END_HOUR INT,
      HOME_LOCATION_ID VARCHAR, DRIVER_PROFILE VARCHAR(20),
      OPERATING_MODE VARCHAR(30), BASE_SPEED_KMH FLOAT, BATTERY_RANGE_KM FLOAT,
      JOB_ID VARCHAR,
      WEIGHT_TONS NUMBER(6,2), HEIGHT_M NUMBER(4,2), LENGTH_M NUMBER(4,2),
      WIDTH_M NUMBER(4,2), AXLELOAD_T NUMBER(4,2), HAZMAT BOOLEAN, VEHICLE_SUBTYPE VARCHAR(16)
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_POIS (
      LOCATION_ID VARCHAR, REGION VARCHAR(100), NAME VARCHAR,
      LOCATION_TYPE VARCHAR(30), CATEGORY VARCHAR(50),
      LAT FLOAT, LNG FLOAT, POINT_GEOM GEOGRAPHY, SOURCE VARCHAR(20),
      JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_TRIP_SCHEDULE (
      SCHEDULE_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR,
      VEHICLE_TYPE VARCHAR(20), REGION VARCHAR(100),
      TRIP_DATE DATE, TRIP_SEQ INT,
      ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR,
      PLANNED_START TIMESTAMP_NTZ, PLANNED_END TIMESTAMP_NTZ,
      SHIFT_TYPE VARCHAR(30), ORS_PROFILE VARCHAR(30),
      DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, STATUS VARCHAR(20),
      JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS (
      OFFER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      SOURCE VARCHAR(30),
      PICKUP_POI_ID VARCHAR, PICKUP_LAT FLOAT, PICKUP_LON FLOAT, PICKUP_GEOM GEOGRAPHY,
      DROPOFF_POI_ID VARCHAR, DROPOFF_LAT FLOAT, DROPOFF_LON FLOAT, DROPOFF_GEOM GEOGRAPHY,
      PICKUP_FROM_TS TIMESTAMP_NTZ, PICKUP_TO_TS TIMESTAMP_NTZ,
      WEIGHT_KG NUMBER, PRODUCT VARCHAR, PRICE_USD NUMBER, HAZMAT BOOLEAN,
      LISTING_TEXT VARCHAR, POSTED_AT TIMESTAMP_NTZ,
      JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Freight Exchange (Phase A/B) — enrichment columns on FACT_FREIGHT_OFFERS.
    // Idempotent ALTERs so older deployments pick them up on next boot.
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS EQUIPMENT VARCHAR(20)`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS ADR_CLASS VARCHAR(8)`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS LDM FLOAT`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS DISTANCE_KM FLOAT`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS PRICE_PER_KM_USD FLOAT`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS PARTNER_ID VARCHAR`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS ADD COLUMN IF NOT EXISTS STATUS VARCHAR(20)`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Freight Exchange — partner directory and lane history per preset.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_PARTNERS (
      PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      NAME VARCHAR, COUNTRY VARCHAR(4),
      CREDIT_SCORE NUMBER, PAYMENT_DAYS_AVG NUMBER, KYC_STATUS VARCHAR(20),
      BLACKLIST_FLAG BOOLEAN, FOUNDED_YEAR NUMBER,
      JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_PARTNER_HISTORY (
      PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
      ORIGIN_COUNTRY VARCHAR(4), DEST_COUNTRY VARCHAR(4),
      EQUIPMENT VARCHAR(20),
      SHIPPED_AT TIMESTAMP_NTZ, EUR_PER_KM FLOAT,
      OUTCOME VARCHAR(20),
      JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // -----------------------------------------------------------------
    // Universal-generation entity tables (Overture + free Marketplace).
    // All region-keyed (no VEHICLE_TYPE — they describe the place/area,
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
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Hazard / disaster zones: FEMA NRI (+ optional Divisions boundary).
    // Generalises emergency-response's V_ZIP_RISK to any region.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_HAZARD_ZONES (
      ZONE_ID VARCHAR, REGION VARCHAR(100), STATE VARCHAR, COUNTY VARCHAR, FIPS VARCHAR(10),
      HAZARD_TYPE VARCHAR(40), RISK_SCORE FLOAT, RISK_RATING VARCHAR(40), RISK_LEVEL INT,
      GEOM GEOGRAPHY, SOURCE VARCHAR(40), JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Area demographics: SafeGraph Open Census (block-group) joined to region.
    // Retires the static DEMO_AREA_DEMOGRAPHICS.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_AREA_DEMOGRAPHICS (
      AREA_ID VARCHAR, REGION VARCHAR(100), AREA_TYPE VARCHAR(20),
      STATE_FIPS VARCHAR(4), COUNTY_FIPS VARCHAR(8),
      LAT FLOAT, LNG FLOAT, GEOM GEOGRAPHY,
      TOTAL_POPULATION NUMBER, MEDIAN_AGE FLOAT, MEDIAN_HOUSEHOLD_INCOME NUMBER,
      POP_ELDERLY NUMBER, POP_CHILDREN NUMBER, POPULATION_DENSITY FLOAT,
      SOURCE VARCHAR(40), JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    // Demand catalog: neutral category-derived handling tiers (no domain
    // labels). Retires the static DEMO_DEMAND_CATALOG.
    { sql: `CREATE TABLE IF NOT EXISTS ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_DEMAND_CATALOG (
      ITEM_ID VARCHAR, REGION VARCHAR(100), CATEGORY VARCHAR(60),
      DEMAND_TIER INT, TIER_LABEL VARCHAR(40), HANDLING VARCHAR(60),
      JOB_ID VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: UNIFIED_DB, schema: UNIFIED_SCHEMA },
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.GENERATION_JOBS (
      JOB_ID VARCHAR, PRESET_ID VARCHAR, PRESET_NAME VARCHAR, REGION VARCHAR(100),
      ORS_PROFILE VARCHAR(30), NUM_VEHICLES INT,
      START_DATE VARCHAR, END_DATE VARCHAR,
      STATUS VARCHAR(20), CONFIG VARIANT,
      POINTS_GENERATED INT DEFAULT 0, TRIPS_GENERATED INT DEFAULT 0,
      ERROR_MESSAGE VARCHAR, STARTED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
      COMPLETED_AT TIMESTAMP_NTZ, LOG_TEXT VARIANT
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    { sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS ADD COLUMN IF NOT EXISTS PRESET_ID VARCHAR;
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
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-studio-job-events","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
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
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    // Idempotent backfill from existing data. Latest JOB_ID per
    // (REGION, VEHICLE_TYPE) -> IS_ACTIVE = TRUE; older JOB_IDs (if any
    // survived prior cleanRegionScope deletions) -> IS_ACTIVE = FALSE.
    // Skipped row-by-row via NOT EXISTS so re-runs are safe.
    { sql: `INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_DATASETS
      (DATASET_ID, REGION, VEHICLE_TYPE, LABEL, IS_ACTIVE, CREATED_AT)
      WITH all_jobs AS (
        SELECT REGION, VEHICLE_TYPE, JOB_ID, MAX(POSTED_AT) AS LAST_TS
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS
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
  for (const { sql, db, schema } of ddls) {
    try {
      await snowSql(sql, db, schema);
    } catch (e: any) {
      const raw = e.message || '';
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
