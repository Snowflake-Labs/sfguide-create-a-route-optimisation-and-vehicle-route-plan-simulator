import { GenerationConfig, createRng, uuid, resolveVehicleType } from './profiles.js';
import { generateTelemetry, TelemetryPoint, TripRecord, GenerationEvent, GenerationProgress } from './engine.js';
import { log } from '../diagnostics.js';
import { normalizeRegion } from '../lib/region.js';
import { escVal, UNIFIED_DB, UNIFIED_SCHEMA } from './sql-helpers.js';
import { ScalingState, captureAndScaleUp, scaleDown, waitForOrsReady } from './scaling.js';
import { ensureTables } from './ensure-tables.js';
import { syncRegionRegistryAndConfig } from './region-sync.js';
import { insertTelemetryBatch, insertTripBatch, insertDimFleet, insertDimPois, insertFactFreightOffers } from './inserters.js';

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
