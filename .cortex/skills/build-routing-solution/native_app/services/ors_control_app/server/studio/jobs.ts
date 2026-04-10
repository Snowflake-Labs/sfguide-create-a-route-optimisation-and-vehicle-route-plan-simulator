import { GenerationConfig, createRng, uuid, resolveVehicleType } from './profiles.js';
import { generateTelemetry, TelemetryPoint, TripRecord, GenerationEvent, GenerationProgress } from './engine.js';
import { log } from '../diagnostics.js';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;
type SseCallback = (event: string, data: any) => void;

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
}

const activeJobs = new Map<string, Job>();

export function getJobs(): Job[] {
  return [...activeJobs.values()].map(j => ({ ...j, abort: undefined as any, listeners: undefined as any }));
}

export function getJob(jobId: string): Job | undefined {
  return activeJobs.get(jobId);
}

export function cancelJob(jobId: string): boolean {
  const job = activeJobs.get(jobId);
  if (!job || job.status !== 'RUNNING') return false;
  job.abort.aborted = true;
  job.status = 'CANCELLED';
  job.completedAt = new Date();
  broadcast(job, 'cancelled', { jobId });
  return true;
}

export async function deleteJobData(jobId: string, snowSql: SnowSqlFn): Promise<{ deleted: Record<string, number> }> {
  const tables = [
    'FACT_VEHICLE_TELEMETRY', 'FACT_TRIPS', 'DIM_FLEET', 'DIM_POIS', 'DIM_TRIP_SCHEDULE',
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
      `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS SET STATUS='DELETED', COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=${escVal(jobId)}`,
      'FLEET_INTELLIGENCE', 'CORE'
    );
  } catch (e: any) {
    log('WARN', 'Studio', `Failed to mark job ${jobId} as DELETED: ${e.message?.slice(0, 200)}`);
  }
  log('INFO', 'Studio', `Deleted data for job ${jobId}: ${JSON.stringify(deleted)}`);
  return { deleted };
}

function broadcast(job: Job, event: string, data: any) {
  for (const cb of job.listeners) {
    try { cb(event, data); } catch (e: any) {
      log('WARN', 'Studio', `SSE broadcast failed: ${e.message?.slice(0, 100)}`);
    }
  }
}

export function subscribeJob(jobId: string, cb: SseCallback): () => void {
  const job = activeJobs.get(jobId);
  if (!job) return () => {};
  job.listeners.add(cb);
  return () => { job.listeners.delete(cb); };
}

function escVal(v: any): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').replace('Z', '')}'`;
  const s = String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '');
  return `'${s}'`;
}

const UNIFIED_DB = 'SYNTHETIC_DATASETS';
const UNIFIED_SCHEMA = 'UNIFIED';

async function disableOrsAutoSuspend(snowSql: SnowSqlFn): Promise<void> {
  const stmts = [
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE SET AUTO_SUSPEND_SECS = 0',
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 0',
  ];
  for (const sql of stmts) {
    try { await snowSql(sql); } catch (_) { /* best-effort */ }
  }
  log('INFO', 'Studio', 'Disabled ORS auto-suspend for generation');
}

async function restoreOrsAutoSuspend(snowSql: SnowSqlFn): Promise<void> {
  const stmts = [
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE SET AUTO_SUSPEND_SECS = 14400',
    'ALTER SERVICE IF EXISTS OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 14400',
  ];
  for (const sql of stmts) {
    try { await snowSql(sql); } catch (_) { /* best-effort */ }
  }
  log('INFO', 'Studio', 'Restored ORS auto-suspend after generation');
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
    { sql: `CREATE TABLE IF NOT EXISTS FLEET_INTELLIGENCE.CORE.GENERATION_JOBS (
      JOB_ID VARCHAR, PRESET_NAME VARCHAR, REGION VARCHAR(100),
      ORS_PROFILE VARCHAR(30), NUM_VEHICLES INT,
      START_DATE VARCHAR, END_DATE VARCHAR,
      STATUS VARCHAR(20), CONFIG VARIANT,
      POINTS_GENERATED INT DEFAULT 0, TRIPS_GENERATED INT DEFAULT 0,
      ERROR_MESSAGE VARCHAR, STARTED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
      COMPLETED_AT TIMESTAMP_NTZ
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'`, db: 'FLEET_INTELLIGENCE', schema: 'CORE' },
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

  const migrationColumns: { table: string; col: string; type: string }[] = [
    { table: 'FACT_VEHICLE_TELEMETRY', col: 'JOB_ID', type: 'VARCHAR' },
    { table: 'FACT_VEHICLE_TELEMETRY', col: 'POINT_GEOM', type: 'GEOGRAPHY' },
    { table: 'FACT_TRIPS', col: 'JOB_ID', type: 'VARCHAR' },
    { table: 'FACT_TRIPS', col: 'ORIGIN', type: 'GEOGRAPHY' },
    { table: 'FACT_TRIPS', col: 'DESTINATION', type: 'GEOGRAPHY' },
    { table: 'DIM_FLEET', col: 'JOB_ID', type: 'VARCHAR' },
    { table: 'DIM_POIS', col: 'JOB_ID', type: 'VARCHAR' },
    { table: 'DIM_TRIP_SCHEDULE', col: 'JOB_ID', type: 'VARCHAR' },
  ];
  for (const { table, col, type } of migrationColumns) {
    try {
      await snowSql(
        `ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`,
        UNIFIED_DB, UNIFIED_SCHEMA
      );
    } catch (_) { /* best-effort: column may already exist */ }
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
  };
  activeJobs.set(jobId, job);

  (async () => {
    try {
      await ensureTables(snowSql);
      await disableOrsAutoSuspend(snowSql);

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

      const { loadPOIs, buildFleet } = await import('./engine.js');
      const pois = await loadPOIs(config, snowSql);
      const fleet = buildFleet(config, pois, createRng(config.fleet.num_vehicles * 31));

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
        job.abort
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
           COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=${escVal(jobId)}`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e2: any) {
        const msg = `Failed to update job status for ${jobId}: ${e2.message?.slice(0, 200)}`;
        log('ERROR', 'Studio', msg, { jobId });
        broadcast(job, 'warning', { message: msg });
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
           COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=${escVal(jobId)}`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e3: any) {
        const msg = `Failed to update failed-job status for ${jobId}: ${e3.message?.slice(0, 200)}`;
        log('ERROR', 'Studio', msg, { jobId });
        broadcast(job, 'warning', { message: msg });
      }
    } finally {
      await restoreOrsAutoSuspend(snowSql);
    }
  })();

  return jobId;
}
