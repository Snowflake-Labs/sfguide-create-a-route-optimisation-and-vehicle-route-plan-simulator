// Boot-time idempotent init for Backload Matching (BACKLOAD_MATCHING schema +
// projection views over UNIFIED) and Asset Velocity (ROUTE_OPTIMIZATION views
// over DWELL_ANALYSIS DTs). Mirrors the contents of:
//   .cortex/skills/backload-matching/references/bootstrap.sql
//   .cortex/skills/route-optimization/references/asset-velocity-views.sql
// so a fresh install of install-fleet-apps makes both demos work without
// requiring a manual `snow sql -f` step.

import { currentRegionScalar } from './region';
import { log } from '../diagnostics';
import { ensureTables as ensureUnifiedTables } from '../studio/ensure-tables';
import { ensureVehicleProfileCatalog } from '../studio/vehicle-profile-catalog';
import { ensureGenerationProfileCatalog } from '../studio/generation-profile-catalog';

// Tracking tag for ROUTE_OPTIMIZATION (Asset Velocity) objects.
const TRACK_RO_AV = `'{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;

// Asset Velocity view definitions - SINGLE runtime source of truth.
// Both the boot path (ensureBackloadAndAssetVelocityObjects) and the lazy
// self-heal endpoint (POST /api/asset-velocity/ensure -> ensureAssetVelocityViews)
// run these, so there is exactly one runtime copy.
// Keep in sync with .cortex/skills/route-optimization/references/asset-velocity-views.sql.
function assetVelocityStmts(): { sql: string; db?: string; schema?: string }[] {
  return [
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS DAILY_RENTAL_RATE_AVOIDED_USD NUMBER(10,2)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS RENTAL_CAPTURE_RATE NUMBER(4,3)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS MAX_REPOSITION_MINUTES NUMBER(6,0)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG ADD COLUMN IF NOT EXISTS AVOID_FEATURES VARCHAR(200)`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG
              SET DAILY_RENTAL_RATE_AVOIDED_USD = COALESCE(DAILY_RENTAL_RATE_AVOIDED_USD, 80.00),
                  RENTAL_CAPTURE_RATE          = COALESCE(RENTAL_CAPTURE_RATE, 0.600),
                  MAX_REPOSITION_MINUTES       = COALESCE(MAX_REPOSITION_MINUTES, 600),
                  AVOID_FEATURES               = COALESCE(AVOID_FEATURES, 'tollways,ferries')`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_VEHICLES
        COMMENT = ${TRACK_RO_AV}
        AS
        WITH cfg AS (
          SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG LIMIT 1
        ),
        last_session AS (
          SELECT
            e.VEHICLE_ID, e.SESSION_ID, e.STATUS, e.LOCATION_ID, e.LOCATION_NAME,
            e.CITY, e.FACILITY_TYPE, e.LOC_TYPE, e.SESSION_START, e.SESSION_END,
            e.DWELL_MINUTES, e.AVG_POINT, e.HOME_BASE_NAME, e.OPERATING_MODE,
            e.DRIVER_PROFILE,
            ROW_NUMBER() OVER (PARTITION BY e.VEHICLE_ID ORDER BY e.SESSION_END DESC) AS RN
          FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED e
          WHERE (e.STATUS LIKE 'DWELL%' OR e.STATUS = 'IDLE')
            AND COALESCE(UPPER(e.STATUS), '') NOT LIKE '%MAINTENANCE%'
            AND COALESCE(UPPER(e.DRIVER_PROFILE), 'COMPLIANT') <> 'OUTLIER'
        ),
        fleet AS (
          SELECT f.VEHICLE_ID, f.REGION, f.HOME_LOCATION_ID, f.DRIVER_PROFILE
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f, cfg
          WHERE f.VEHICLE_TYPE = cfg.VEHICLE_TYPE
            AND f.REGION       = cfg.REGION
        )
        SELECT
          ls.VEHICLE_ID, f.REGION,
          ls.LOCATION_ID                                                            AS LAST_LOCATION_ID,
          ls.LOCATION_NAME                                                          AS LAST_LOCATION_NAME,
          ls.LOC_TYPE                                                               AS LAST_LOCATION_TYPE,
          ls.AVG_POINT                                                              AS LAST_LOCATION_GEOM,
          ST_X(ls.AVG_POINT)                                                        AS LAST_LNG,
          ST_Y(ls.AVG_POINT)                                                        AS LAST_LAT,
          ls.SESSION_START                                                          AS IDLE_SINCE,
          ls.DWELL_MINUTES                                                          AS IDLE_MINUTES,
          ROUND(ls.DWELL_MINUTES / 60.0, 1)                                         AS IDLE_HOURS,
          ROUND(ls.DWELL_MINUTES / 60.0 / 24.0, 2)                                  AS IDLE_DAYS,
          ls.HOME_BASE_NAME,
          'DISP-' || LPAD(MOD(ABS(HASH(ls.VEHICLE_ID)), 12) + 1, 2, '0')            AS ASSIGNED_DISPATCHER,
          ls.DRIVER_PROFILE
        FROM last_session ls
        JOIN fleet f ON ls.VEHICLE_ID = f.VEHICLE_ID
        WHERE ls.RN = 1`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_LANE_DEMAND
        COMMENT = ${TRACK_RO_AV}
        AS
        WITH cfg AS (
          SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG LIMIT 1
        ),
        window_bounds AS (
          SELECT MAX(t.TRIP_START) AS MAX_TS
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t, cfg
          WHERE t.VEHICLE_TYPE = cfg.VEHICLE_TYPE
            AND t.REGION       = cfg.REGION
        ),
        recent_trips AS (
          SELECT t.*
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t, window_bounds w, cfg
          WHERE t.VEHICLE_TYPE = cfg.VEHICLE_TYPE
            AND t.REGION       = cfg.REGION
            AND t.TRIP_START   >= DATEADD('day', -30, w.MAX_TS)
        ),
        flows AS (
          SELECT ORIGIN_POI_ID      AS POI_ID, COUNT(*) AS OUT_CNT, 0 AS IN_CNT FROM recent_trips GROUP BY 1
          UNION ALL
          SELECT DESTINATION_POI_ID AS POI_ID, 0 AS OUT_CNT, COUNT(*) AS IN_CNT FROM recent_trips GROUP BY 1
        ),
        agg AS (
          SELECT POI_ID, SUM(OUT_CNT) AS OUTBOUND, SUM(IN_CNT) AS INBOUND
          FROM flows
          WHERE POI_ID IS NOT NULL
          GROUP BY POI_ID
        )
        SELECT
          p.LOCATION_ID                                       AS TERMINAL_ID,
          p.REGION,
          p.NAME                                              AS TERMINAL_NAME,
          p.LOCATION_TYPE,
          p.POINT_GEOM                                        AS TERMINAL_GEOM,
          p.LAT                                               AS TERMINAL_LAT,
          p.LNG                                               AS TERMINAL_LNG,
          a.OUTBOUND, a.INBOUND,
          (a.OUTBOUND - a.INBOUND)                            AS NET_OUTBOUND_TRIPS,
          GREATEST(0, a.OUTBOUND - a.INBOUND)
            + ROUND(GREATEST(0, a.OUTBOUND - a.INBOUND) * 0.25, 0) AS DEMAND_SCORE
        FROM agg a
        JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p
          ON p.LOCATION_ID = a.POI_ID
        WHERE p.LOCATION_TYPE IN ('WAREHOUSE','LOGISTICS','DEPOT','TERMINAL','ADDRESS','STORE','RESTAURANT')
          AND (a.OUTBOUND - a.INBOUND) > 0`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_FLEET_VEHICLE_PROFILE
        COMMENT = ${TRACK_RO_AV}
        AS
        WITH cfg AS (
          SELECT REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG LIMIT 1
        ),
        filtered AS (
          SELECT f.*, MOD(ABS(HASH(f.VEHICLE_ID)), 100) AS BKT
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT f, cfg
          WHERE f.REGION = cfg.REGION AND f.VEHICLE_TYPE = cfg.VEHICLE_TYPE
          QUALIFY ROW_NUMBER() OVER (PARTITION BY f.VEHICLE_ID ORDER BY f.JOB_ID DESC NULLS LAST) = 1
        )
        SELECT
          f.VEHICLE_ID, f.REGION, f.VEHICLE_TYPE, f.ORS_PROFILE, f.OPERATING_MODE,
          CASE
            WHEN f.OPERATING_MODE <> 'regional_hgv' THEN NULL
            WHEN f.BKT <  60 THEN 'DRY'
            WHEN f.BKT <  85 THEN 'REEFER'
            WHEN f.BKT <  97 THEN 'FLAT'
            ELSE 'TANKER'
          END AS VEHICLE_SUBTYPE,
          CASE WHEN f.OPERATING_MODE = 'regional_hgv' AND f.BKT = 99 THEN TRUE ELSE FALSE END AS HAZMAT,
          CASE WHEN f.OPERATING_MODE = 'regional_hgv'
               THEN ROUND(38 + (MOD(ABS(HASH(f.VEHICLE_ID || '_w')), 600) / 100.0), 2)
               ELSE 2.0 END AS WEIGHT_TONS,
          CASE WHEN f.OPERATING_MODE = 'regional_hgv' THEN 4.00 ELSE 2.00 END AS HEIGHT_M,
          CASE WHEN f.OPERATING_MODE = 'regional_hgv' THEN 16.50 ELSE 4.50 END AS LENGTH_M,
          CASE WHEN f.OPERATING_MODE = 'regional_hgv' THEN 2.55 ELSE 1.85 END AS WIDTH_M,
          CASE WHEN f.OPERATING_MODE = 'regional_hgv' THEN 11.50 ELSE 1.20 END AS AXLELOAD_T
        FROM filtered f`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_VEHICLE_COST_OF_IDLENESS
        COMMENT = ${TRACK_RO_AV}
        AS
        SELECT
          t.VEHICLE_ID, t.REGION, t.LAST_LOCATION_NAME, t.LAST_LOCATION_TYPE,
          t.LAST_LNG, t.LAST_LAT, t.LAST_LOCATION_GEOM,
          t.IDLE_SINCE, t.IDLE_MINUTES, t.IDLE_HOURS, t.IDLE_DAYS,
          t.ASSIGNED_DISPATCHER, t.DRIVER_PROFILE,
          c.DAILY_RENTAL_RATE_AVOIDED_USD, c.RENTAL_CAPTURE_RATE,
          c.MAX_REPOSITION_MINUTES, c.AVOID_FEATURES,
          hgv.VEHICLE_SUBTYPE, hgv.HAZMAT, hgv.WEIGHT_TONS, hgv.HEIGHT_M,
          hgv.LENGTH_M, hgv.WIDTH_M, hgv.AXLELOAD_T, hgv.ORS_PROFILE,
          ROUND(t.IDLE_DAYS * c.DAILY_RENTAL_RATE_AVOIDED_USD, 2)                            AS COST_OF_IDLENESS_USD,
          ROUND(t.IDLE_DAYS * c.DAILY_RENTAL_RATE_AVOIDED_USD * c.RENTAL_CAPTURE_RATE, 2)    AS PROJECTED_SAVINGS_USD,
          CASE
            WHEN t.IDLE_DAYS >= 14 THEN 'CRITICAL'
            WHEN t.IDLE_DAYS >= 7  THEN 'WARNING'
            WHEN t.IDLE_DAYS >= 3  THEN 'WATCH'
            ELSE 'OK'
          END                                                                                AS IDLE_SEVERITY
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_IDLE_VEHICLES t
        LEFT JOIN FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_FLEET_VEHICLE_PROFILE hgv
          ON hgv.VEHICLE_ID = t.VEHICLE_ID
        CROSS JOIN (SELECT MAX(DAILY_RENTAL_RATE_AVOIDED_USD) AS DAILY_RENTAL_RATE_AVOIDED_USD,
                           MAX(RENTAL_CAPTURE_RATE)          AS RENTAL_CAPTURE_RATE,
                           MAX(MAX_REPOSITION_MINUTES)       AS MAX_REPOSITION_MINUTES,
                           MAX(AVOID_FEATURES)               AS AVOID_FEATURES
                    FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG) c`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
  ];
}

// Lazy self-heal for the Asset Velocity page. Called at boot AND by
// POST /api/asset-velocity/ensure. Gated on DWELL_ANALYSIS.DT_DWELL_ENRICHED
// existing (Snowflake validates referenced objects at CREATE VIEW time), so on
// a fresh install where dwell-analysis is deployed AFTER the container boots,
// the first page visit recreates the views without a restart. Log-only; never
// throws to the caller.
export async function ensureAssetVelocityViews(
  sqlFn: (sql: string, db?: string, schema?: string) => Promise<any[]>,
): Promise<{ ensured: boolean; reason?: string }> {
  // Guard: RO.CONFIG must exist and carry the active-preset pointer row.
  try {
    await sqlFn(
      `CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION COMMENT = ${TRACK_RO_AV}`,
      'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
    );
    await sqlFn(
      `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG (VEHICLE_TYPE VARCHAR, REGION VARCHAR) COMMENT = ${TRACK_RO_AV}`,
      'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
    );
    // Seed the pointer from the active dataset only if empty, so we never
    // clobber a region the user selected via the dataset picker.
    await sqlFn(
      `INSERT INTO FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG (VEHICLE_TYPE, REGION)
         SELECT d.VEHICLE_TYPE, d.REGION
         FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
         WHERE d.IS_ACTIVE = TRUE
           AND NOT EXISTS (SELECT 1 FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG)
         LIMIT 1`,
      'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
    );
  } catch (e: any) {
    log('WARN', 'Init', `asset-velocity CONFIG guard failed: ${e?.message?.slice(0, 200)}`);
  }

  // Gate on the dwell-analysis dependency. If absent, skip cleanly so the page
  // keeps its empty state instead of surfacing a SQL error.
  try {
    await sqlFn(
      `SELECT 1 FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED LIMIT 1`,
      'FLEET_INTELLIGENCE', 'DWELL_ANALYSIS',
    );
  } catch {
    return { ensured: false, reason: 'dwell-not-deployed' };
  }

  for (const { sql, db, schema } of assetVelocityStmts()) {
    try {
      await sqlFn(sql, db, schema);
    } catch (e: any) {
      log('WARN', 'Init', `asset-velocity ensure step failed: ${e?.message?.slice(0, 200)}`);
    }
  }
  return { ensured: true };
}

export async function ensureBackloadAndAssetVelocityObjects(
  sqlFn: (sql: string, db?: string, schema?: string) => Promise<any[]>,
): Promise<void> {
  // -----------------------------------------------------------------
  // Bootstrap fix for friction-log F4: ensure FLEET_INTELLIGENCE.CORE.DIM_DATASETS
  // (and the UNIFIED base tables) exist BEFORE we try to create the
  // V_*_CURRENT projection views below. Otherwise on a fresh install - where
  // no Studio job has ever run - DIM_DATASETS does not exist and every
  // CREATE OR REPLACE VIEW V_*_CURRENT fails with "object does not exist",
  // breaking every demo that reads through these views.
  // ensureUnifiedTables() is idempotent: CREATE TABLE IF NOT EXISTS + an
  // INSERT ... WHERE NOT EXISTS backfill, so calling it on every boot is safe.
  // -----------------------------------------------------------------
  try {
    await ensureUnifiedTables(sqlFn);
  } catch (e: any) {
    log('WARN', 'Init', `ensureUnifiedTables failed: ${e?.message?.slice(0, 200)}`);
  }
  // Vehicle-type parameter catalog - single source of truth for per-mode asset
  // dimensions + evaluation thresholds (dwell SLA, deviation ratio, teleport m).
  // Must run before the V_*_CURRENT views / contract UDTFs and before any
  // generation stamps DIM_FLEET from it. Idempotent (CREATE IF NOT EXISTS +
  // MERGE upsert) so re-tuned defaults propagate on every boot.
  try {
    await ensureVehicleProfileCatalog(sqlFn);
  } catch (e: any) {
    log('WARN', 'Init', `ensureVehicleProfileCatalog failed: ${e?.message?.slice(0, 200)}`);
  }
  // Generation profile catalog - persists the built-in generation templates as
  // data so a new mode can be added by INSERTing a profile row (no engine edits).
  // Idempotent (CREATE IF NOT EXISTS + MERGE upsert of built-in rows).
  try {
    await ensureGenerationProfileCatalog(sqlFn);
  } catch (e: any) {
    log('WARN', 'Init', `ensureGenerationProfileCatalog failed: ${e?.message?.slice(0, 200)}`);
  }
  const TRACK = `'{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;
  const TRACK_RO = `'{"origin":"sf_sit-is-fleet","name":"oss-route-optimization","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;
  const TRACK_FX = `'{"origin":"sf_sit-is-fleet","name":"oss-freight-exchange","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;
  const stmts: { sql: string; db?: string; schema?: string }[] = [
    // Table rename migration for existing deploys: FACT_DELIVERIES -> FACT_OFFERS.
    // Fresh installs create FACT_OFFERS directly via ensure-tables.ts; the ALTER
    // is a no-op (object doesn't exist) and continues via try/catch.
    { sql: `ALTER TABLE IF EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_DELIVERIES RENAME TO SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `ALTER TABLE IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_DELIVERY_ROUTES RENAME TO FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES`, db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE' },
    // Asset-attribute migration for existing installs (boot-only). DIM_FLEET's
    // V_DIM_FLEET_CURRENT view is `SELECT f.*`, so ADD COLUMN invalidates its
    // declared column count - drop it FIRST, then add columns; the view is
    // recreated unconditionally later in this same boot (CREATE OR REPLACE
    // V_DIM_FLEET_CURRENT below). Fresh installs already get these columns from
    // the DIM_FLEET CREATE TABLE in studio/ensure-tables.ts. This migration is
    // intentionally NOT in ensure-tables.ts (which also runs at generation
    // time) so a generation run never drops the view without recreating it.
    { sql: `DROP VIEW IF EXISTS SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS WEIGHT_TONS NUMBER(6,2)`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS HEIGHT_M NUMBER(4,2)`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS LENGTH_M NUMBER(4,2)`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS WIDTH_M NUMBER(4,2)`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS AXLELOAD_T NUMBER(4,2)`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS HAZMAT BOOLEAN`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET ADD COLUMN IF NOT EXISTS VEHICLE_SUBTYPE VARCHAR(16)`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    // VEHICLE_CLASS_PROFILE - single source of truth for per-vehicle-class
    // capacity, costs, ORS profile, and UI label. Lives in
    // OPENROUTESERVICE_APP.CORE so any page on any preset can read it.
    {
      sql: `CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE (
        VEHICLE_TYPE      VARCHAR PRIMARY KEY,
        ORS_PROFILE       VARCHAR  NOT NULL,
        PAYLOAD_KG_TYP    NUMBER   NOT NULL,
        PAYLOAD_KG_MAX    NUMBER   NOT NULL,
        SHIPMENT_KG_MIN   NUMBER   NOT NULL,
        SHIPMENT_KG_MAX   NUMBER   NOT NULL,
        AVG_SPEED_KMH     NUMBER   NOT NULL,
        COST_EUR_PER_KM   FLOAT    NOT NULL,
        COST_EUR_PER_HR   FLOAT    NOT NULL,
        ENFORCE_BREAK     BOOLEAN  NOT NULL,
        HOME_RANGE_KM     NUMBER   NOT NULL,
        LABEL_NOUN        VARCHAR  NOT NULL
      ) COMMENT = ${TRACK}`,
      db: 'OPENROUTESERVICE_APP', schema: 'CORE',
    },
    {
      sql: `MERGE INTO OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE tgt
        USING (
          SELECT * FROM VALUES
            ('bicycle',    'cycling-regular',     15,    25,    1,    15,  18,  0.05,  8.0, FALSE,  15, 'bicycle'),
            ('ebike',      'cycling-electric',    25,    40,    2,    25,  22,  0.08, 10.0, FALSE,  25, 'ebike'),
            ('foot',       'foot-walking',         5,    10,    1,     5,   5,  0.02, 12.0, FALSE,   5, 'pedestrian'),
            ('motorcycle', 'driving-car',         20,    50,    1,    20,  45,  0.20, 18.0, FALSE,  80, 'motorcycle'),
            ('car',        'driving-car',        400,   600,   50,   400,  50,  0.30, 22.0, FALSE,  80, 'car'),
            ('van',        'driving-car',       1500,  3500,  100,  1500,  55,  0.55, 28.0, FALSE, 150, 'van'),
            ('hgv',        'driving-hgv',      24000, 26000, 1000, 24000,  60,  0.85, 38.0, TRUE,  200, 'trailer'),
            ('truck',      'driving-hgv',      24000, 26000, 1000, 24000,  60,  0.85, 38.0, TRUE,  200, 'truck')
          AS v(VEHICLE_TYPE, ORS_PROFILE, PAYLOAD_KG_TYP, PAYLOAD_KG_MAX, SHIPMENT_KG_MIN, SHIPMENT_KG_MAX, AVG_SPEED_KMH, COST_EUR_PER_KM, COST_EUR_PER_HR, ENFORCE_BREAK, HOME_RANGE_KM, LABEL_NOUN)
        ) src
        ON tgt.VEHICLE_TYPE = src.VEHICLE_TYPE
        WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, ORS_PROFILE, PAYLOAD_KG_TYP, PAYLOAD_KG_MAX, SHIPMENT_KG_MIN, SHIPMENT_KG_MAX, AVG_SPEED_KMH, COST_EUR_PER_KM, COST_EUR_PER_HR, ENFORCE_BREAK, HOME_RANGE_KM, LABEL_NOUN)
          VALUES (src.VEHICLE_TYPE, src.ORS_PROFILE, src.PAYLOAD_KG_TYP, src.PAYLOAD_KG_MAX, src.SHIPMENT_KG_MIN, src.SHIPMENT_KG_MAX, src.AVG_SPEED_KMH, src.COST_EUR_PER_KM, src.COST_EUR_PER_HR, src.ENFORCE_BREAK, src.HOME_RANGE_KM, src.LABEL_NOUN)`,
      db: 'OPENROUTESERVICE_APP', schema: 'CORE',
    },
    {
      sql: `CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG (
        VEHICLE_TYPE VARCHAR NOT NULL,
        REGION       VARCHAR NOT NULL
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      // Derive the active preset from the most-populated (VEHICLE_TYPE, REGION)
      // in FACT_TRIPS UNION DIM_FLEET rather than hardcoding 'hgv'. Self-heals a
      // stale row whenever the current preset has no trips (friction-log F4).
      sql: `MERGE INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG tgt
            USING (
              WITH counts AS (
                SELECT t.VEHICLE_TYPE, t.REGION, COUNT(*) AS n
                FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
                WHERE t.VEHICLE_TYPE IS NOT NULL AND t.REGION IS NOT NULL
                GROUP BY 1, 2
                UNION ALL
                SELECT f.VEHICLE_TYPE, f.REGION, COUNT(*) AS n
                FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
                WHERE f.VEHICLE_TYPE IS NOT NULL AND f.REGION IS NOT NULL
                GROUP BY 1, 2
              ),
              ranked AS (
                SELECT VEHICLE_TYPE, REGION, SUM(n) AS total_rows
                FROM counts GROUP BY 1, 2
                QUALIFY ROW_NUMBER() OVER (ORDER BY SUM(n) DESC) = 1
              )
              SELECT VEHICLE_TYPE, REGION FROM ranked
            ) src
            ON TRUE
            WHEN MATCHED AND NOT EXISTS (
              SELECT 1 FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS ft
              WHERE ft.VEHICLE_TYPE = tgt.VEHICLE_TYPE AND ft.REGION = tgt.REGION
            )
              THEN UPDATE SET tgt.VEHICLE_TYPE = src.VEHICLE_TYPE, tgt.REGION = src.REGION
            WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS (
        DECISION_ID VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
        TRAILER_ID  VARCHAR,
        OFFER_ID    VARCHAR,
        SOURCE      VARCHAR,
        SCORE       FLOAT,
        EMPTY_KM    FLOAT,
        DECIDED_BY  VARCHAR,
        DECIDED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
        RATIONALE   VARCHAR
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS
        COMMENT = ${TRACK}
        AS
        WITH last_drop AS (
          SELECT VEHICLE_ID,
                 MAX_BY(DESTINATION_LON, TRIP_END) AS DROPOFF_LON,
                 MAX_BY(DESTINATION_LAT, TRIP_END) AS DROPOFF_LAT,
                 MAX_BY(DESTINATION_POI_ID, TRIP_END) AS DROPOFF_POI_ID,
                 MAX(TRIP_END) AS LAST_TRIP_END
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT
          WHERE REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
            AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
          GROUP BY VEHICLE_ID
        ),
        home_anchor AS (
          SELECT AVG(LAT) AS HOME_LAT, AVG(LNG) AS HOME_LON
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
        ),
        -- Collapse DIM_POIS to one row per LOCATION_ID. The base table can have
        -- multiple rows per LOCATION_ID (POI name variants, regen overlap),
        -- which would otherwise multiply trailer rows via the LEFT JOINs below
        -- and cause VROOM to receive the same TRAILER_ID as multiple vehicles.
        poi AS (
          SELECT LOCATION_ID,
                 ANY_VALUE(NAME) AS NAME,
                 ANY_VALUE(LAT)  AS LAT,
                 ANY_VALUE(LNG)  AS LNG
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
          GROUP BY LOCATION_ID
        ),
        -- Collapse DIM_FLEET to one row per VEHICLE_ID for the same reason
        -- (the synthetic dataset can carry duplicate fleet rows).
        fleet AS (
          SELECT VEHICLE_ID,
                 ANY_VALUE(REGION)             AS REGION,
                 ANY_VALUE(VEHICLE_TYPE)       AS VEHICLE_TYPE,
                 ANY_VALUE(HOME_LOCATION_ID)   AS HOME_LOCATION_ID,
                 ANY_VALUE(BATTERY_RANGE_KM)   AS BATTERY_RANGE_KM
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT
          WHERE REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
            AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
          GROUP BY VEHICLE_ID
        ),
        -- Resolve the active vehicle_type to its class profile. If the
        -- vehicle_type isn't in VEHICLE_CLASS_PROFILE the JOIN returns 0 rows
        -- so the view is empty - the React page surfaces this as a precise
        -- "Unknown vehicle_type - add a row to VEHICLE_CLASS_PROFILE" error.
        cls AS (
          SELECT vcp.*
          FROM OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE vcp
          WHERE vcp.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
        )
        SELECT
          f.VEHICLE_ID                                        AS TRAILER_ID,
          f.REGION                                            AS OPERATING_COUNTRY,
          COALESCE(h.NAME, 'Home Depot')                      AS HOME_DEPOT,
          COALESCE(h.LNG, (SELECT HOME_LON FROM home_anchor)) AS HOME_LON,
          COALESCE(h.LAT, (SELECT HOME_LAT FROM home_anchor)) AS HOME_LAT,
          f.VEHICLE_TYPE                                      AS CURRENT_LOAD,
          COALESCE(d.NAME, 'Drop-off')                        AS DROPOFF_CITY,
          ld.DROPOFF_LON                                      AS DROPOFF_LON,
          ld.DROPOFF_LAT                                      AS DROPOFF_LAT,
          ld.LAST_TRIP_END                                    AS ETA_TS,
          DATEDIFF('minute', CURRENT_TIMESTAMP(), ld.LAST_TRIP_END) AS ETA_MIN,
          'IN_TRANSIT'                                        AS STATUS,
          FALSE                                               AS HAZMAT_CERT,
          (SELECT PAYLOAD_KG_TYP FROM cls)::NUMBER            AS MAX_PAYLOAD_KG,
          NULLIF(f.BATTERY_RANGE_KM, 0)                       AS EV_RANGE_KM
        FROM fleet f
        JOIN last_drop ld ON ld.VEHICLE_ID = f.VEHICLE_ID
        LEFT JOIN poi h ON h.LOCATION_ID = f.HOME_LOCATION_ID
        LEFT JOIN poi d ON d.LOCATION_ID = ld.DROPOFF_POI_ID
        WHERE EXISTS (SELECT 1 FROM cls)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES
        COMMENT = ${TRACK}
        AS
        WITH poi AS (
          -- Same pre-aggregation as VW_EXTERNAL_OFFERS / VW_TRAILERS:
          -- DIM_POIS may have multiple rows per LOCATION_ID after Studio
          -- re-runs, which would otherwise multiply trip rows here.
          SELECT LOCATION_ID,
                 ANY_VALUE(NAME) AS NAME
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
          GROUP BY LOCATION_ID
        ),
        trips AS (
          -- Defence-in-depth: even though FACT_TRIPS uses random TRIP_IDs
          -- per Studio run (so source dedupe is normally a no-op), keep
          -- one row per TRIP_ID so a future regression cannot multiply
          -- VROOM shipments under different INT-NNNNN ids.
          SELECT t.TRIP_ID,
                 t.TRIP_START,
                 t.ORIGIN_LON, t.ORIGIN_LAT,
                 t.DESTINATION_LON, t.DESTINATION_LAT,
                 t.ORIGIN_POI_ID, t.DESTINATION_POI_ID
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT t
          WHERE t.REGION       = ${currentRegionScalar('BACKLOAD_MATCHING')}
            AND t.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
          QUALIFY ROW_NUMBER() OVER (PARTITION BY t.TRIP_ID ORDER BY t.TRIP_START DESC) = 1
        ),
        cls AS (
          SELECT vcp.*
          FROM OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE vcp
          WHERE vcp.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
        )
        SELECT
          'INT-' || LPAD(ROW_NUMBER() OVER (ORDER BY t.TRIP_START)::VARCHAR, 5, '0') AS ID,
          COALESCE(o.NAME, 'Origin')                                                  AS PICKUP_CITY,
          t.ORIGIN_LON                                                                AS PICKUP_LON,
          t.ORIGIN_LAT                                                                AS PICKUP_LAT,
          COALESCE(d.NAME, 'Destination')                                             AS DROPOFF_CITY,
          t.DESTINATION_LON                                                           AS DROPOFF_LON,
          t.DESTINATION_LAT                                                           AS DROPOFF_LAT,
          -- Future-aware pickup window: anchor at "now + 30..630 min" so the
          -- vehicle's shift (which can never start in the past) can always
          -- overlap. Old behaviour anchored at TRIP_START which is in the past
          -- on fresh installs and produced no overlap with the shift window.
          GREATEST(
            t.TRIP_START,
            DATEADD('minute', MOD(ABS(HASH(t.TRIP_ID)), 600) + 30, CURRENT_TIMESTAMP())
          )                                                                           AS PICKUP_FROM_TS,
          DATEADD(hour, 4,
            GREATEST(
              t.TRIP_START,
              DATEADD('minute', MOD(ABS(HASH(t.TRIP_ID)), 600) + 30, CURRENT_TIMESTAMP())
            )
          )                                                                           AS PICKUP_TO_TS,
          -- Class-aware weight clamp: random weight in [SHIPMENT_KG_MIN, SHIPMENT_KG_MAX].
          (
            (SELECT SHIPMENT_KG_MIN FROM cls)
            + ABS(HASH(t.TRIP_ID)) % NULLIF(((SELECT SHIPMENT_KG_MAX FROM cls) - (SELECT SHIPMENT_KG_MIN FROM cls)), 0)
          )::NUMBER                                                                   AS WEIGHT_KG,
          'B2B pallets'                                                               AS PRODUCT,
          FALSE                                                                       AS HAZMAT
        FROM trips t
        LEFT JOIN poi o ON o.LOCATION_ID = t.ORIGIN_POI_ID
        LEFT JOIN poi d ON d.LOCATION_ID = t.DESTINATION_POI_ID
        WHERE EXISTS (SELECT 1 FROM cls)
        QUALIFY ROW_NUMBER() OVER (ORDER BY t.TRIP_START DESC) <= 120`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS (
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
      ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS
        COMMENT = ${TRACK}
        AS
        WITH poi AS (
          -- Collapse DIM_POIS to one row per LOCATION_ID. Re-running Data
          -- Studio for the same region used to compound rows, so the LEFT
          -- JOINs below would multiply offers; pre-aggregating here makes
          -- the view robust to that.
          SELECT LOCATION_ID,
                 ANY_VALUE(NAME) AS NAME
          FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
          GROUP BY LOCATION_ID
        ),
        offers AS (
          -- Dedupe FACT_OFFERS by OFFER_ID. The seed pipeline can
          -- accumulate multiple rows per OFFER_ID across runs; keep the
          -- newest by POSTED_AT (and PICKUP_FROM_TS as tiebreaker).
          SELECT *
          FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_OFFERS_CURRENT
          WHERE REGION = ${currentRegionScalar('BACKLOAD_MATCHING')}
          QUALIFY ROW_NUMBER() OVER (
            PARTITION BY OFFER_ID
            ORDER BY POSTED_AT DESC NULLS LAST, PICKUP_FROM_TS DESC NULLS LAST
          ) = 1
        ),
        cls AS (
          SELECT vcp.*
          FROM OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE vcp
          WHERE vcp.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.CONFIG LIMIT 1)
        )
        SELECT
          f.OFFER_ID,
          f.SOURCE,
          COALESCE(SUBSTR(f.REGION, 1, 2), 'US')   AS PICKUP_COUNTRY,
          COALESCE(SUBSTR(f.REGION, 1, 2), 'US')   AS DROPOFF_COUNTRY,
          COALESCE(p.NAME, 'Pickup')               AS PICKUP_CITY,
          f.PICKUP_LON,
          f.PICKUP_LAT,
          COALESCE(d.NAME, 'Dropoff')              AS DROPOFF_CITY,
          f.DROPOFF_LON,
          f.DROPOFF_LAT,
          f.PICKUP_FROM_TS,
          f.PICKUP_TO_TS,
          -- Class-aware weight clamp: rescale FACT_OFFERS.WEIGHT_KG
          -- (which is HGV-shaped at the table level) into the active class's
          -- [SHIPMENT_KG_MIN, SHIPMENT_KG_MAX] band so a fresh ebike preset
          -- never gets 25t shipments.
          LEAST(
            (SELECT SHIPMENT_KG_MAX FROM cls),
            GREATEST(
              (SELECT SHIPMENT_KG_MIN FROM cls),
              ((SELECT SHIPMENT_KG_MIN FROM cls) + ABS(HASH(f.OFFER_ID)) % NULLIF(((SELECT SHIPMENT_KG_MAX FROM cls) - (SELECT SHIPMENT_KG_MIN FROM cls)), 0))::NUMBER
            )
          )                                       AS WEIGHT_KG,
          f.PRODUCT,
          f.PRICE_USD                              AS PRICE_EUR,
          f.HAZMAT,
          f.LISTING_TEXT
        FROM offers f
        LEFT JOIN poi p ON p.LOCATION_ID = f.PICKUP_POI_ID
        LEFT JOIN poi d ON d.LOCATION_ID = f.DROPOFF_POI_ID
        WHERE EXISTS (SELECT 1 FROM cls)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // ---------------------------------------------------------------
    // Card F: AVOID_ZONES - seeded with two real EU low-emission zones
    // (Berlin, Munich) and a sample construction zone. The Backload UI
    // sends the polygons to ORS via vehicle.profile_options.avoid_polygons.
    // ---------------------------------------------------------------
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.AVOID_ZONES (
        ZONE_ID   VARCHAR PRIMARY KEY,
        NAME      VARCHAR,
        CATEGORY  VARCHAR,
        POLYGON   GEOGRAPHY,
        CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `MERGE INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.AVOID_ZONES tgt
        USING (
          SELECT 'BERLIN_LEZ' AS ZONE_ID,
                 'Berlin Umweltzone (LEZ)' AS NAME,
                 'low-emission-zone' AS CATEGORY,
                 TO_GEOGRAPHY('POLYGON((13.310 52.475, 13.450 52.475, 13.450 52.555, 13.310 52.555, 13.310 52.475))') AS POLYGON
          UNION ALL
          SELECT 'MUNICH_LEZ',
                 'München Umweltzone (LEZ)',
                 'low-emission-zone',
                 TO_GEOGRAPHY('POLYGON((11.530 48.110, 11.620 48.110, 11.620 48.180, 11.530 48.180, 11.530 48.110))')
          UNION ALL
          SELECT 'SAMPLE_CONSTRUCTION',
                 'Sample construction zone',
                 'construction',
                 TO_GEOGRAPHY('POLYGON((11.560 48.140, 11.580 48.140, 11.580 48.150, 11.560 48.150, 11.560 48.140))')
        ) src ON tgt.ZONE_ID = src.ZONE_ID
        WHEN NOT MATCHED THEN INSERT (ZONE_ID, NAME, CATEGORY, POLYGON)
                              VALUES (src.ZONE_ID, src.NAME, src.CATEGORY, src.POLYGON)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // Best-effort: extend PROPOSAL_DECISIONS with NET_BENEFIT_EUR for
    // older deployments that pre-date the economics column.
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
              ADD COLUMN IF NOT EXISTS NET_BENEFIT_EUR FLOAT`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
              ADD COLUMN IF NOT EXISTS SOURCE_PAGE VARCHAR(40)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
              ADD COLUMN IF NOT EXISTS DECISION_TYPE VARCHAR(40)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
              ADD COLUMN IF NOT EXISTS BUNDLE_ID VARCHAR`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // ---------------------------------------------------------------
    // Backload Proposals COCKPIT layer (neutral, synthetic-backed).
    // Co-owned SoT with .cortex/skills/backload-matching/references/proposals-schema.sql
    // (keep the two in lockstep). Builds on the base VW_TRAILERS /
    // VW_INTERNAL_VOLUMES / VW_EXTERNAL_OFFERS created just above, so it must
    // stay after them in this array. Without this the default-registered
    // Backload Proposals SA view 422s ("VW_LOADS does not exist") on every
    // fresh install. The per-statement loop is WARN-and-continue, so a
    // first-boot-before-data miss self-heals on the next boot.
    // ---------------------------------------------------------------
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS (
        PARAM_KEY    VARCHAR       NOT NULL,
        PARAM_VALUE  VARCHAR,
        PARAM_TYPE   VARCHAR(16)   DEFAULT 'string',
        CATEGORY     VARCHAR(16)   DEFAULT 'core',
        ENABLED      BOOLEAN       DEFAULT TRUE,
        DESCRIPTION  VARCHAR,
        UPDATED_AT   TIMESTAMP_NTZ DEFAULT SYSDATE(),
        CONSTRAINT PK_MATCH_PARAMS PRIMARY KEY (PARAM_KEY)
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `MERGE INTO FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS tgt USING (
        SELECT * FROM VALUES
          ('MAX_EMPTY_KM',              '100',   'number', 'core',   TRUE,  'Max distance from where a vehicle becomes free to a load pickup (km).'),
          ('ENFORCE_PICKUP_DATE',       'true',  'bool',   'core',   TRUE,  'Vehicle must be free in time for the load pickup window.'),
          ('PICKUP_DATE_SLACK_HRS',     '0',     'number', 'core',   TRUE,  'Hours of slack allowed past the requested pickup window.'),
          ('MAX_PICKUP_HORIZON_DAYS',   '7',     'number', 'core',   TRUE,  'Only consider loads with a pickup within N days of the vehicle free time.'),
          ('DISTANCE_BASIS',            'road',  'string', 'core',   TRUE,  'road = ORS driving distance; great_circle = straight-line. Falls back to great_circle if ORS is unavailable.'),
          ('PREFILTER_BUFFER_PCT',      '40',    'number', 'core',   TRUE,  'Great-circle prefilter radius = MAX_EMPTY_KM * (1 + pct/100).'),
          ('MAX_PROPOSALS_PER_TRAILER', '3',     'number', 'core',   TRUE,  'How many ranked load proposals to keep per vehicle.'),
          ('INTERNAL_PRIORITY',         '100',   'number', 'core',   TRUE,  'VROOM priority applied to internal (own) waiting loads.'),
          ('EXTERNAL_PRIORITY',         '10',    'number', 'core',   TRUE,  'VROOM priority applied to external freight-exchange offers.'),
          ('COST_PER_EMPTY_KM',         '1.20',  'number', 'core',   TRUE,  'Cost per empty km, for the savings KPI.'),
          ('IDLE_COST_PER_DAY',         '650',   'number', 'core',   TRUE,  'Standing-day cost, for the savings KPI.'),
          ('REVENUE_PER_LOADED_KM',     '1.10',  'number', 'core',   TRUE,  'ASSUMPTION: benchmark revenue per loaded km, to translate recovered loaded km into a value figure.'),
          ('ENFORCE_WEIGHT_FIT',        'true',  'bool',   'core',   TRUE,  'Reject pairs where vehicle MAX_PAYLOAD_KG < load WEIGHT_KG + WEIGHT_FIT_MARGIN_KG.'),
          ('WEIGHT_FIT_MARGIN_KG',      '0',     'number', 'core',   TRUE,  'Safety margin (kg) added to load weight when checking ENFORCE_WEIGHT_FIT.'),
          ('REQUIRE_HAZMAT_CERT',       'true',  'bool',   'core',   TRUE,  'Hazmat loads must go on a hazmat-certified vehicle.'),
          ('MAX_CANDIDATE_TRUCKS',      '8',     'number', 'core',   TRUE,  'Per load, how many nearest free vehicles (great-circle) to hand the VROOM solver.'),
          ('MAX_TRUCKS_PER_ORDER',      '3',     'number', 'core',   TRUE,  'How many ranked vehicle recommendations to keep per load in VRP mode.'),
          ('VRP_CONCURRENCY',           '4',     'number', 'core',   TRUE,  'Per-load best fit (road): how many loads to solve in parallel per chunk.'),
          ('PICKUP_WINDOW_HRS',         '12',    'number', 'core',   TRUE,  'Plus/minus tolerance (hours) around the requested pickup time.'),
          ('CLUSTER_CAP',               '250',   'number', 'core',   TRUE,  'Max stops per VROOM cluster before a dense component is spatially sub-split.'),
          ('BPMP_MAX_STOPS',            '4',     'number', 'core',   TRUE,  'Max loads consolidated onto one vehicle in the profit-max backhaul plan.'),
          ('BPMP_MAX_DEADHEAD_KM',      '250',   'number', 'core',   TRUE,  'Hard cap on a vehicle total DEADHEAD (empty) km across the whole return tour.'),
          ('BPMP_MAX_RETURN_KM',        '3000',  'number', 'core',   TRUE,  'Loose total-distance safety guard on a vehicle whole return tour (km).'),
          ('BPMP_PRIORITY_SCALE',       '25',    'number', 'core',   TRUE,  'Revenue->priority divisor: shipment priority = clamp(round(loaded-km revenue / scale), 1..100).'),
          ('BPMP_SOLVER',               'vroom', 'string', 'core',   TRUE,  'vroom = VROOM road solve (falls back to greedy if unreachable); greedy = solver-free greedy builder.'),
          ('TRADELANE_INCLUDE',         '',      'string', 'future', FALSE, 'Comma list of allowed pickup->delivery country lanes.'),
          ('TRADELANE_EXCLUDE',         '',      'string', 'future', FALSE, 'Comma list of forbidden country lanes.'),
          ('RETURN_TO_HOME_REGION',     'false', 'bool',   'future', FALSE, 'Prefer loads that route the vehicle back toward its home depot (triangle trips).')
        AS v(PARAM_KEY, PARAM_VALUE, PARAM_TYPE, CATEGORY, ENABLED, DESCRIPTION)
      ) src
      ON tgt.PARAM_KEY = src.PARAM_KEY
      WHEN NOT MATCHED THEN INSERT (PARAM_KEY, PARAM_VALUE, PARAM_TYPE, CATEGORY, ENABLED, DESCRIPTION)
        VALUES (src.PARAM_KEY, src.PARAM_VALUE, src.PARAM_TYPE, src.CATEGORY, src.ENABLED, src.DESCRIPTION)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSALS (
        PROPOSAL_ID VARCHAR NOT NULL, TRAILER_ID VARCHAR NOT NULL, LOAD_ID VARCHAR NOT NULL,
        IS_INTERNAL BOOLEAN, SOURCE VARCHAR, GREAT_CIRCLE_KM FLOAT, EMPTY_KM FLOAT, EMPTY_DRIVE_MIN FLOAT,
        DISTANCE_BASIS VARCHAR(32), PICKUP_SLACK_HRS FLOAT, EMPTY_FROM_TS TIMESTAMP_NTZ, REQUESTED_PICKUP_TS TIMESTAMP_NTZ,
        LOADED_KM FLOAT, NEXT_START_KM FLOAT, BASELINE_DEADHEAD_KM FLOAT, DETOUR_KM FLOAT, TOTAL_KM FLOAT, TOTAL_DRIVE_MIN FLOAT,
        FEASIBLE BOOLEAN, RANK_IN_TRAILER NUMBER, STOP_SEQ NUMBER, SCORE FLOAT, RATIONALE VARCHAR,
        IS_SAVED BOOLEAN DEFAULT FALSE, SESSION_ID VARCHAR, GENERATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
        CONSTRAINT PK_PROPOSALS PRIMARY KEY (PROPOSAL_ID)
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.FEEDBACK (
        FEEDBACK_ID VARCHAR NOT NULL, PROPOSAL_ID VARCHAR, TRAILER_ID VARCHAR, LOAD_ID VARCHAR,
        ACTION VARCHAR(16), REASON_CODE VARCHAR, COMMENT VARCHAR, DISPATCHER_ROLE VARCHAR, SESSION_ID VARCHAR,
        CREATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
        CONSTRAINT PK_FEEDBACK PRIMARY KEY (FEEDBACK_ID)
      ) COMMENT = ${TRACK}`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // Drop dependents before recreate (column-count invariant on re-run).
    { sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_CANDIDATES_SCORED`, db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING' },
    { sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_CANDIDATES`, db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING' },
    { sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_LOADS`, db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING' },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_LOADS
        COMMENT = ${TRACK}
        AS
        SELECT
          iv.ID AS LOAD_ID, TRUE AS IS_INTERNAL, 'INTERNAL' AS SOURCE,
          iv.PICKUP_CITY, iv.PICKUP_LON, iv.PICKUP_LAT,
          ST_MAKEPOINT(iv.PICKUP_LON, iv.PICKUP_LAT) AS PICKUP_GEOM,
          iv.DROPOFF_CITY AS DELIVERY_CITY, iv.DROPOFF_LON AS DELIVERY_LON, iv.DROPOFF_LAT AS DELIVERY_LAT,
          ST_MAKEPOINT(iv.DROPOFF_LON, iv.DROPOFF_LAT) AS DELIVERY_GEOM,
          iv.PICKUP_FROM_TS AS REQUESTED_PICKUP_TS, iv.PICKUP_TO_TS AS LATEST_PICKUP_TS,
          iv.WEIGHT_KG, iv.PRODUCT, iv.HAZMAT, NULL::NUMBER AS PRICE_USD,
          ST_DISTANCE(ST_MAKEPOINT(iv.PICKUP_LON, iv.PICKUP_LAT), ST_MAKEPOINT(iv.DROPOFF_LON, iv.DROPOFF_LAT)) / 1000.0 AS APPROX_DISTANCE_KM,
          'Internal load: ' || iv.PICKUP_CITY || ' -> ' || iv.DROPOFF_CITY AS LISTING_TEXT
        FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES iv
        WHERE iv.PICKUP_LON IS NOT NULL AND iv.PICKUP_LAT IS NOT NULL
        UNION ALL
        SELECT
          eo.OFFER_ID AS LOAD_ID, FALSE AS IS_INTERNAL, eo.SOURCE,
          eo.PICKUP_CITY, eo.PICKUP_LON, eo.PICKUP_LAT,
          ST_MAKEPOINT(eo.PICKUP_LON, eo.PICKUP_LAT) AS PICKUP_GEOM,
          eo.DROPOFF_CITY AS DELIVERY_CITY, eo.DROPOFF_LON AS DELIVERY_LON, eo.DROPOFF_LAT AS DELIVERY_LAT,
          ST_MAKEPOINT(eo.DROPOFF_LON, eo.DROPOFF_LAT) AS DELIVERY_GEOM,
          eo.PICKUP_FROM_TS AS REQUESTED_PICKUP_TS, eo.PICKUP_TO_TS AS LATEST_PICKUP_TS,
          eo.WEIGHT_KG, eo.PRODUCT, eo.HAZMAT, eo.PRICE_EUR AS PRICE_USD,
          ST_DISTANCE(ST_MAKEPOINT(eo.PICKUP_LON, eo.PICKUP_LAT), ST_MAKEPOINT(eo.DROPOFF_LON, eo.DROPOFF_LAT)) / 1000.0 AS APPROX_DISTANCE_KM,
          eo.LISTING_TEXT
        FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS eo
        WHERE eo.PICKUP_LON IS NOT NULL AND eo.PICKUP_LAT IS NOT NULL`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS_GEO
        COMMENT = ${TRACK}
        AS
        SELECT
          t.TRAILER_ID, t.OPERATING_COUNTRY, t.HOME_DEPOT, t.HOME_LON, t.HOME_LAT,
          t.DROPOFF_CITY AS EMPTY_CITY, t.DROPOFF_LON AS EMPTY_LON, t.DROPOFF_LAT AS EMPTY_LAT,
          ST_MAKEPOINT(t.DROPOFF_LON, t.DROPOFF_LAT) AS EMPTY_GEOM,
          DATEADD('minute', -1 * MOD(ABS(HASH(t.TRAILER_ID)), 720), CURRENT_TIMESTAMP()) AS EMPTY_FROM_TS,
          t.ETA_TS AS LAST_DROPOFF_TS,
          ST_MAKEPOINT(t.HOME_LON, t.HOME_LAT) AS NEXT_START_GEOM,
          t.HOME_LON AS NEXT_START_LON, t.HOME_LAT AS NEXT_START_LAT, t.HOME_DEPOT AS NEXT_START_LOCATION_TEXT,
          t.MAX_PAYLOAD_KG, t.HAZMAT_CERT, t.EV_RANGE_KM
        FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS t
        WHERE t.DROPOFF_LON IS NOT NULL AND t.DROPOFF_LAT IS NOT NULL`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_CANDIDATES
        COMMENT = ${TRACK}
        AS
        WITH p AS (
          SELECT
            MAX(IFF(PARAM_KEY='MAX_EMPTY_KM',            TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS MAX_EMPTY_KM,
            MAX(IFF(PARAM_KEY='PREFILTER_BUFFER_PCT',    TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS BUFFER_PCT,
            MAX(IFF(PARAM_KEY='PICKUP_DATE_SLACK_HRS',   TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS SLACK_HRS,
            MAX(IFF(PARAM_KEY='MAX_PICKUP_HORIZON_DAYS', TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS HORIZON_DAYS,
            MAX(IFF(PARAM_KEY='ENFORCE_PICKUP_DATE',     LOWER(PARAM_VALUE)='true', NULL))  AS ENFORCE_DATE,
            MAX(IFF(PARAM_KEY='ENFORCE_WEIGHT_FIT'  AND ENABLED, LOWER(PARAM_VALUE)='true', FALSE)) AS ENF_WEIGHT,
            MAX(IFF(PARAM_KEY='WEIGHT_FIT_MARGIN_KG',TRY_TO_DOUBLE(PARAM_VALUE), 0))                AS WEIGHT_MARGIN,
            MAX(IFF(PARAM_KEY='REQUIRE_HAZMAT_CERT' AND ENABLED, LOWER(PARAM_VALUE)='true', FALSE)) AS REQ_HAZMAT
          FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS
        )
        SELECT
          t.TRAILER_ID, l.LOAD_ID, l.IS_INTERNAL, l.SOURCE,
          t.EMPTY_GEOM, t.EMPTY_LAT, t.EMPTY_LON, t.EMPTY_CITY, t.OPERATING_COUNTRY,
          t.EMPTY_FROM_TS, t.MAX_PAYLOAD_KG, t.HAZMAT_CERT,
          t.NEXT_START_GEOM, t.NEXT_START_LAT, t.NEXT_START_LON, t.NEXT_START_LOCATION_TEXT,
          l.PICKUP_GEOM, l.PICKUP_LAT, l.PICKUP_LON, l.PICKUP_CITY,
          l.DELIVERY_GEOM, l.DELIVERY_LAT, l.DELIVERY_LON, l.DELIVERY_CITY,
          l.REQUESTED_PICKUP_TS, l.WEIGHT_KG, l.HAZMAT, l.PRICE_USD, l.PRODUCT, l.APPROX_DISTANCE_KM,
          ST_DISTANCE(t.EMPTY_GEOM, l.PICKUP_GEOM) / 1000.0 AS GREAT_CIRCLE_KM,
          DATEDIFF('minute', t.EMPTY_FROM_TS, l.REQUESTED_PICKUP_TS) / 60.0 AS PICKUP_SLACK_HRS
        FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS_GEO t
        JOIN p ON TRUE
        JOIN FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_LOADS l
          ON ST_DWITHIN(t.EMPTY_GEOM, l.PICKUP_GEOM, p.MAX_EMPTY_KM * (1 + p.BUFFER_PCT/100.0) * 1000)
         AND (NOT p.ENFORCE_DATE OR t.EMPTY_FROM_TS <= DATEADD('hour', p.SLACK_HRS, l.REQUESTED_PICKUP_TS))
         AND l.REQUESTED_PICKUP_TS <= DATEADD('day', p.HORIZON_DAYS, t.EMPTY_FROM_TS)
         AND (NOT p.ENF_WEIGHT  OR COALESCE(t.MAX_PAYLOAD_KG, 1e12) >= COALESCE(l.WEIGHT_KG, 0) + p.WEIGHT_MARGIN)
         AND (NOT p.REQ_HAZMAT  OR NOT COALESCE(l.HAZMAT, FALSE) OR COALESCE(t.HAZMAT_CERT, FALSE))`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_CANDIDATES_SCORED
        COMMENT = ${TRACK}
        AS
        WITH p AS (
          SELECT
            MAX(IFF(PARAM_KEY='MAX_EMPTY_KM',            TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS MAX_EMPTY_KM,
            MAX(IFF(PARAM_KEY='PICKUP_DATE_SLACK_HRS',   TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS SLACK_HRS,
            MAX(IFF(PARAM_KEY='MAX_PICKUP_HORIZON_DAYS', TRY_TO_DOUBLE(PARAM_VALUE), NULL)) AS HORIZON_DAYS,
            MAX(IFF(PARAM_KEY='ENFORCE_PICKUP_DATE',     LOWER(PARAM_VALUE)='true', NULL))  AS ENFORCE_DATE,
            MAX(IFF(PARAM_KEY='ENFORCE_WEIGHT_FIT'  AND ENABLED, LOWER(PARAM_VALUE)='true', FALSE)) AS ENF_WEIGHT,
            MAX(IFF(PARAM_KEY='WEIGHT_FIT_MARGIN_KG',TRY_TO_DOUBLE(PARAM_VALUE), 0))                AS WEIGHT_MARGIN,
            MAX(IFF(PARAM_KEY='REQUIRE_HAZMAT_CERT' AND ENABLED, LOWER(PARAM_VALUE)='true', FALSE)) AS REQ_HAZMAT
          FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS
        )
        SELECT
          t.TRAILER_ID, l.LOAD_ID, l.IS_INTERNAL, l.SOURCE,
          t.EMPTY_CITY, t.OPERATING_COUNTRY, t.MAX_PAYLOAD_KG, t.HAZMAT_CERT,
          l.PICKUP_CITY, l.DELIVERY_CITY, l.PICKUP_LAT, l.PICKUP_LON, l.DELIVERY_LAT, l.DELIVERY_LON,
          l.REQUESTED_PICKUP_TS, t.EMPTY_FROM_TS, l.WEIGHT_KG, l.HAZMAT,
          ST_DISTANCE(t.EMPTY_GEOM, l.PICKUP_GEOM) / 1000.0 AS GREAT_CIRCLE_KM,
          DATEDIFF('minute', t.EMPTY_FROM_TS, l.REQUESTED_PICKUP_TS) / 60.0 AS PICKUP_SLACK_HRS,
          (ST_DISTANCE(t.EMPTY_GEOM, l.PICKUP_GEOM) / 1000.0) <= p.MAX_EMPTY_KM AS DIST_CHECK,
          (NOT p.ENFORCE_DATE OR t.EMPTY_FROM_TS <= DATEADD('hour', p.SLACK_HRS, l.REQUESTED_PICKUP_TS)) AS TIME_CHECK,
          (l.REQUESTED_PICKUP_TS <= DATEADD('day', p.HORIZON_DAYS, t.EMPTY_FROM_TS)) AS HORIZON_CHECK,
          (NOT p.ENF_WEIGHT OR COALESCE(t.MAX_PAYLOAD_KG, 1e12) >= COALESCE(l.WEIGHT_KG, 0) + p.WEIGHT_MARGIN) AS CAP_CHECK,
          (NOT p.REQ_HAZMAT OR NOT COALESCE(l.HAZMAT, FALSE) OR COALESCE(t.HAZMAT_CERT, FALSE)) AS HAZMAT_CHECK,
          ( ((ST_DISTANCE(t.EMPTY_GEOM, l.PICKUP_GEOM) / 1000.0) <= p.MAX_EMPTY_KM)
            AND (NOT p.ENFORCE_DATE OR t.EMPTY_FROM_TS <= DATEADD('hour', p.SLACK_HRS, l.REQUESTED_PICKUP_TS))
            AND (l.REQUESTED_PICKUP_TS <= DATEADD('day', p.HORIZON_DAYS, t.EMPTY_FROM_TS))
            AND (NOT p.ENF_WEIGHT OR COALESCE(t.MAX_PAYLOAD_KG, 1e12) >= COALESCE(l.WEIGHT_KG, 0) + p.WEIGHT_MARGIN)
            AND (NOT p.REQ_HAZMAT OR NOT COALESCE(l.HAZMAT, FALSE) OR COALESCE(t.HAZMAT_CERT, FALSE))
          ) AS ELIGIBLE
        FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS_GEO t
        JOIN p ON TRUE
        JOIN FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_LOADS l
          ON ST_DWITHIN(t.EMPTY_GEOM, l.PICKUP_GEOM, p.MAX_EMPTY_KM * 3 * 1000)`,
      db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING',
    },
    // Asset Velocity views (ROUTE_OPTIMIZATION) are NOT created here. They are
    // owned by ensureAssetVelocityViews(), invoked after this loop (and lazily
    // by POST /api/asset-velocity/ensure), because they reference
    // DWELL_ANALYSIS.DT_DWELL_ENRICHED which Snowflake validates at CREATE VIEW
    // time and may not exist yet on a fresh boot.
    // ---------------------------------------------------------------
    // Freight Exchange (Phase A/B): MARKETPLACE schema + projection views
    // over SYNTHETIC_DATASETS.UNIFIED.{FACT_OFFERS, DIM_PARTNERS,
    // FACT_PARTNER_HISTORY} filtered by MARKETPLACE.CONFIG. Also creates a
    // RATE_INDEX dynamic table at 15-minute lag and a denormalized
    // VW_OFFER_ENRICHED that the React page reads.
    // ---------------------------------------------------------------
    {
      sql: `CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE COMMENT = ${TRACK_FX}`,
      db: 'FLEET_INTELLIGENCE',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.CONFIG (
        VEHICLE_TYPE VARCHAR NOT NULL,
        REGION       VARCHAR NOT NULL
      ) COMMENT = ${TRACK_FX}`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      // Derive the active preset from the most-populated (VEHICLE_TYPE, REGION)
      // in FACT_TRIPS UNION DIM_FLEET rather than hardcoding 'hgv'. The
      // self-healing WHEN MATCHED arm re-points a stale row whenever the current
      // preset has no freight offers, so a fresh ebike-preset install shows data
      // without a manual UPDATE (friction-log F4).
      sql: `MERGE INTO FLEET_INTELLIGENCE.MARKETPLACE.CONFIG tgt
            USING (
              WITH counts AS (
                SELECT t.VEHICLE_TYPE, t.REGION, COUNT(*) AS n
                FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
                WHERE t.VEHICLE_TYPE IS NOT NULL AND t.REGION IS NOT NULL
                GROUP BY 1, 2
                UNION ALL
                SELECT f.VEHICLE_TYPE, f.REGION, COUNT(*) AS n
                FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
                WHERE f.VEHICLE_TYPE IS NOT NULL AND f.REGION IS NOT NULL
                GROUP BY 1, 2
              ),
              ranked AS (
                SELECT VEHICLE_TYPE, REGION, SUM(n) AS total_rows
                FROM counts GROUP BY 1, 2
                QUALIFY ROW_NUMBER() OVER (ORDER BY SUM(n) DESC) = 1
              )
              SELECT VEHICLE_TYPE, REGION FROM ranked
            ) src
            ON TRUE
            WHEN MATCHED AND NOT EXISTS (
              SELECT 1 FROM SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS o
              WHERE o.VEHICLE_TYPE = tgt.VEHICLE_TYPE AND o.REGION = tgt.REGION
            )
              THEN UPDATE SET tgt.VEHICLE_TYPE = src.VEHICLE_TYPE, tgt.REGION = src.REGION
            WHEN NOT MATCHED THEN INSERT (VEHICLE_TYPE, REGION) VALUES (src.VEHICLE_TYPE, src.REGION)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    // Idempotent ALTERs in case the page is deployed against an older
    // FACT_OFFERS that pre-dates the enrichment columns.
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS VEHICLE_EQUIPMENT VARCHAR(30)`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS DISTANCE_KM FLOAT`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS PRICE_PER_KM_USD FLOAT`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS PARTNER_ID VARCHAR`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS ADD COLUMN IF NOT EXISTS STATUS VARCHAR(20)`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS (
        PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
        NAME VARCHAR, COUNTRY VARCHAR(4),
        CREDIT_SCORE NUMBER, PAYMENT_DAYS_AVG NUMBER, KYC_STATUS VARCHAR(20),
        BLACKLIST_FLAG BOOLEAN, FOUNDED_YEAR NUMBER,
        JOB_ID VARCHAR
      ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY (
        PARTNER_ID VARCHAR, REGION VARCHAR(100), VEHICLE_TYPE VARCHAR(20),
        ORIGIN_COUNTRY VARCHAR(4), DEST_COUNTRY VARCHAR(4),
        VEHICLE_EQUIPMENT VARCHAR(30),
        SHIPPED_AT TIMESTAMP_NTZ, COST_PER_KM FLOAT,
        OUTCOME VARCHAR(20),
        JOB_ID VARCHAR
      ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    // Deliveries rename migration for EXISTING installs: CREATE TABLE IF NOT
    // EXISTS never renames columns, so a FACT_PARTNER_HISTORY that predates the
    // freight->deliveries rename keeps EQUIPMENT / EUR_PER_KM. Rename them in
    // place (guarded: no-op on fresh installs where the new columns already
    // exist, or when the old column is absent). Must run BEFORE the partner /
    // lane views below, which reference VEHICLE_EQUIPMENT / COST_PER_KM.
    {
      sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY RENAME COLUMN EQUIPMENT TO VEHICLE_EQUIPMENT;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `EXECUTE IMMEDIATE $$
BEGIN
  ALTER TABLE SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY RENAME COLUMN EUR_PER_KM TO COST_PER_KM;
  RETURN 'ok';
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES (
        JOB_ID       VARCHAR    NOT NULL,
        OFFER_ID     VARCHAR    NOT NULL,
        ROAD_KM      FLOAT,
        ROAD_MIN     FLOAT,
        GEOMETRY     VARCHAR,
        PROFILE      VARCHAR(20),
        COMPUTED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
        CONSTRAINT PK_FACT_OFFER_ROUTES PRIMARY KEY (JOB_ID, OFFER_ID)
      ) COMMENT = ${TRACK_FX}`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `ALTER TABLE FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.FACT_DEADHEAD_MATRIX (
        TRAILER_ID   VARCHAR NOT NULL,
        OFFER_ID     VARCHAR NOT NULL,
        ROAD_KM      FLOAT,
        ROAD_MIN     FLOAT,
        COMPUTED_AT  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
        CONSTRAINT PK_FACT_DEADHEAD_MATRIX PRIMARY KEY (TRAILER_ID, OFFER_ID)
      ) COMMENT = ${TRACK_FX}`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.MARKETPLACE.DELIVERY_DRAFTS (
        DRAFT_ID         VARCHAR DEFAULT UUID_STRING() NOT NULL,
        OFFER_ID         VARCHAR NOT NULL,
        DISPATCHER_ID    VARCHAR,
        DRAFT_TEXT       VARCHAR,
        SUGGESTED_USD    FLOAT,
        PROMPT_CONTEXT   VARIANT,
        MODEL            VARCHAR(60),
        CREATED_AT       TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
        ACCEPTED         BOOLEAN DEFAULT FALSE,
        CONSTRAINT PK_DELIVERY_DRAFTS PRIMARY KEY (DRAFT_ID)
      ) COMMENT = ${TRACK_FX}`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    // -----------------------------------------------------------------
    // Dataset-versioning projection views ("CURRENT" = active dataset only)
    // -----------------------------------------------------------------
    // These views filter each base table to rows whose JOB_ID matches the
    // currently-active dataset for their (REGION, VEHICLE_TYPE) per
    // FLEET_INTELLIGENCE.CORE.DIM_DATASETS. Downstream consumers should
    // ALWAYS read from V_*_CURRENT (not the base table) so old datasets
    // remain queryable by JOB_ID without polluting the active view.
    //
    // DIM_POIS has no VEHICLE_TYPE column - a POI dataset is identified
    // purely by (REGION, JOB_ID). Joining on JOB_ID = DATASET_ID with
    // IS_ACTIVE = TRUE returns POIs from any active dataset whose JOB_ID
    // matches, which is exactly what we want when multiple vehicle types
    // are active in the same region.
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT f.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = f.JOB_ID
         AND d.REGION = f.REGION
         AND d.VEHICLE_TYPE = f.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT p.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = p.JOB_ID
         AND d.REGION = p.REGION
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_OFFERS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT f.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS f
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = f.JOB_ID
         AND d.REGION = f.REGION
         AND d.VEHICLE_TYPE = f.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTNERS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT p.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS p
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = p.JOB_ID
         AND d.REGION = p.REGION
         AND d.VEHICLE_TYPE = p.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_PARTNER_HISTORY_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT h.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY h
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = h.JOB_ID
         AND d.REGION = h.REGION
         AND d.VEHICLE_TYPE = h.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT t.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = t.JOB_ID
         AND d.REGION = t.REGION
         AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_TRIP_SCHEDULE_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT s.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE s
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = s.JOB_ID
         AND d.REGION = s.REGION
         AND d.VEHICLE_TYPE = s.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT t.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = t.JOB_ID
         AND d.REGION = t.REGION
         AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    // Universal-generation entity views. These four tables are region-keyed
    // (no VEHICLE_TYPE), so the CURRENT view joins on JOB_ID + REGION +
    // IS_ACTIVE, exactly like V_DIM_POIS_CURRENT above.
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_ANCHORS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT a.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_ANCHORS a
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = a.JOB_ID
         AND d.REGION = a.REGION
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTICIPANTS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT p.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTICIPANTS p
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = p.JOB_ID
         AND d.REGION = p.REGION
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_FACT_HAZARD_ZONES_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT h.*
        FROM SYNTHETIC_DATASETS.UNIFIED.FACT_HAZARD_ZONES h
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = h.JOB_ID
         AND d.REGION = h.REGION
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_AREA_DEMOGRAPHICS_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT g.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_AREA_DEMOGRAPHICS g
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = g.JOB_ID
         AND d.REGION = g.REGION
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_DEMAND_CATALOG_CURRENT
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        SELECT c.*
        FROM SYNTHETIC_DATASETS.UNIFIED.DIM_DEMAND_CATALOG c
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = c.JOB_ID
         AND d.REGION = c.REGION
         AND d.IS_ACTIVE = TRUE`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    // -----------------------------------------------------------------
    // Per-session scope-arg data contract.
    // Multi-tenant-safe READ layer: resolve an EXPLICIT (region, dataset_id)
    // instead of the GLOBAL DIM_DATASETS.IS_ACTIVE flag, so concurrent users
    // can view different scopes without clobbering each other. ADDITIVE - the
    // V_*_CURRENT views above are unchanged (global default + surfacing probe).
    //   F_<TABLE>_SCOPED(P_REGION, P_DATASET_ID):
    //     dataset_id given -> exactly that immutable dataset (per-session);
    //     dataset_id NULL  -> region's ACTIVE dataset (back-compat).
    // Mirror source of truth: fleet_sa_app/app/scoped_contract.sql (keep in sync).
    {
      sql: `CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_FACT_TRIPS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
        RETURNS TABLE (
          TRIP_ID VARCHAR, VEHICLE_ID VARCHAR, DRIVER_ID VARCHAR, VEHICLE_TYPE VARCHAR, REGION VARCHAR,
          ORIGIN_POI_ID VARCHAR, DESTINATION_POI_ID VARCHAR, ORIGIN_LAT FLOAT, ORIGIN_LON FLOAT, ORIGIN GEOGRAPHY,
          DESTINATION_LAT FLOAT, DESTINATION_LON FLOAT, DESTINATION GEOGRAPHY, ROUTE_GEOG GEOGRAPHY,
          DISTANCE_KM FLOAT, DURATION_MINUTES FLOAT, PLANNED_ROUTE_GEOG GEOGRAPHY, PLANNED_DISTANCE_KM FLOAT,
          IS_DETOUR BOOLEAN, DETOUR_DISTANCE_KM FLOAT, TRIP_START TIMESTAMP_NTZ, TRIP_END TIMESTAMP_NTZ,
          STATUS VARCHAR, ORS_PROFILE VARCHAR, TRIP_KIND VARCHAR, JOB_ID VARCHAR
        )
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        $$
          SELECT t.TRIP_ID, t.VEHICLE_ID, t.DRIVER_ID, t.VEHICLE_TYPE, t.REGION,
                 t.ORIGIN_POI_ID, t.DESTINATION_POI_ID, t.ORIGIN_LAT, t.ORIGIN_LON, t.ORIGIN,
                 t.DESTINATION_LAT, t.DESTINATION_LON, t.DESTINATION, t.ROUTE_GEOG,
                 t.DISTANCE_KM, t.DURATION_MINUTES, t.PLANNED_ROUTE_GEOG, t.PLANNED_DISTANCE_KM,
                 t.IS_DETOUR, t.DETOUR_DISTANCE_KM, t.TRIP_START, t.TRIP_END,
                 t.STATUS, t.ORS_PROFILE, COALESCE(t.TRIP_KIND, 'LADEN') AS TRIP_KIND, t.JOB_ID
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS t
          JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
            ON d.DATASET_ID = t.JOB_ID AND d.REGION = t.REGION AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
          WHERE (P_REGION IS NULL OR t.REGION = P_REGION)
            AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
                  OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
        $$`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_FACT_VEHICLE_TELEMETRY_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
        RETURNS TABLE (
          TELEMETRY_ID VARCHAR, REGION VARCHAR, VEHICLE_TYPE VARCHAR, VEHICLE_ID VARCHAR, TRIP_ID VARCHAR,
          TS TIMESTAMP_NTZ, LATITUDE FLOAT, LONGITUDE FLOAT, POINT_GEOM GEOGRAPHY, SPEED_KMH FLOAT,
          HEADING_DEG FLOAT, POSTED_SPEED_KMH FLOAT, STATUS VARCHAR, IS_SPEEDING BOOLEAN, IS_HOS_VIOLATION BOOLEAN,
          IS_DETOUR BOOLEAN, GPS_ACCURACY_M FLOAT, LOCATION_ID VARCHAR, LOCATION_TYPE VARCHAR, ORS_PROFILE VARCHAR,
          BATTERY_PCT FLOAT, ODOMETER_KM FLOAT, POINT_INDEX NUMBER, JOB_ID VARCHAR
        )
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        $$
          SELECT t.TELEMETRY_ID, t.REGION, t.VEHICLE_TYPE, t.VEHICLE_ID, t.TRIP_ID,
                 t.TS, t.LATITUDE, t.LONGITUDE, t.POINT_GEOM, t.SPEED_KMH,
                 t.HEADING_DEG, t.POSTED_SPEED_KMH, t.STATUS, t.IS_SPEEDING, t.IS_HOS_VIOLATION,
                 t.IS_DETOUR, t.GPS_ACCURACY_M, t.LOCATION_ID, t.LOCATION_TYPE, t.ORS_PROFILE,
                 t.BATTERY_PCT, t.ODOMETER_KM, t.POINT_INDEX, t.JOB_ID
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY t
          JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
            ON d.DATASET_ID = t.JOB_ID AND d.REGION = t.REGION AND d.VEHICLE_TYPE = t.VEHICLE_TYPE
          WHERE (P_REGION IS NULL OR t.REGION = P_REGION)
            AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
                  OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
        $$`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_DIM_POIS_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
        RETURNS TABLE (
          LOCATION_ID VARCHAR, REGION VARCHAR, NAME VARCHAR, LOCATION_TYPE VARCHAR, CATEGORY VARCHAR,
          LAT FLOAT, LNG FLOAT, POINT_GEOM GEOGRAPHY, SOURCE VARCHAR, JOB_ID VARCHAR
        )
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        $$
          SELECT p.LOCATION_ID, p.REGION, p.NAME, p.LOCATION_TYPE, p.CATEGORY,
                 p.LAT, p.LNG, p.POINT_GEOM, p.SOURCE, p.JOB_ID
          FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS p
          JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
            ON d.DATASET_ID = p.JOB_ID AND d.REGION = p.REGION
          WHERE (P_REGION IS NULL OR p.REGION = P_REGION)
            AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
                  OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
        $$`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    {
      sql: `CREATE OR REPLACE FUNCTION SYNTHETIC_DATASETS.UNIFIED.F_DIM_FLEET_SCOPED(P_REGION VARCHAR, P_DATASET_ID VARCHAR)
        RETURNS TABLE (
          VEHICLE_ID VARCHAR, REGION VARCHAR, VEHICLE_TYPE VARCHAR, ORS_PROFILE VARCHAR, SHIFT_TYPE VARCHAR,
          SHIFT_START_HOUR NUMBER, SHIFT_END_HOUR NUMBER, HOME_LOCATION_ID VARCHAR, DRIVER_PROFILE VARCHAR,
          OPERATING_MODE VARCHAR, BASE_SPEED_KMH FLOAT, BATTERY_RANGE_KM FLOAT, JOB_ID VARCHAR,
          WEIGHT_TONS NUMBER, HEIGHT_M NUMBER, LENGTH_M NUMBER, WIDTH_M NUMBER, AXLELOAD_T NUMBER,
          HAZMAT BOOLEAN, VEHICLE_SUBTYPE VARCHAR
        )
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        $$
          SELECT f.VEHICLE_ID, f.REGION, f.VEHICLE_TYPE, f.ORS_PROFILE, f.SHIFT_TYPE,
                 f.SHIFT_START_HOUR, f.SHIFT_END_HOUR, f.HOME_LOCATION_ID, f.DRIVER_PROFILE,
                 f.OPERATING_MODE, f.BASE_SPEED_KMH, f.BATTERY_RANGE_KM, f.JOB_ID,
                 f.WEIGHT_TONS, f.HEIGHT_M, f.LENGTH_M, f.WIDTH_M, f.AXLELOAD_T,
                 f.HAZMAT, f.VEHICLE_SUBTYPE
          FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET f
          JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
            ON d.DATASET_ID = f.JOB_ID AND d.REGION = f.REGION AND d.VEHICLE_TYPE = f.VEHICLE_TYPE
          WHERE (P_REGION IS NULL OR f.REGION = P_REGION)
            AND ( (P_DATASET_ID IS NOT NULL AND d.DATASET_ID = P_DATASET_ID)
                  OR (P_DATASET_ID IS NULL AND d.IS_ACTIVE = TRUE) )
        $$`,
      db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED',
    },
    // OPS "activate dataset" primitive (R4): promote a dataset to the GLOBAL
    // active scope while preserving one-active-per-(region,vehicle). Called by the
    // OPS-gated consumer route /api/ops/activate-dataset. Mirror source:
    // fleet_sa_app/app/ops_primitives.sql.
    {
      sql: `CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.CORE.ACTIVATE_DATASET(P_DATASET_ID VARCHAR)
        RETURNS VARCHAR
        LANGUAGE SQL
        COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-app-restructure","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'
        AS
        $$
        DECLARE
          v_region   VARCHAR;
          v_vehicle  VARCHAR;
        BEGIN
          SELECT REGION, VEHICLE_TYPE INTO :v_region, :v_vehicle
            FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
           WHERE DATASET_ID = :P_DATASET_ID;
          IF (:v_region IS NULL) THEN
            RETURN 'ERROR: dataset not found: ' || :P_DATASET_ID;
          END IF;
          UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
             SET IS_ACTIVE = FALSE
           WHERE REGION = :v_region AND VEHICLE_TYPE = :v_vehicle AND IS_ACTIVE = TRUE;
          UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
             SET IS_ACTIVE = TRUE
           WHERE DATASET_ID = :P_DATASET_ID;
          RETURN 'OK: activated ' || :P_DATASET_ID || ' for ' || :v_region || '/' || :v_vehicle;
        END;
        $$`,
      db: 'FLEET_INTELLIGENCE', schema: 'CORE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.V_PLACES_CURRENT
        COMMENT = ${TRACK_RO}
        AS
        WITH cfg AS (
          SELECT REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG LIMIT 1
        )
        SELECT p.*
        FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES p
        JOIN cfg ON p.REGION = cfg.REGION
        JOIN FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
          ON d.DATASET_ID = p.JOB_ID
         AND d.REGION = cfg.REGION
         AND d.VEHICLE_TYPE = cfg.VEHICLE_TYPE
         AND d.IS_ACTIVE = TRUE`,
      db: 'FLEET_INTELLIGENCE', schema: 'ROUTE_OPTIMIZATION',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.V_FACT_OFFER_ROUTES_CURRENT
        COMMENT = ${TRACK_FX}
        AS
        SELECT fr.*
        FROM FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES fr
        JOIN SYNTHETIC_DATASETS.UNIFIED.V_FACT_OFFERS_CURRENT o
          ON o.OFFER_ID = fr.OFFER_ID AND o.JOB_ID = fr.JOB_ID`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS
        COMMENT = ${TRACK_FX}
        AS
        SELECT
          f.OFFER_ID,
          f.JOB_ID,
          f.SOURCE,
          f.PARTNER_ID,
          COALESCE(p.NAME, 'Pickup')              AS PICKUP_CITY,
          f.PICKUP_LON, f.PICKUP_LAT, f.PICKUP_GEOM,
          COALESCE(d.NAME, 'Dropoff')             AS DROPOFF_CITY,
          f.DROPOFF_LON, f.DROPOFF_LAT, f.DROPOFF_GEOM,
          f.PICKUP_FROM_TS, f.PICKUP_TO_TS,
          f.WEIGHT_KG, f.PRODUCT, f.PRICE_USD, f.HAZMAT,
          f.LISTING_TEXT, f.POSTED_AT,
          f.VEHICLE_EQUIPMENT,
          f.DISTANCE_KM, f.PRICE_PER_KM_USD,
          COALESCE(f.STATUS, 'OPEN')              AS STATUS,
          DATEDIFF('minute', f.POSTED_AT, CURRENT_TIMESTAMP()) AS POSTED_AGE_MIN
        FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_OFFERS_CURRENT f
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT p ON p.LOCATION_ID = f.PICKUP_POI_ID
        LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT d ON d.LOCATION_ID = f.DROPOFF_POI_ID
        WHERE f.REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)
          AND f.VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNERS
        COMMENT = ${TRACK_FX}
        AS
        SELECT PARTNER_ID, NAME, COUNTRY,
               CREDIT_SCORE, PAYMENT_DAYS_AVG, KYC_STATUS,
               BLACKLIST_FLAG, FOUNDED_YEAR,
               CASE
                 WHEN BLACKLIST_FLAG THEN 'RED'
                 WHEN CREDIT_SCORE < 40 OR KYC_STATUS = 'REJECTED' THEN 'RED'
                 WHEN CREDIT_SCORE < 70 OR KYC_STATUS = 'PENDING' THEN 'YELLOW'
                 ELSE 'GREEN'
               END AS TRUST_BADGE
        FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTNERS_CURRENT
        WHERE REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)
          AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY
        COMMENT = ${TRACK_FX}
        AS
        SELECT PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY,
               VEHICLE_EQUIPMENT, SHIPPED_AT, COST_PER_KM, OUTCOME
        FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_PARTNER_HISTORY_CURRENT
        WHERE REGION = (SELECT REGION FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)
          AND VEHICLE_TYPE = (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG LIMIT 1)`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY
        COMMENT = ${TRACK_FX}
        AS
        SELECT
          PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY, VEHICLE_EQUIPMENT,
          COUNT(*)                                                AS SHIPMENTS,
          SUM(CASE WHEN OUTCOME = 'DELIVERED' THEN 1 ELSE 0 END)  AS ON_TIME,
          SUM(CASE WHEN OUTCOME = 'LATE' THEN 1 ELSE 0 END)       AS LATE_CNT,
          SUM(CASE WHEN OUTCOME = 'DAMAGED' THEN 1 ELSE 0 END)    AS DAMAGED_CNT,
          ROUND(AVG(COST_PER_KM), 2)                              AS AVG_COST_PER_KM
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY
        GROUP BY 1,2,3,4`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_DENSITY
        COMMENT = ${TRACK_FX}
        AS
        WITH lane_midpoints AS (
          SELECT
            h.PARTNER_ID,
            h.VEHICLE_EQUIPMENT,
            h.SHIPPED_AT,
            o.PICKUP_LON, o.PICKUP_LAT,
            o.DROPOFF_LON, o.DROPOFF_LAT
          FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNER_HISTORY h
          LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS o
            ON o.PARTNER_ID = h.PARTNER_ID
        )
        SELECT
          H3_POINT_TO_CELL_STRING(
            ST_MAKEPOINT((PICKUP_LON + DROPOFF_LON) / 2, (PICKUP_LAT + DROPOFF_LAT) / 2),
            5
          ) AS H3_CELL,
          VEHICLE_EQUIPMENT,
          COUNT(*) AS SHIPMENT_COUNT
        FROM lane_midpoints
        WHERE PICKUP_LON IS NOT NULL AND DROPOFF_LON IS NOT NULL
        GROUP BY 1, 2`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE DYNAMIC TABLE FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX
        TARGET_LAG = '1 hour'
        WAREHOUSE = ROUTING_ANALYTICS
        COMMENT = ${TRACK_FX}
        AS
        WITH base AS (
          SELECT
            VEHICLE_EQUIPMENT,
            DATE_TRUNC('week', POSTED_AT)        AS WEEK,
            PRICE_PER_KM_USD
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_OFFERS
          WHERE PRICE_PER_KM_USD IS NOT NULL
            AND VEHICLE_EQUIPMENT IS NOT NULL
        )
        SELECT
          VEHICLE_EQUIPMENT, WEEK,
          COUNT(*)                                              AS SAMPLES,
          ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.25), 2)   AS P25_USD_PER_KM,
          ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.50), 2)   AS P50_USD_PER_KM,
          ROUND(APPROX_PERCENTILE(PRICE_PER_KM_USD, 0.75), 2)   AS P75_USD_PER_KM
        FROM base
        GROUP BY 1, 2`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED
        COMMENT = ${TRACK_FX}
        AS
        WITH e AS (
          SELECT
            o.*,
            p.NAME             AS PARTNER_NAME,
            p.COUNTRY          AS PARTNER_COUNTRY,
            p.CREDIT_SCORE     AS PARTNER_CREDIT_SCORE,
            p.PAYMENT_DAYS_AVG AS PARTNER_PAYMENT_DAYS,
            p.KYC_STATUS       AS PARTNER_KYC,
            p.BLACKLIST_FLAG   AS PARTNER_BLACKLIST,
            p.TRUST_BADGE      AS TRUST_BADGE,
            ri.P25_USD_PER_KM  AS MARKET_P25,
            ri.P50_USD_PER_KM  AS MARKET_P50,
            ri.P75_USD_PER_KM  AS MARKET_P75,
            CASE
              WHEN ri.P50_USD_PER_KM IS NULL OR o.PRICE_PER_KM_USD IS NULL THEN NULL
              ELSE ROUND((o.PRICE_PER_KM_USD - ri.P50_USD_PER_KM) / ri.P50_USD_PER_KM * 100, 1)
            END AS PRICE_DELTA_PCT,
            CASE
              WHEN ri.P50_USD_PER_KM IS NULL OR o.PRICE_PER_KM_USD IS NULL THEN 'UNKNOWN'
              WHEN ABS((o.PRICE_PER_KM_USD - ri.P50_USD_PER_KM) / ri.P50_USD_PER_KM) <= 0.05 THEN 'AT_MARKET'
              WHEN o.PRICE_PER_KM_USD < ri.P50_USD_PER_KM THEN 'BELOW_MARKET'
              ELSE 'ABOVE_MARKET'
            END AS MARKET_BADGE
          FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFERS o
          LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.VW_PARTNERS p ON p.PARTNER_ID = o.PARTNER_ID
          LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.RATE_INDEX ri
            ON ri.VEHICLE_EQUIPMENT = o.VEHICLE_EQUIPMENT
           AND ri.WEEK = DATE_TRUNC('week', o.POSTED_AT)
        )
        SELECT
          e.*,
          fr.ROAD_KM,
          fr.ROAD_MIN,
          fr.GEOMETRY     AS ROUTE_GEOMETRY,
          fr.PROFILE      AS ROUTE_PROFILE,
          fr.COMPUTED_AT  AS ROUTE_COMPUTED_AT,
          CASE WHEN fr.ROAD_KM IS NOT NULL AND e.PRICE_USD IS NOT NULL AND fr.ROAD_KM > 0
               THEN e.PRICE_USD / fr.ROAD_KM
               ELSE e.PRICE_PER_KM_USD
          END AS PRICE_PER_ROAD_KM_USD,
          CASE WHEN fr.ROAD_KM IS NULL THEN 'PENDING_ROUTE'
               WHEN fr.ROAD_KM > e.DISTANCE_KM * 1.6 THEN 'DETOUR_HEAVY'
               WHEN fr.ROAD_KM > e.DISTANCE_KM * 1.3 THEN 'DETOUR_MODERATE'
               ELSE 'DIRECT'
          END AS ROUTE_DETOUR_BADGE
        FROM e
        LEFT JOIN FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES fr
          ON fr.OFFER_ID = e.OFFER_ID AND fr.JOB_ID = e.JOB_ID`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_DEADHEAD
        COMMENT = ${TRACK_FX}
        AS
        WITH ranked AS (
          SELECT
            dm.OFFER_ID,
            dm.TRAILER_ID,
            dm.ROAD_KM   AS DEADHEAD_KM,
            dm.ROAD_MIN  AS DEADHEAD_MIN,
            dm.COMPUTED_AT,
            ROW_NUMBER() OVER (PARTITION BY dm.OFFER_ID ORDER BY dm.ROAD_KM ASC) AS BEST_RANK
          FROM FLEET_INTELLIGENCE.MARKETPLACE.FACT_DEADHEAD_MATRIX dm
        )
        SELECT
          o.OFFER_ID,
          o.PARTNER_ID,
          o.PICKUP_CITY,
          o.DROPOFF_CITY,
          o.PRICE_USD,
          r.TRAILER_ID         AS BEST_TRAILER_ID,
          r.DEADHEAD_KM        AS BEST_DEADHEAD_KM,
          r.DEADHEAD_MIN       AS BEST_DEADHEAD_MIN,
          r.COMPUTED_AT        AS BEST_COMPUTED_AT
        FROM FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED o
        LEFT JOIN ranked r
          ON r.OFFER_ID = o.OFFER_ID AND r.BEST_RANK = 1`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    {
      sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED_V2`,
      db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE',
    },
    // Cleanup orphaned old-name views from the FACT_DELIVERIES -> FACT_OFFERS rename.
    { sql: `DROP VIEW IF EXISTS SYNTHETIC_DATASETS.UNIFIED.V_FACT_DELIVERIES_CURRENT`, db: 'SYNTHETIC_DATASETS', schema: 'UNIFIED' },
    { sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_DELIVERIES`, db: 'FLEET_INTELLIGENCE', schema: 'BACKLOAD_MATCHING' },
    { sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_DELIVERIES`, db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE' },
    { sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_DELIVERY_ENRICHED`, db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE' },
    { sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.VW_DELIVERY_DEADHEAD`, db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE' },
    { sql: `DROP VIEW IF EXISTS FLEET_INTELLIGENCE.MARKETPLACE.V_FACT_DELIVERY_ROUTES_CURRENT`, db: 'FLEET_INTELLIGENCE', schema: 'MARKETPLACE' },
  ];
  for (const { sql, db, schema } of stmts) {
    try {
      await sqlFn(sql, db, schema);
    } catch (e: any) {
      // Log and continue - most failures are "schema doesn't exist" on first
      // boot before the engine build finished, which is fine; subsequent
      // boots will succeed.
      log('WARN', 'Init', `boot init step failed: ${e?.message?.slice(0, 200)}`);
    }
  }

  // Create the Asset Velocity views via the shared self-heal path (gated on
  // DT_DWELL_ENRICHED). On a fresh boot before dwell-analysis is deployed this
  // returns { ensured:false } and the page stays in its empty state until the
  // first visit re-triggers it via POST /api/asset-velocity/ensure.
  try {
    const av = await ensureAssetVelocityViews(sqlFn);
    log('INFO', 'Init', `asset-velocity ensure at boot: ${JSON.stringify(av)}`);
  } catch (e: any) {
    log('WARN', 'Init', `asset-velocity ensure at boot failed: ${e?.message?.slice(0, 200)}`);
  }

  // -----------------------------------------------------------------
  // Loud post-init verification (log-only, no throw -> never crash-loop).
  // The boot loop above logs WARN-and-continues on any failed statement, so a
  // partial init can leave the app "healthy" with broken pages. These probes
  // turn the two highest-impact silent failures into diagnosable ERROR lines:
  //   * Asset Velocity views missing (e.g. CREATE VIEW threw because
  //     DWELL_ANALYSIS.DT_DWELL_ENRICHED did not exist yet at boot).
  //   * MARKETPLACE.CONFIG empty -> VW_OFFER_ENRICHED filters to 0 rows.
  // -----------------------------------------------------------------
  try {
    await sqlFn(
      `SELECT 1 FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.VW_VEHICLE_COST_OF_IDLENESS LIMIT 1`,
      'FLEET_INTELLIGENCE',
      'ROUTE_OPTIMIZATION',
    );
  } catch (e: any) {
    log('ERROR', 'Init', `Asset Velocity views MISSING after boot init -> page will be empty: ${e?.message?.slice(0, 200)}`);
  }
  try {
    await sqlFn(
      `SELECT 1 FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_LOADS LIMIT 1`,
      'FLEET_INTELLIGENCE',
      'BACKLOAD_MATCHING',
    );
  } catch (e: any) {
    log('ERROR', 'Init', `Backload Proposals cockpit views MISSING after boot init -> Backload Proposals page will 422. Base VW_TRAILERS/VW_EXTERNAL_OFFERS likely absent (needs a generated dataset for the active region): ${e?.message?.slice(0, 200)}`);
  }
  try {
    const cfgRows = await sqlFn(
      `SELECT COUNT(*) AS N FROM FLEET_INTELLIGENCE.MARKETPLACE.CONFIG`,
      'FLEET_INTELLIGENCE',
      'MARKETPLACE',
    );
    const n = Number(cfgRows?.[0]?.N ?? cfgRows?.[0]?.n ?? 0);
    if (n === 0) {
      log('ERROR', 'Init', 'MARKETPLACE.CONFIG empty after boot init -> Deliveries VW_OFFER_ENRICHED returns 0 rows. Re-run datasets/load-seed-data.sql post-seed.');
    }
  } catch (e: any) {
    log('ERROR', 'Init', `MARKETPLACE.CONFIG probe failed after boot init: ${e?.message?.slice(0, 200)}`);
  }

  // -----------------------------------------------------------------
  // Defensive Observability bootstrap.
  //
  // The Observability page hits OPENROUTESERVICE_APP.OBSERVABILITY.V_ORS_METRICS_SUMMARY,
  // which is created by app/modules/08_observability.sql. If that module was
  // skipped (older deploy script, manual partial install, etc.) the page
  // returns SQL 422 "schema does not exist". Mirror the schema/table/view
  // here so the page always renders, even on accounts where module 08 was
  // never applied. The full ingest procedure + scheduled tasks remain owned
  // by module 08 - without them the table is empty and the page shows zero
  // rows (which is preferable to a SQL error). Operators who want live data
  // should still apply module 08 and `ALTER TASK ... RESUME` the ingest task.
  //
  // Mirrors the contents of:
  //   .cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/08_observability.sql
  // Edit both together. (Same convention used elsewhere in this file.)
  // -----------------------------------------------------------------
  await ensureObservabilityObjects(sqlFn);
}

export async function ensureObservabilityObjects(
  sqlFn: (sql: string, db?: string, schema?: string) => Promise<any[]>,
): Promise<void> {
  const TRACK_OBS = `'{"origin":"sf_sit-is-fleet","name":"oss-observability","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`;
  const stmts: { sql: string; db?: string; schema?: string }[] = [
    {
      sql: `CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_APP.OBSERVABILITY COMMENT = ${TRACK_OBS}`,
      db: 'OPENROUTESERVICE_APP',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG (
        REQUEST_TS       TIMESTAMP_LTZ NOT NULL,
        REQUEST_ID       VARCHAR,
        ENDPOINT         VARCHAR NOT NULL,
        PROFILE          VARCHAR,
        REGION           VARCHAR,
        ORS_HOST         VARCHAR,
        STATUS_CODE      NUMBER,
        ERROR_CODE       VARCHAR,
        LATENCY_MS       NUMBER,
        REQUEST_BYTES    NUMBER,
        RESPONSE_BYTES   NUMBER,
        CALLER           VARCHAR
      )
      CLUSTER BY (DATE_TRUNC('hour', REQUEST_TS))
      DATA_RETENTION_TIME_IN_DAYS = 1
      COMMENT = ${TRACK_OBS}`,
      db: 'OPENROUTESERVICE_APP', schema: 'OBSERVABILITY',
    },
    {
      sql: `CREATE OR REPLACE VIEW OPENROUTESERVICE_APP.OBSERVABILITY.V_ORS_METRICS_SUMMARY
        COMMENT = ${TRACK_OBS}
        AS
        WITH events AS (
          SELECT
            REQUEST_TS,
            ENDPOINT,
            PROFILE,
            REGION,
            STATUS_CODE,
            ERROR_CODE,
            LATENCY_MS,
            REQUEST_BYTES,
            RESPONSE_BYTES,
            IFF(STATUS_CODE >= 400 OR ERROR_CODE IS NOT NULL, 1, 0) AS IS_ERROR
          FROM OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG
        ),
        windowed AS (
          SELECT '1h'  AS WINDOW_NAME, e.* FROM events e WHERE e.REQUEST_TS >= DATEADD(hour, -1, SYSDATE())
          UNION ALL
          SELECT '24h' AS WINDOW_NAME, e.* FROM events e WHERE e.REQUEST_TS >= DATEADD(hour, -24, SYSDATE())
        )
        SELECT
          WINDOW_NAME,
          ENDPOINT,
          COUNT(*)                                     AS REQ_COUNT,
          SUM(IS_ERROR)                                AS ERROR_COUNT,
          ROUND(100.0 * SUM(IS_ERROR) / NULLIF(COUNT(*), 0), 2) AS ERROR_RATE_PCT,
          APPROX_PERCENTILE(LATENCY_MS, 0.5)           AS P50_MS,
          APPROX_PERCENTILE(LATENCY_MS, 0.95)          AS P95_MS,
          MAX(LATENCY_MS)                              AS MAX_MS,
          AVG(LATENCY_MS)                              AS AVG_MS,
          ROUND(AVG(REQUEST_BYTES), 0)                 AS AVG_REQ_BYTES,
          ROUND(AVG(RESPONSE_BYTES), 0)                AS AVG_RESP_BYTES,
          MAX(REQUEST_TS)                              AS LAST_EVENT_TS
        FROM windowed
        GROUP BY WINDOW_NAME, ENDPOINT
        ORDER BY WINDOW_NAME, ENDPOINT`,
      db: 'OPENROUTESERVICE_APP', schema: 'OBSERVABILITY',
    },
  ];
  for (const { sql, db, schema } of stmts) {
    try {
      await sqlFn(sql, db, schema);
    } catch (e: any) {
      log('WARN', 'Init', `observability bootstrap step failed: ${e?.message?.slice(0, 200)}`);
    }
  }
}
