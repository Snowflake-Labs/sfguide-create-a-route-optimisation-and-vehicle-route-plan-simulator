import { GenerationConfig, createRng, uuid } from './profiles.js';
import { generateTelemetry, TelemetryPoint, GenerationProgress } from './engine.js';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;
type SseCallback = (event: string, data: any) => void;

export interface Job {
  jobId: string;
  presetName: string;
  region: string;
  orsProfile: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
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

function broadcast(job: Job, event: string, data: any) {
  for (const cb of job.listeners) {
    try { cb(event, data); } catch {}
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
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function insertBatch(points: TelemetryPoint[], snowSql: SnowSqlFn): Promise<number> {
  if (points.length === 0) return 0;
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < points.length; i += batchSize) {
    const chunk = points.slice(i, i + batchSize);
    const values = chunk.map(p =>
      `(${escVal(p.telemetry_id)},${escVal(p.region)},${escVal(p.vehicle_id)},${escVal(p.trip_id)},` +
      `${escVal(p.ts)},${p.latitude},${p.longitude},${p.speed_kmh},${p.heading_deg},` +
      `${p.posted_speed_kmh},${escVal(p.status)},${escVal(p.is_speeding)},${escVal(p.is_hos_violation)},` +
      `${escVal(p.is_detour)},${p.gps_accuracy_m},${escVal(p.location_id)},${escVal(p.location_type)},` +
      `${escVal(p.ors_profile)},${escVal(p.vehicle_type)},${p.battery_pct !== null ? p.battery_pct : 'NULL'})`
    ).join(',\n');

    const sql = `INSERT INTO SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
      (TELEMETRY_ID,REGION,VEHICLE_ID,TRIP_ID,TS,LATITUDE,LONGITUDE,SPEED_KMH,HEADING_DEG,
       POSTED_SPEED_KMH,STATUS,IS_SPEEDING,IS_HOS_VIOLATION,IS_DETOUR,GPS_ACCURACY_M,
       LOCATION_ID,LOCATION_TYPE,ORS_PROFILE,VEHICLE_TYPE,BATTERY_PCT)
      VALUES ${values}`;
    try {
      await snowSql(sql, 'SYNTHETIC_DATASETS', 'UNIFIED');
      inserted += chunk.length;
    } catch (e: any) {
      console.error(`[Studio] Insert batch error: ${e.message?.slice(0, 200)}`);
    }
  }
  return inserted;
}

async function insertDimFleet(fleet: any[], config: GenerationConfig, snowSql: SnowSqlFn): Promise<void> {
  if (fleet.length === 0) return;
  const values = fleet.map((m: any) =>
    `(${escVal(m.vehicle_id)},${escVal(config.region)},${escVal(m.vehicle_type)},${escVal(config.ors_profile)},` +
    `${escVal(m.shift_start + '-' + m.shift_end)},${m.shift_start},${m.shift_end},` +
    `${escVal(m.home_poi.location_id)},${escVal(m.profile_type)},${escVal(config.mode)},` +
    `${m.base_speed_kmh},${m.battery_pct > 0 ? config.battery?.range_km || 'NULL' : 'NULL'})`
  ).join(',\n');
  const sql = `INSERT INTO SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
    (VEHICLE_ID,REGION,VEHICLE_TYPE,ORS_PROFILE,SHIFT_TYPE,SHIFT_START_HOUR,SHIFT_END_HOUR,
     HOME_LOCATION_ID,DRIVER_PROFILE,OPERATING_MODE,BASE_SPEED_KMH,BATTERY_RANGE_KM)
    VALUES ${values}`;
  try {
    await snowSql(sql, 'SYNTHETIC_DATASETS', 'UNIFIED');
  } catch (e: any) {
    console.error(`[Studio] DIM_FLEET insert error: ${e.message?.slice(0, 200)}`);
  }
}

async function insertDimPois(pois: any[], config: GenerationConfig, snowSql: SnowSqlFn): Promise<void> {
  if (pois.length === 0) return;
  const batchSize = 500;
  for (let i = 0; i < pois.length; i += batchSize) {
    const chunk = pois.slice(i, i + batchSize);
    const values = chunk.map((p: any) =>
      `(${escVal(p.location_id)},${escVal(config.region)},${escVal(p.name)},${escVal(p.location_type)},` +
      `${escVal(p.category)},${p.lat},${p.lng},ST_MAKEPOINT(${p.lng},${p.lat}),${escVal(p.source || 'generated')})`
    ).join(',\n');
    const sql = `INSERT INTO SYNTHETIC_DATASETS.UNIFIED.DIM_POIS
      (LOCATION_ID,REGION,NAME,LOCATION_TYPE,CATEGORY,LAT,LNG,POINT_GEOM,SOURCE)
      VALUES ${values}`;
    try {
      await snowSql(sql, 'SYNTHETIC_DATASETS', 'UNIFIED');
    } catch (e: any) {
      console.error(`[Studio] DIM_POIS insert error: ${e.message?.slice(0, 200)}`);
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

  const job: Job = {
    jobId,
    presetName,
    region: config.region,
    orsProfile: config.ors_profile,
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

  try {
    await snowSql(
      `INSERT INTO FLEET_INTELLIGENCE.CORE.GENERATION_JOBS (JOB_ID,PRESET_NAME,REGION,ORS_PROFILE,NUM_VEHICLES,START_DATE,END_DATE,STATUS,CONFIG)
       VALUES (${escVal(jobId)},${escVal(presetName)},${escVal(config.region)},${escVal(config.ors_profile)},
       ${config.fleet.num_vehicles},${escVal(config.time.start_date)},${escVal(config.time.end_date)},'RUNNING',
       PARSE_JSON(${escVal(JSON.stringify(config))}))`,
      'FLEET_INTELLIGENCE', 'CORE'
    );
  } catch {}

  (async () => {
    try {
      const { loadPOIs, buildFleet } = await import('./engine.js');
      const pois = await loadPOIs(config, snowSql);
      const fleet = buildFleet(config, pois, createRng(config.fleet.num_vehicles * 31));

      await insertDimPois(pois, config, snowSql);
      await insertDimFleet(fleet, config, snowSql);

      broadcast(job, 'progress', { status: `Loaded ${pois.length} POIs, built ${fleet.length} vehicles` });

      const gen = generateTelemetry(config, snowSql,
        (p: GenerationProgress) => {
          job.pointsGenerated = p.totalPoints;
          job.tripsGenerated = p.totalTrips;
          broadcast(job, 'progress', p);
        },
        job.abort
      );

      for await (const batch of gen) {
        if (job.abort.aborted) break;
        await insertBatch(batch, snowSql);
        broadcast(job, 'batch', { inserted: batch.length, total: job.pointsGenerated });
      }

      job.status = job.abort.aborted ? 'CANCELLED' : 'COMPLETED';
      job.completedAt = new Date();
      broadcast(job, 'complete', { pointsGenerated: job.pointsGenerated, tripsGenerated: job.tripsGenerated });

      try {
        await snowSql(
          `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS SET STATUS='${job.status}',
           POINTS_GENERATED=${job.pointsGenerated}, TRIPS_GENERATED=${job.tripsGenerated},
           COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=${escVal(jobId)}`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch {}
    } catch (e: any) {
      job.status = 'FAILED';
      job.error = e.message;
      job.completedAt = new Date();
      broadcast(job, 'error', { error: e.message });
      try {
        await snowSql(
          `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_JOBS SET STATUS='FAILED',
           ERROR_MESSAGE=${escVal(e.message?.slice(0, 500))},
           COMPLETED_AT=CURRENT_TIMESTAMP() WHERE JOB_ID=${escVal(jobId)}`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch {}
    }
  })();

  return jobId;
}
