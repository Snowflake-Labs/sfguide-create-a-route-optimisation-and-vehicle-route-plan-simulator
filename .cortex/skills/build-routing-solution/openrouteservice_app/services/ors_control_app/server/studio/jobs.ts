import { GenerationConfig, createRng, uuid, resolveVehicleType } from './profiles.js';
import { generateTelemetry, TelemetryPoint, TripRecord, GenerationEvent, GenerationProgress } from './engine.js';
import { log } from '../diagnostics.js';
import { normalizeRegion } from '../lib/region.js';
import { escVal, UNIFIED_DB, UNIFIED_SCHEMA } from './sql-helpers.js';
import { ScalingState, captureAndScaleUp, scaleDown, waitForOrsReady } from './scaling.js';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;
type SseCallback = (event: string, data: any) => void;

export interface BufferedEvent {
  event: string;
  data: any;
  ts: number;
}

const EVENT_BUFFER_CAP = 500;

export interface Job {
  jobId: string;
  presetName: string;
  region: string;
  orsProfile: string;
  vehicleType: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'STOPPED';
  pointsGenerated: number;
  tripsGenerated: number;
  startedAt: Date;
  completedAt: Date | null;
  error: string | null;
  abort: { aborted: boolean };
  listeners: Set<SseCallback>;
  events: BufferedEvent[];
}

const activeJobs = new Map<string, Job>();

export function getJobs(): Job[] {
  return [...activeJobs.values()].map(j => ({ ...j, abort: undefined as any, listeners: undefined as any, events: undefined as any }));
}

export function getJob(jobId: string): Job | undefined {
  return activeJobs.get(jobId);
}

export function getJobEvents(jobId: string): BufferedEvent[] | undefined {
  const job = activeJobs.get(jobId);
  return job?.events;
}

export type CancelMode = 'in-memory' | 'orphan' | 'not-running' | 'not-found' | 'error';
export interface CancelResult {
  ok: boolean;
  mode: CancelMode;
  message?: string;
}

export async function cancelJob(jobId: string, snowSql?: SnowSqlFn): Promise<CancelResult> {
  const job = activeJobs.get(jobId);

  if (job && job.status === 'RUNNING') {
    job.abort.aborted = true;
    job.status = 'CANCELLED';
    job.completedAt = new Date();
    broadcast(job, 'cancelled', { jobId });
    log('INFO', 'Studio', `Cancelled in-memory job ${jobId}`);
    if (snowSql) {
      try { await persistJobLog(job, snowSql); } catch (_) { /* best-effort */ }
    }
    return { ok: true, mode: 'in-memory' };
  }
  if (job && job.status !== 'RUNNING') {
    return { ok: false, mode: 'not-running', message: `Job is already ${job.status}` };
  }

  if (!snowSql) {
    return { ok: false, mode: 'not-found', message: 'No in-memory job and no DB connection available' };
  }

  try {
    const rows = await snowSql(
      `SELECT STATUS FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS WHERE JOB_ID = ${escVal(jobId)}`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    if (!rows.length) {
      return { ok: false, mode: 'not-found', message: 'Job not found in DB' };
    }
    const dbStatus = rows[0].STATUS;
    if (dbStatus !== 'RUNNING') {
      return { ok: false, mode: 'not-running', message: `Job is already ${dbStatus}` };
    }

    await snowSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
       SET STATUS='CANCELLED',
           COMPLETED_AT=SYSDATE(),
           ERROR_MESSAGE='Cancelled by user (orphaned worker - no in-process state)'
       WHERE JOB_ID=${escVal(jobId)}`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    log('INFO', 'Studio', `Force-cancelled orphaned job ${jobId}`);
    return { ok: true, mode: 'orphan' };
  } catch (e: any) {
    log('WARN', 'Studio', `Force-cancel failed for ${jobId}: ${e.message?.slice(0, 200)}`);
    return { ok: false, mode: 'error', message: e.message?.slice(0, 200) };
  }
}

export async function reconcileStaleJobs(snowSql: SnowSqlFn, staleMinutes: number = 30): Promise<number> {
  try {
    const inMemoryIds = [...activeJobs.keys()];
    const inMemFilter = inMemoryIds.length > 0
      ? `AND JOB_ID NOT IN (${inMemoryIds.map(escVal).join(',')})`
      : '';
    const result = await snowSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
       SET STATUS='FAILED',
           COMPLETED_AT=SYSDATE(),
           ERROR_MESSAGE='Worker crashed or container restarted (auto-reconciled at boot)'
       WHERE STATUS='RUNNING'
         AND STARTED_AT < DATEADD(minute, -${staleMinutes}, CURRENT_TIMESTAMP())
         ${inMemFilter}`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    const n = result?.[0]?.['number of rows updated'] ?? 0;
    if (n > 0) {
      log('INFO', 'Studio', `Reconciled ${n} stale RUNNING job(s) at boot`);
    }
    return n;
  } catch (e: any) {
    log('WARN', 'Studio', `reconcileStaleJobs failed: ${e.message?.slice(0, 200)}`);
    return 0;
  }
}

export async function deleteJobData(jobId: string, snowSql: SnowSqlFn): Promise<{ deleted: Record<string, number> }> {
  const tables = [
    'FACT_VEHICLE_TELEMETRY', 'FACT_TRIPS', 'DIM_FLEET', 'DIM_POIS', 'DIM_TRIP_SCHEDULE', 'FACT_FREIGHT_OFFERS',
  ];
  const deleted: Record<string, number> = {};
  for (const tbl of tables) {
    try {
      const rows = await snowSql(
        `DELETE FROM ${UNIFIED_DB}.${UNIFIED_SCHEMA}.${tbl} WHERE JOB_ID = ${escVal(jobId)}`,
        UNIFIED_DB, UNIFIED_SCHEMA
      );
      deleted[tbl] = rows?.[0]?.['number of rows deleted'] ?? 0;
    } catch (e: any) {
      log('WARN', 'Studio', `Delete from ${tbl} failed for job ${jobId}: ${e.message?.slice(0, 200)}`);
      deleted[tbl] = -1;
    }
  }
  try {
    await snowSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS SET STATUS='DELETED', COMPLETED_AT=SYSDATE() WHERE JOB_ID=${escVal(jobId)}`,
      'FLEET_INTELLIGENCE', 'CORE'
    );
  } catch (e: any) {
    log('WARN', 'Studio', `Failed to mark job ${jobId} as DELETED: ${e.message?.slice(0, 200)}`);
  }
  log('INFO', 'Studio', `Deleted data for job ${jobId}: ${JSON.stringify(deleted)}`);
  return { deleted };
}

function broadcast(job: Job, event: string, data: any) {
  job.events.push({ event, data, ts: Date.now() });
  if (job.events.length > EVENT_BUFFER_CAP) {
    job.events.splice(0, job.events.length - EVENT_BUFFER_CAP);
  }
  for (const cb of job.listeners) {
    try { cb(event, data); } catch (e: any) {
      log('WARN', 'Studio', `SSE broadcast failed: ${e.message?.slice(0, 100)}`);
    }
  }
}

async function persistJobLog(job: Job, snowSql: SnowSqlFn): Promise<void> {
  try {
    const payload = JSON.stringify({
      jobId: job.jobId,
      status: job.status,
      pointsGenerated: job.pointsGenerated,
      tripsGenerated: job.tripsGenerated,
      startedAt: job.startedAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
      error: job.error,
      events: job.events,
    }).replace(/\$\$/g, '$ $');
    await snowSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS
       SET LOG_TEXT = PARSE_JSON($$${payload}$$)
       WHERE JOB_ID = ${escVal(job.jobId)}`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
  } catch (e: any) {
    log('WARN', 'Studio', `persistJobLog failed for ${job.jobId}: ${e.message?.slice(0, 200)}`);
  }
}

export function subscribeJob(jobId: string, cb: SseCallback): () => void {
  const job = activeJobs.get(jobId);
  if (!job) return () => {};
  job.listeners.add(cb);
  return () => { job.listeners.delete(cb); };
}

// escVal, UNIFIED_DB, UNIFIED_SCHEMA moved to ./sql-helpers.ts

async function disableOrsAutoSuspend(snowSql: SnowSqlFn): Promise<void> {
  const stmts = [
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE SET AUTO_SUSPEND_SECS = 0',
    // v1.1.0: bare ORS_SERVICE has been removed; the per-region default is
    // ORS_SERVICE_SANFRANCISCO. Both lines here are best-effort and survive a
    // mid-migration window where either name might still be present.
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 0',
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_SANFRANCISCO SET AUTO_SUSPEND_SECS = 0',
  ];
  for (const sql of stmts) {
    try { await snowSql(sql); } catch (_) { /* best-effort */ }
  }
  log('INFO', 'Studio', 'Disabled ORS auto-suspend for generation');
}

async function restoreOrsAutoSuspend(snowSql: SnowSqlFn): Promise<void> {
  const stmts = [
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE SET AUTO_SUSPEND_SECS = 14400',
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 14400',
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_SANFRANCISCO SET AUTO_SUSPEND_SECS = 14400',
  ];
  for (const sql of stmts) {
    try { await snowSql(sql); } catch (_) { /* best-effort */ }
  }
  log('INFO', 'Studio', 'Restored ORS auto-suspend after generation');
}

// ===== Compute pool / service scale-up for synthetic data generation =====
// Mirrors the matrix-build pattern in app/modules/05_matrix_pipeline.sql.
// captureAndScaleUp() snapshots current sizes and bumps per-region pool +
// ORS_SERVICE_<REGION> + gateway pool + routing_gateway_service to the targets
// below. scaleDown() reverts using the captured originals at every exit.
//
// PARALLEL JOB EDGE CASE: if two generation jobs (or a generation job and a
// matrix build) run concurrently, the second flow will SHOW the *already
// bumped* sizes as its "original" and on completion will leave the pool/service
// at the bumped size. Acceptable trade-off: both jobs benefit from the larger
// pool. The operator can manually ALTER pools back to baseline after all
// concurrent jobs complete, or rely on the next clean run to re-capture and
// restore the true baseline. RECONCILE_AUTO_SUSPEND() handles the
// AUTO_SUSPEND_SECS leg of this same race.

// ScalingState, captureAndScaleUp, scaleDown, waitForOrsReady, pickFirstNumber
// moved to ./scaling.ts


// ===========================================================================
// Sync newly-generated region into REGION_REGISTRY + CONFIG tables.
//
// Why: Data Studio writes only to SYNTHETIC_DATASETS.UNIFIED.* tables. Without
// this sync, the header region/vehicle-type switcher in the ORS Control App
// keeps showing "San Francisco" (the seeded IS_DEFAULT row in REGION_REGISTRY)
// even after the user generates Germany/California/etc. datasets.
//
// Boundary resolution order (preferred -> fallback):
//   1. REGION_CATALOG match by LOOKUP_NAME / REGION_KEY / REGION_NAME
//      (Geofabrik .poly polygons, baked by build_boundaries.py)
//   2. Concave hull from FACT_VEHICLE_TELEMETRY for this region+job
//   3. Bbox polygon from min/max telemetry coords (last resort)
//
// Center / bbox in REGION_REGISTRY are derived from the resolved boundary
// (ST_CENTROID / ST_XMIN / ...) so the map always pans to a real on-land
// centroid instead of (0, 0).
//
// CONFIG tables (DWELL_ANALYSIS, ROUTE_DEVIATION, FLEET_INTELLIGENCE_TAXIS,
// FLEET_INTELLIGENCE_FOOD_DELIVERY, RETAIL_CATCHMENT, ROUTE_OPTIMIZATION) are
// updated to point at the freshly generated (region, vehicleType) so all
// downstream projection views immediately reflect the new dataset.
// ===========================================================================

const FLEET_CONFIG_SCHEMAS = [
  'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
  'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
  'FLEET_INTELLIGENCE.RETAIL_CATCHMENT',
  'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
  'FLEET_INTELLIGENCE.BACKLOAD_MATCHING',
];

async function syncRegionRegistryAndConfig(
  region: string,
  vehicleType: string,
  jobId: string,
  snowSql: SnowSqlFn,
): Promise<void> {
  if (!region) return;
  const safeRegion = String(region).replace(/'/g, "''");
  const safeVehicleType = String(vehicleType || 'ebike').replace(/'/g, "''");

  // 1. Upsert REGION_REGISTRY using REGION_CATALOG boundary when available.
  //    The CTEs build a single-row driver with center + bbox derived from the
  //    best available geometry source.
  try {
    const upsertSql = `
      MERGE INTO FLEET_INTELLIGENCE.CORE.REGION_REGISTRY AS tgt
      USING (
        WITH cat AS (
          SELECT
            BOUNDARY                                AS BOUNDARY,
            'catalog'                               AS BOUNDARY_SOURCE,
            COALESCE(LOOKUP_NAME, REGION_KEY, REGION_NAME) AS CAT_LOOKUP
          FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
          WHERE BOUNDARY IS NOT NULL
            AND (
              UPPER(LOOKUP_NAME) = UPPER('${safeRegion}')
              OR UPPER(REGION_KEY) = UPPER('${safeRegion}')
              OR UPPER(REGION_NAME) = UPPER('${safeRegion}')
            )
          QUALIFY ROW_NUMBER() OVER (ORDER BY BOUNDARY_AREA_KM2 ASC NULLS LAST) = 1
        ),
        hull AS (
          SELECT
            ST_MAKEPOLYGON(TO_GEOGRAPHY('LINESTRING(' ||
              MIN(LONGITUDE) || ' ' || MIN(LATITUDE) || ',' ||
              MAX(LONGITUDE) || ' ' || MIN(LATITUDE) || ',' ||
              MAX(LONGITUDE) || ' ' || MAX(LATITUDE) || ',' ||
              MIN(LONGITUDE) || ' ' || MAX(LATITUDE) || ',' ||
              MIN(LONGITUDE) || ' ' || MIN(LATITUDE) || ')'))
                                                    AS BOUNDARY,
            'telemetry-bbox'                        AS BOUNDARY_SOURCE,
            NULL                                    AS CAT_LOOKUP
          FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
          WHERE REGION = '${safeRegion}'
            AND LATITUDE IS NOT NULL AND LONGITUDE IS NOT NULL
          HAVING COUNT(*) > 0
        ),
        picked AS (
          SELECT * FROM cat
          UNION ALL
          SELECT * FROM hull WHERE NOT EXISTS (SELECT 1 FROM cat)
        )
        SELECT
          '${safeRegion}'                                       AS REGION_NAME,
          INITCAP(REGEXP_REPLACE('${safeRegion}', '([a-z])([A-Z])', '\\\\1 \\\\2')) AS DISPLAY_NAME,
          ST_Y(ST_CENTROID(BOUNDARY))::FLOAT                    AS CENTER_LAT,
          ST_X(ST_CENTROID(BOUNDARY))::FLOAT                    AS CENTER_LON,
          ST_CENTROID(BOUNDARY)                                 AS CENTER_POINT,
          ST_YMIN(BOUNDARY)::FLOAT                              AS BBOX_MIN_LAT,
          ST_YMAX(BOUNDARY)::FLOAT                              AS BBOX_MAX_LAT,
          ST_XMIN(BOUNDARY)::FLOAT                              AS BBOX_MIN_LON,
          ST_XMAX(BOUNDARY)::FLOAT                              AS BBOX_MAX_LON,
          ST_ENVELOPE(BOUNDARY)                                 AS BBOX,
          11                                                    AS ZOOM_LEVEL,
          COALESCE(CAT_LOOKUP, '${safeRegion}')                 AS ORS_REGION_KEY,
          'SYNTHETIC'                                           AS DATA_SOURCE,
          BOUNDARY_SOURCE                                       AS BOUNDARY_SOURCE
        FROM picked
      ) AS src
      ON tgt.REGION_NAME = src.REGION_NAME
      WHEN MATCHED THEN UPDATE SET
        DISPLAY_NAME    = COALESCE(tgt.DISPLAY_NAME, src.DISPLAY_NAME),
        CENTER_LAT      = src.CENTER_LAT,
        CENTER_LON      = src.CENTER_LON,
        CENTER_POINT    = src.CENTER_POINT,
        BBOX_MIN_LAT    = src.BBOX_MIN_LAT,
        BBOX_MAX_LAT    = src.BBOX_MAX_LAT,
        BBOX_MIN_LON    = src.BBOX_MIN_LON,
        BBOX_MAX_LON    = src.BBOX_MAX_LON,
        BBOX            = src.BBOX,
        ORS_REGION_KEY  = COALESCE(tgt.ORS_REGION_KEY, src.ORS_REGION_KEY),
        DATA_SOURCE     = COALESCE(tgt.DATA_SOURCE, src.DATA_SOURCE)
      WHEN NOT MATCHED THEN INSERT (
        REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON, CENTER_POINT,
        BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON, BBOX,
        ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE, IS_DEFAULT, PROVISIONED_AT
      ) VALUES (
        src.REGION_NAME, src.DISPLAY_NAME, src.CENTER_LAT, src.CENTER_LON, src.CENTER_POINT,
        src.BBOX_MIN_LAT, src.BBOX_MAX_LAT, src.BBOX_MIN_LON, src.BBOX_MAX_LON, src.BBOX,
        src.ZOOM_LEVEL, src.ORS_REGION_KEY, src.DATA_SOURCE, FALSE, CURRENT_TIMESTAMP()
      )
    `;
    await snowSql(upsertSql, 'FLEET_INTELLIGENCE', 'CORE');
    log('INFO', 'Studio', `Upserted REGION_REGISTRY for ${region}`, { jobId });
  } catch (e: any) {
    log('WARN', 'Studio', `REGION_REGISTRY upsert failed for ${region}: ${e.message?.slice(0, 200)}`, { jobId });
  }

  // 2. Promote the new region to active (flip IS_DEFAULT in REGION_REGISTRY).
  try {
    await snowSql(
      `CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${safeRegion}')`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    log('INFO', 'Studio', `Promoted ${region} to active region`, { jobId });
  } catch (e: any) {
    log('WARN', 'Studio', `SET_ACTIVE_REGION failed for ${region}: ${e.message?.slice(0, 200)}`, { jobId });
  }

  // 3. Update all 6 CONFIG tables so projection views immediately filter to
  //    the freshly generated (region, vehicleType).
  for (const schema of FLEET_CONFIG_SCHEMAS) {
    try {
      await snowSql(
        `UPDATE ${schema}.CONFIG SET VEHICLE_TYPE='${safeVehicleType}', REGION='${safeRegion}'`,
      );
    } catch (e: any) {
      log('WARN', 'Studio', `CONFIG update failed for ${schema}: ${e.message?.slice(0, 150)}`, { jobId });
    }
  }
}

async function ensureTables(snowSql: SnowSqlFn): Promise<void> {
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
      JOB_ID VARCHAR
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
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.GENERATION_JOBS (
      JOB_ID VARCHAR, PRESET_NAME VARCHAR, REGION VARCHAR(100),
      ORS_PROFILE VARCHAR(30), NUM_VEHICLES INT,
      START_DATE VARCHAR, END_DATE VARCHAR,
      STATUS VARCHAR(20), CONFIG VARIANT,
      POINTS_GENERATED INT DEFAULT 0, TRIPS_GENERATED INT DEFAULT 0,
      ERROR_MESSAGE VARCHAR, STARTED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
      COMPLETED_AT TIMESTAMP_NTZ, LOG_TEXT VARIANT
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
    { sql: `ALTER TABLE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS ADD COLUMN IF NOT EXISTS LOG_TEXT VARIANT`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
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
      const msg = `DDL error (${db}.${schema}): ${raw.slice(0, 200)}`;
      console.error(`[Studio] ${msg}`);
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }

}

async function insertTelemetryBatch(points: TelemetryPoint[], snowSql: SnowSqlFn, jobId: string): Promise<number> {
  if (points.length === 0) return 0;
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < points.length; i += batchSize) {
    const chunk = points.slice(i, i + batchSize);
    const selects = chunk.map(p =>
      `SELECT ${escVal(p.telemetry_id)},${escVal(p.region)},${escVal(p.vehicle_type)},` +
      `${escVal(p.vehicle_id)},${escVal(p.trip_id)},` +
      `${escVal(p.ts)},${p.latitude},${p.longitude},ST_MAKEPOINT(${p.longitude},${p.latitude}),` +
      `${p.speed_kmh},${p.heading_deg},` +
      `${p.posted_speed_kmh},${escVal(p.status)},${escVal(p.is_speeding)},${escVal(p.is_hos_violation)},` +
      `${escVal(p.is_detour)},${p.gps_accuracy_m},${escVal(p.location_id)},${escVal(p.location_type)},` +
      `${escVal(p.ors_profile)},${p.battery_pct !== null ? p.battery_pct : 'NULL'},` +
      `${p.odometer_km !== null ? p.odometer_km : 'NULL'},${p.point_index !== null ? p.point_index : 'NULL'},` +
      `${escVal(jobId)}`
    ).join(' UNION ALL\n');

    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_VEHICLE_TELEMETRY
      (TELEMETRY_ID,REGION,VEHICLE_TYPE,VEHICLE_ID,TRIP_ID,TS,LATITUDE,LONGITUDE,POINT_GEOM,SPEED_KMH,HEADING_DEG,
       POSTED_SPEED_KMH,STATUS,IS_SPEEDING,IS_HOS_VIOLATION,IS_DETOUR,GPS_ACCURACY_M,
       LOCATION_ID,LOCATION_TYPE,ORS_PROFILE,BATTERY_PCT,ODOMETER_KM,POINT_INDEX,JOB_ID)
      ${selects}`;
    try {
      await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
      inserted += chunk.length;
    } catch (e: any) {
      const msg = `Telemetry insert error (batch ${i}-${i + batchSize}): ${e.message?.slice(0, 200)}`;
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
  return inserted;
}

async function insertTripBatch(trips: TripRecord[], snowSql: SnowSqlFn, jobId: string): Promise<number> {
  if (trips.length === 0) return 0;
  const batchSize = 200;
  let inserted = 0;
  for (let i = 0; i < trips.length; i += batchSize) {
    const chunk = trips.slice(i, i + batchSize);
    const selects = chunk.map(t => {
      const routeGeo = t.route_coordinates.length >= 2
        ? `TO_GEOGRAPHY('LINESTRING(${t.route_coordinates.map(c => `${c[1]} ${c[0]}`).join(',')})')`
        : 'TO_GEOGRAPHY(NULL)';
      const plannedGeo = t.planned_route_coordinates && t.planned_route_coordinates.length >= 2
        ? `TO_GEOGRAPHY('LINESTRING(${t.planned_route_coordinates.map(c => `${c[1]} ${c[0]}`).join(',')})')`
        : 'TO_GEOGRAPHY(NULL)';
      return `SELECT ${escVal(t.trip_id)},${escVal(t.vehicle_id)},${escVal(t.driver_id)},` +
        `${escVal(t.vehicle_type)},${escVal(t.region)},` +
        `${escVal(t.origin_poi_id)},${escVal(t.destination_poi_id)},` +
        `${t.origin_lat},${t.origin_lon},ST_MAKEPOINT(${t.origin_lon},${t.origin_lat}),` +
        `${t.destination_lat},${t.destination_lon},ST_MAKEPOINT(${t.destination_lon},${t.destination_lat}),` +
        `${routeGeo},${t.distance_km},${t.duration_minutes},` +
        `${plannedGeo},${t.planned_distance_km !== null ? t.planned_distance_km : 'NULL'},` +
        `${escVal(t.is_detour)},${t.detour_distance_km !== null ? t.detour_distance_km : 'NULL'},` +
        `${escVal(t.trip_start)},${escVal(t.trip_end)},${escVal(t.status)},${escVal(t.ors_profile)},` +
        `${escVal(jobId)}`;
    }).join(' UNION ALL\n');

    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_TRIPS
      (TRIP_ID,VEHICLE_ID,DRIVER_ID,VEHICLE_TYPE,REGION,
       ORIGIN_POI_ID,DESTINATION_POI_ID,ORIGIN_LAT,ORIGIN_LON,ORIGIN,
       DESTINATION_LAT,DESTINATION_LON,DESTINATION,
       ROUTE_GEOG,DISTANCE_KM,DURATION_MINUTES,
       PLANNED_ROUTE_GEOG,PLANNED_DISTANCE_KM,
       IS_DETOUR,DETOUR_DISTANCE_KM,TRIP_START,TRIP_END,STATUS,ORS_PROFILE,JOB_ID)
      ${selects}`;
    try {
      await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
      inserted += chunk.length;
    } catch (e: any) {
      const msg = `Trip insert error (batch ${i}-${i + batchSize}): ${e.message?.slice(0, 200)}`;
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
  return inserted;
}

async function insertDimFleet(fleet: any[], config: GenerationConfig, snowSql: SnowSqlFn, jobId: string): Promise<void> {
  if (fleet.length === 0) return;
  const vt = resolveVehicleType(config);
  const values = fleet.map((m: any) =>
    `(${escVal(m.vehicle_id)},${escVal(config.region)},${escVal(vt)},${escVal(config.ors_profile)},` +
    `${escVal(m.shift_start + '-' + m.shift_end)},${m.shift_start},${m.shift_end},` +
    `${escVal(m.home_poi.location_id)},${escVal(m.profile_type)},${escVal(config.mode)},` +
    `${m.base_speed_kmh},${m.battery_pct > 0 ? config.battery?.range_km || 'NULL' : 'NULL'},` +
    `${escVal(jobId)})`
  ).join(',\n');
  const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_FLEET
    (VEHICLE_ID,REGION,VEHICLE_TYPE,ORS_PROFILE,SHIFT_TYPE,SHIFT_START_HOUR,SHIFT_END_HOUR,
     HOME_LOCATION_ID,DRIVER_PROFILE,OPERATING_MODE,BASE_SPEED_KMH,BATTERY_RANGE_KM,JOB_ID)
    VALUES ${values}`;
  try {
    await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
  } catch (e: any) {
    const msg = `DIM_FLEET insert error: ${e.message?.slice(0, 200)}`;
    log('ERROR', 'Studio', msg);
    throw new Error(msg);
  }
}

async function insertDimPois(pois: any[], config: GenerationConfig, snowSql: SnowSqlFn, jobId: string): Promise<void> {
  if (pois.length === 0) return;
  const batchSize = 500;
  for (let i = 0; i < pois.length; i += batchSize) {
    const chunk = pois.slice(i, i + batchSize);
    const selects = chunk.map((p: any) =>
      `SELECT ${escVal(p.location_id)},${escVal(config.region)},${escVal(p.name)},${escVal(p.location_type)},` +
      `${escVal(p.category)},${p.lat},${p.lng},ST_MAKEPOINT(${p.lng},${p.lat}),${escVal(p.source || 'generated')},` +
      `${escVal(jobId)}`
    ).join(' UNION ALL\n');
    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.DIM_POIS
      (LOCATION_ID,REGION,NAME,LOCATION_TYPE,CATEGORY,LAT,LNG,POINT_GEOM,SOURCE,JOB_ID)
      ${selects}`;
    try {
      await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
    } catch (e: any) {
      const msg = `DIM_POIS insert error (batch ${i}-${i + batchSize}): ${e.message?.slice(0, 200)}`;
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
}

async function insertFactFreightOffers(offers: any[], config: GenerationConfig, snowSql: SnowSqlFn, jobId: string): Promise<number> {
  if (offers.length === 0) return 0;
  const vt = resolveVehicleType(config);
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < offers.length; i += batchSize) {
    const chunk = offers.slice(i, i + batchSize);
    const selects = chunk.map((o: any) =>
      `SELECT ${escVal(o.offer_id)},${escVal(config.region)},${escVal(vt)},${escVal(o.source)},` +
      `${escVal(o.pickup_poi_id)},${o.pickup_lat},${o.pickup_lon},ST_MAKEPOINT(${o.pickup_lon},${o.pickup_lat}),` +
      `${escVal(o.dropoff_poi_id)},${o.dropoff_lat},${o.dropoff_lon},ST_MAKEPOINT(${o.dropoff_lon},${o.dropoff_lat}),` +
      `DATEADD(MINUTE, ${o.pickup_from_offset_min}, CURRENT_TIMESTAMP()),` +
      `DATEADD(MINUTE, ${o.pickup_to_offset_min}, CURRENT_TIMESTAMP()),` +
      `${o.weight_kg},${escVal(o.product)},${o.price_usd},${o.hazmat ? 'TRUE' : 'FALSE'},` +
      `${escVal(o.listing_text)},CURRENT_TIMESTAMP(),${escVal(jobId)}`
    ).join(' UNION ALL\n');
    const sql = `INSERT INTO ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_FREIGHT_OFFERS
      (OFFER_ID,REGION,VEHICLE_TYPE,SOURCE,
       PICKUP_POI_ID,PICKUP_LAT,PICKUP_LON,PICKUP_GEOM,
       DROPOFF_POI_ID,DROPOFF_LAT,DROPOFF_LON,DROPOFF_GEOM,
       PICKUP_FROM_TS,PICKUP_TO_TS,WEIGHT_KG,PRODUCT,PRICE_USD,HAZMAT,
       LISTING_TEXT,POSTED_AT,JOB_ID)
      ${selects}`;
    try {
      await snowSql(sql, UNIFIED_DB, UNIFIED_SCHEMA);
      inserted += chunk.length;
    } catch (e: any) {
      const msg = `FACT_FREIGHT_OFFERS insert error (batch ${i}-${i + batchSize}): ${e.message?.slice(0, 200)}`;
      log('ERROR', 'Studio', msg);
      throw new Error(msg);
    }
  }
  return inserted;
}

// Optional callback the server can register to be notified when a generation
// job has been promoted to the active region. Used to refresh the in-memory
// activeRegionOverride so the next /api/regions response immediately reflects
// the freshly generated dataset without waiting for a container restart.
let onRegionActivated: ((region: string) => void) | null = null;
export function setRegionActivatedHandler(fn: (region: string) => void): void {
  onRegionActivated = fn;
}

export async function startGeneration(
  config: GenerationConfig,
  presetName: string,
  snowSql: SnowSqlFn,
): Promise<string> {
  const rng = createRng(Date.now());
  const jobId = uuid(rng);
  const vt = resolveVehicleType(config);

  log('INFO', 'Studio', `Job ${jobId} started: ${presetName} (${config.region}, ${config.ors_profile})`, { jobId });

  const job: Job = {
    jobId,
    presetName,
    region: config.region,
    orsProfile: config.ors_profile,
    vehicleType: vt,
    status: 'RUNNING',
    pointsGenerated: 0,
    tripsGenerated: 0,
    startedAt: new Date(),
    completedAt: null,
    error: null,
    abort: { aborted: false },
    listeners: new Set(),
    events: [],
  };
  activeJobs.set(jobId, job);
  broadcast(job, 'started', {
    jobId,
    presetName,
    region: config.region,
    orsProfile: config.ors_profile,
    vehicleType: vt,
    startedAt: job.startedAt.toISOString(),
  });

  (async () => {
    let scalingState: ScalingState | null = null;
    // Periodic flush of job.events into GENERATION_JOBS.LOG_TEXT so a worker crash or
    // container restart mid-run does not lose the event buffer (which would render the
    // UI logs panel as "(No log events recorded for this job)"). Skip flushes when no
    // new events have arrived since the last persist.
    const JOB_LOG_FLUSH_MS = 60_000;
    let lastPersistedEventCount = 0;
    let persistInFlight = false;
    const flushTimer: NodeJS.Timeout = setInterval(() => {
      if (persistInFlight) return;
      if (job.events.length === lastPersistedEventCount) return;
      const expected = job.events.length;
      persistInFlight = true;
      persistJobLog(job, snowSql)
        .then(() => { lastPersistedEventCount = expected; })
        .catch(() => { /* persistJobLog already logs; never throw from timer */ })
        .finally(() => { persistInFlight = false; });
    }, JOB_LOG_FLUSH_MS);
    try {
      await ensureTables(snowSql);
      await disableOrsAutoSuspend(snowSql);
      try {
        scalingState = await captureAndScaleUp(snowSql, config.region);
      } catch (e: any) {
        log('WARN', 'Studio', `Scale-up failed (continuing with current capacity): ${e.message?.slice(0, 200)}`, { jobId });
      }
      try {
        await waitForOrsReady(snowSql, config.region, config.ors_profile);
      } catch (e: any) {
        log('WARN', 'Studio', `ORS readiness wait threw (continuing): ${e.message?.slice(0, 200)}`, { jobId });
      }

      try {
        const configJson = JSON.stringify(config).replace(/\$\$/g, '$ $');
        await snowSql(
          `INSERT INTO FLEET_INTELLIGENCE.CORE.GENERATION_JOBS (JOB_ID,PRESET_NAME,REGION,ORS_PROFILE,NUM_VEHICLES,START_DATE,END_DATE,STATUS,CONFIG)
           SELECT ${escVal(jobId)},${escVal(presetName)},${escVal(config.region)},${escVal(config.ors_profile)},
           ${config.fleet.num_vehicles},${escVal(config.time.start_date)},${escVal(config.time.end_date)},'RUNNING',
           PARSE_JSON($$${configJson}$$)`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e: any) {
        const msg = `Failed to record job in history: ${e.message?.slice(0, 300)}`;
        log('ERROR', 'Studio', msg, { jobId });
        broadcast(job, 'warning', { message: msg });
      }

      const { loadPOIs, buildFleet, generateFreightOffers } = await import('./engine.js');
      const pois = await loadPOIs(config, snowSql);
      const fleet = buildFleet(config, pois, createRng(config.fleet.num_vehicles * 31));
      const offers = generateFreightOffers(pois, config, 300);

      try {
        await insertDimPois(pois, config, snowSql, jobId);
      } catch (e: any) {
        log('WARN', 'Studio', `DIM_POIS insert failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
        broadcast(job, 'warning', { message: `DIM_POIS insert failed: ${e.message?.slice(0, 150)}` });
      }
      try {
        await insertDimFleet(fleet, config, snowSql, jobId);
      } catch (e: any) {
        log('WARN', 'Studio', `DIM_FLEET insert failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
        broadcast(job, 'warning', { message: `DIM_FLEET insert failed: ${e.message?.slice(0, 150)}` });
      }
      try {
        const n = await insertFactFreightOffers(offers, config, snowSql, jobId);
        log('INFO', 'Studio', `Inserted ${n} freight offers`, { jobId });
        broadcast(job, 'progress', { status: `Inserted ${n} freight offers` });
      } catch (e: any) {
        log('WARN', 'Studio', `FACT_FREIGHT_OFFERS insert failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
        broadcast(job, 'warning', { message: `FACT_FREIGHT_OFFERS insert failed: ${e.message?.slice(0, 150)}` });
      }

      const catCounts: Record<string, number> = {};
      for (const p of pois) catCounts[p.category || p.location_type] = (catCounts[p.category || p.location_type] || 0) + 1;
      const catSummary = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(', ');
      broadcast(job, 'progress', { status: `Loaded ${pois.length} POIs (${catSummary}), built ${fleet.length} vehicles` });

      const pendingTrips: TripRecord[] = [];
      let stoppedEvent: any = null;

      const gen = generateTelemetry(config, snowSql,
        (p: GenerationProgress) => {
          job.pointsGenerated = p.totalPoints;
          job.tripsGenerated = p.totalTrips;
          broadcast(job, 'progress', p);
        },
        job.abort,
        (msg: string) => {
          broadcast(job, 'progress', { status: msg });
        }
      );

      for await (const event of gen) {
        if (job.abort.aborted) break;

        if (event.type === 'telemetry') {
          try {
            await insertTelemetryBatch(event.points, snowSql, jobId);
          } catch (e: any) {
            log('ERROR', 'Studio', `Telemetry insert failed: ${e.message?.slice(0, 200)}`, { jobId });
            broadcast(job, 'warning', { message: `Telemetry insert failed: ${e.message?.slice(0, 150)}` });
          }
          broadcast(job, 'batch', { inserted: event.points.length, total: job.pointsGenerated });
        } else if (event.type === 'trip') {
          pendingTrips.push(event.record);
          if (pendingTrips.length >= 50) {
            try {
              await insertTripBatch(pendingTrips.splice(0), snowSql, jobId);
            } catch (e: any) {
              log('ERROR', 'Studio', `Trip batch insert failed: ${e.message?.slice(0, 200)}`, { jobId });
              broadcast(job, 'warning', { message: `Trip insert failed: ${e.message?.slice(0, 150)}` });
            }
          }
        } else if (event.type === 'stopped') {
          stoppedEvent = event;
          break;
        }
      }

      if (pendingTrips.length > 0) {
        try {
          await insertTripBatch(pendingTrips, snowSql, jobId);
        } catch (e: any) {
          log('ERROR', 'Studio', `Final trip batch insert failed: ${e.message?.slice(0, 200)}`, { jobId });
          broadcast(job, 'warning', { message: `Final trip insert failed: ${e.message?.slice(0, 150)}` });
        }
      }

      if (stoppedEvent) {
        job.status = 'STOPPED';
        job.completedAt = new Date();
        log('WARN', 'Studio', `Job ${jobId} stopped: ${stoppedEvent.reason}`, {
          jobId,
          detail: { days: `${stoppedEvent.completedDays}/${stoppedEvent.totalDays}`, successes: stoppedEvent.routeSuccesses, failures: stoppedEvent.routeFailures },
        });
        broadcast(job, 'stopped', {
          reason: stoppedEvent.reason,
          pointsGenerated: job.pointsGenerated,
          tripsGenerated: job.tripsGenerated,
          completedDays: stoppedEvent.completedDays,
          totalDays: stoppedEvent.totalDays,
          routeSuccesses: stoppedEvent.routeSuccesses,
          routeFailures: stoppedEvent.routeFailures,
        });
      } else {
        job.status = job.abort.aborted ? 'CANCELLED' : 'COMPLETED';
        job.completedAt = new Date();
        log('INFO', 'Studio', `Job ${jobId} ${job.status}: ${job.pointsGenerated} pts, ${job.tripsGenerated} trips`, { jobId });
        broadcast(job, job.status === 'COMPLETED' ? 'complete' : 'cancelled', { pointsGenerated: job.pointsGenerated, tripsGenerated: job.tripsGenerated });
      }

      try {
        const errMsg = stoppedEvent
          ? `ORS stopped: ${stoppedEvent.reason}. ${stoppedEvent.completedDays}/${stoppedEvent.totalDays} days completed.`
          : null;
        await snowSql(
          `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS SET STATUS='${job.status}',
           POINTS_GENERATED=${job.pointsGenerated}, TRIPS_GENERATED=${job.tripsGenerated},
           ${errMsg ? `ERROR_MESSAGE=${escVal(errMsg)},` : ''}
           COMPLETED_AT=SYSDATE() WHERE JOB_ID=${escVal(jobId)}`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e2: any) {
        const msg = `Failed to update job status for ${jobId}: ${e2.message?.slice(0, 200)}`;
        log('ERROR', 'Studio', msg, { jobId });
        broadcast(job, 'warning', { message: msg });
      }

      // Sync REGION_REGISTRY + CONFIG tables so the header switcher and all
      // downstream projection views immediately reflect the freshly generated
      // dataset. Only on actual COMPLETED runs - not stopped/cancelled/failed.
      if (job.status === 'COMPLETED' && job.pointsGenerated > 0) {
        try {
          await syncRegionRegistryAndConfig(config.region, vt, jobId, snowSql);
          if (onRegionActivated) onRegionActivated(config.region);
        } catch (e: any) {
          log('WARN', 'Studio', `Region sync after completion failed: ${e.message?.slice(0, 200)}`, { jobId });
        }
      }
    } catch (e: any) {
      job.status = 'FAILED';
      job.error = e.message;
      job.completedAt = new Date();
      log('ERROR', 'Studio', `Job ${jobId} failed: ${e.message?.slice(0, 300)}`, { jobId });
      broadcast(job, 'error', { error: e.message });
      try {
        await snowSql(
          `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS SET STATUS='FAILED',
           ERROR_MESSAGE=${escVal(e.message?.slice(0, 500))},
           COMPLETED_AT=SYSDATE() WHERE JOB_ID=${escVal(jobId)}`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e3: any) {
        const msg = `Failed to update failed-job status for ${jobId}: ${e3.message?.slice(0, 200)}`;
        log('ERROR', 'Studio', msg, { jobId });
        broadcast(job, 'warning', { message: msg });
      }
    } finally {
      clearInterval(flushTimer);
      try { await scaleDown(snowSql, scalingState); } catch (_) { /* best-effort */ }
      await restoreOrsAutoSuspend(snowSql);
      try { await persistJobLog(job, snowSql); } catch (_) { /* best-effort */ }
    }
  })();

  return jobId;
}
