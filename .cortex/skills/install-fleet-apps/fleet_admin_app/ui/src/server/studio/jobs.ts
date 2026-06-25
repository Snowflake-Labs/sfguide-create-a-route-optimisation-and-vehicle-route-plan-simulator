import { GenerationConfig, createRng, uuid, resolveVehicleType } from './profiles';
import { generateTelemetry, TelemetryPoint, TripRecord, GenerationEvent, GenerationProgress, loadPOIs, generateFreightOffers, generatePartners, generatePartnerHistory, generateAnchors, generateDemographics, generateHazardZones, generateDemandCatalog } from './engine';
import { buildFleetWithDiagnostics } from './engine/fleet';
import { spreadStats, binDegForArea, bboxAreaKm2 } from './engine/spatial';
import { log } from '../diagnostics';
import { normalizeRegion } from '../lib/region';
import { escVal, UNIFIED_DB, UNIFIED_SCHEMA } from './sql-helpers';
import { ScalingState, captureAndScaleUp, scaleDown, waitForOrsReady } from './scaling';
import { ensureTables } from './ensure-tables';
import { syncRegionRegistryAndConfig } from './region-sync';
import { insertTelemetryBatch, insertTripBatch, insertTripScheduleBatch, insertDimFleet, insertDimPois, insertFactFreightOffers, insertDimPartners, insertFactPartnerHistory } from './inserters';

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

// globalThis-pinned so the /api/studio/generate route (which calls startGeneration)
// and the /api/studio/jobs/[id]/stream SSE route share ONE in-memory job registry,
// even though Next compiles each route handler as a separate bundle. See R5.
const activeJobs: Map<string, Job> = ((globalThis as unknown as { __fleetAdminStudioJobs?: Map<string, Job> }).__fleetAdminStudioJobs ??= new Map<string, Job>());

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
    'DIM_PARTNERS', 'FACT_PARTNER_HISTORY',
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
    const rows = await snowSql(
      `DELETE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES WHERE JOB_ID = ${escVal(jobId)}`,
      'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
    );
    deleted['ROUTE_OPTIMIZATION.PLACES'] = rows?.[0]?.['number of rows deleted'] ?? 0;
  } catch {
    deleted['ROUTE_OPTIMIZATION.PLACES'] = -1;
  }
  try {
    const rows = await snowSql(
      `DELETE FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP WHERE JOB_ID = ${escVal(jobId)}`,
      'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
    );
    deleted['ROUTE_OPTIMIZATION.LOOKUP'] = rows?.[0]?.['number of rows deleted'] ?? 0;
  } catch {
    deleted['ROUTE_OPTIMIZATION.LOOKUP'] = -1;
  }
  try {
    const rows = await snowSql(
      `DELETE FROM FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES WHERE JOB_ID = ${escVal(jobId)}`,
      'FLEET_INTELLIGENCE', 'MARKETPLACE',
    );
    deleted['MARKETPLACE.FACT_OFFER_ROUTES'] = rows?.[0]?.['number of rows deleted'] ?? 0;
  } catch {
    deleted['MARKETPLACE.FACT_OFFER_ROUTES'] = -1;
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

async function ensureRouteOptimizationSeedData(
  snowSql: SnowSqlFn,
  region: string,
  jobId: string,
): Promise<void> {
  const safeRegion = region.replace(/'/g, "''");
  await snowSql(
    `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR`,
    'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
  );
  await snowSql(
    `ALTER TABLE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR`,
    'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
  );
  await snowSql(
    `CALL FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEED_ROUTE_OPTIMIZATION_REGION('${safeRegion}')`,
    'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
  );
  await snowSql(
    `UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
     SET JOB_ID = ${escVal(jobId)}
     WHERE REGION = ${escVal(region)}`,
    'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
  );
  await snowSql(
    `UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
     SET JOB_ID = ${escVal(jobId)}
     WHERE REGION = ${escVal(region)}`,
    'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
  );
}

async function precomputeOfferRoutes(
  snowSql: SnowSqlFn,
  region: string,
  profile: string,
  jobId: string,
): Promise<void> {
  const enabled = (process.env.STUDIO_PRECOMPUTE_OFFER_ROUTES ?? 'true').toLowerCase() !== 'false';
  if (!enabled) return;
  await snowSql(
    `ALTER TABLE FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES ADD COLUMN IF NOT EXISTS JOB_ID VARCHAR`,
    'FLEET_INTELLIGENCE', 'MARKETPLACE',
  );
  await snowSql(
    `MERGE INTO FLEET_INTELLIGENCE.MARKETPLACE.FACT_OFFER_ROUTES tgt
     USING (
       SELECT
         o.OFFER_ID,
         ${escVal(jobId)} AS JOB_ID,
         d.DISTANCE / 1000.0 AS ROAD_KM,
         d.DURATION / 60.0 AS ROAD_MIN,
         ST_ASGEOJSON(d.GEOJSON)::VARCHAR AS GEOMETRY,
         ${escVal(profile)} AS PROFILE
       FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS o,
            TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
              ${escVal(profile)},
              ARRAY_CONSTRUCT(o.PICKUP_LON, o.PICKUP_LAT),
              ARRAY_CONSTRUCT(o.DROPOFF_LON, o.DROPOFF_LAT),
              ${escVal(region)}
            )) d
       WHERE o.JOB_ID = ${escVal(jobId)}
         AND o.PICKUP_LON IS NOT NULL
         AND o.PICKUP_LAT IS NOT NULL
         AND o.DROPOFF_LON IS NOT NULL
         AND o.DROPOFF_LAT IS NOT NULL
     ) src
     ON tgt.OFFER_ID = src.OFFER_ID AND tgt.JOB_ID = src.JOB_ID
     WHEN MATCHED THEN UPDATE SET
       ROAD_KM = src.ROAD_KM,
       ROAD_MIN = src.ROAD_MIN,
       GEOMETRY = src.GEOMETRY,
       PROFILE = src.PROFILE,
       JOB_ID = src.JOB_ID,
       COMPUTED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT (JOB_ID, OFFER_ID, ROAD_KM, ROAD_MIN, GEOMETRY, PROFILE, COMPUTED_AT)
       VALUES (src.JOB_ID, src.OFFER_ID, src.ROAD_KM, src.ROAD_MIN, src.GEOMETRY, src.PROFILE, CURRENT_TIMESTAMP())`,
    'FLEET_INTELLIGENCE', 'MARKETPLACE',
  );
}

// -------------------------------------------------------------------------
// Dataset registry CRUD (used by /api/studio/datasets/* endpoints).
// All operations target FLEET_INTELLIGENCE.CORE.DIM_DATASETS plus the
// SYNTHETIC_DATASETS.UNIFIED.* fact/dim tables when physically deleting.
// -------------------------------------------------------------------------

export interface DatasetRow {
  datasetId: string;
  region: string;
  vehicleType: string;
  label: string | null;
  isActive: boolean;
  createdAt: string;
  rowCounts: Record<string, number> | null;
  notes: string | null;
}

export async function listDatasets(
  snowSql: SnowSqlFn,
  filter: { region?: string; vehicleType?: string } = {},
): Promise<DatasetRow[]> {
  const where: string[] = [];
  if (filter.region)       where.push(`REGION = ${escVal(filter.region)}`);
  if (filter.vehicleType)  where.push(`VEHICLE_TYPE = ${escVal(filter.vehicleType)}`);
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await snowSql(
    `SELECT DATASET_ID, REGION, VEHICLE_TYPE, LABEL, IS_ACTIVE,
            TO_VARCHAR(CONVERT_TIMEZONE('UTC', CREATED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS CREATED_AT,
            ROW_COUNTS, NOTES
     FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     ${whereClause}
     ORDER BY REGION, VEHICLE_TYPE, IS_ACTIVE DESC, CREATED_AT DESC`,
    'FLEET_INTELLIGENCE', 'CORE',
  );
  return rows.map((r: any) => {
    let rowCounts: Record<string, number> | null = null;
    if (r.ROW_COUNTS) {
      try {
        rowCounts = typeof r.ROW_COUNTS === 'string' ? JSON.parse(r.ROW_COUNTS) : r.ROW_COUNTS;
      } catch (_) { rowCounts = null; }
    }
    return {
      datasetId: r.DATASET_ID,
      region: r.REGION,
      vehicleType: r.VEHICLE_TYPE,
      label: r.LABEL ?? null,
      isActive: r.IS_ACTIVE === true || r.IS_ACTIVE === 'true',
      createdAt: r.CREATED_AT,
      rowCounts,
      notes: r.NOTES ?? null,
    };
  });
}

export async function activateDataset(
  snowSql: SnowSqlFn,
  datasetId: string,
): Promise<{ activated: string; deactivated: number; region: string; vehicleType: string }> {
  // Look up scope first so we know which siblings to deactivate.
  const rows = await snowSql(
    `SELECT REGION, VEHICLE_TYPE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     WHERE DATASET_ID = ${escVal(datasetId)} LIMIT 1`,
    'FLEET_INTELLIGENCE', 'CORE',
  );
  if (!rows.length) {
    throw new Error(`Dataset ${datasetId} not found in DIM_DATASETS`);
  }
  const region = (rows[0] as any).REGION as string;
  const vehicleType = (rows[0] as any).VEHICLE_TYPE as string;
  // Refuse activation when the target DATASET_ID has 0 rows in DIM_FLEET.
  // Without this, a placeholder DIM_DATASETS row (e.g. legacy '-seed'
  // recovery rows or rows whose base data was deleted out-of-band) can be
  // activated and the V_*_CURRENT views silently return zero, leaving
  // every fleet/freight page empty with no diagnostic. (#audit-pr-120)
  let probeCount = 0;
  try {
    const probe = await snowSql(
      `SELECT COUNT(*) AS N FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
       WHERE JOB_ID = ${escVal(datasetId)}`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    probeCount = Number((probe[0] as any)?.N ?? 0);
  } catch (e: any) {
    const err: any = new Error(
      `DIM_FLEET probe failed (${e.message?.slice(0, 150)}). ` +
      `Control-app boot likely didn't finish initialising tables; restart the service.`,
    );
    err.code = 'BOOT_INCOMPLETE';
    throw err;
  }
  if (probeCount === 0) {
    const err: any = new Error(
      `Dataset ${datasetId} has 0 rows in DIM_FLEET; ` +
      `re-run Data Studio for ${region} / ${vehicleType} to materialise data.`,
    );
    err.code = 'DATASET_EMPTY';
    err.region = region;
    err.vehicleType = vehicleType;
    throw err;
  }
  // Atomic-ish: deactivate other siblings, then activate this one.
  const deact = await snowSql(
    `UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     SET IS_ACTIVE = FALSE
     WHERE REGION = ${escVal(region)}
       AND VEHICLE_TYPE = ${escVal(vehicleType)}
       AND DATASET_ID <> ${escVal(datasetId)}
       AND IS_ACTIVE = TRUE`,
    'FLEET_INTELLIGENCE', 'CORE',
  );
  await snowSql(
    `UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     SET IS_ACTIVE = TRUE
     WHERE DATASET_ID = ${escVal(datasetId)}`,
    'FLEET_INTELLIGENCE', 'CORE',
  );
  return {
    activated: datasetId,
    deactivated: (deact[0] as any)?.['number of rows updated'] ?? 0,
    region,
    vehicleType,
  };
}

export async function renameDataset(
  snowSql: SnowSqlFn,
  datasetId: string,
  label: string,
): Promise<{ datasetId: string; label: string }> {
  const trimmed = label.trim().slice(0, 200);
  await snowSql(
    `UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     SET LABEL = ${escVal(trimmed)}
     WHERE DATASET_ID = ${escVal(datasetId)}`,
    'FLEET_INTELLIGENCE', 'CORE',
  );
  return { datasetId, label: trimmed };
}

export async function deleteDataset(
  snowSql: SnowSqlFn,
  datasetId: string,
): Promise<{ datasetId: string; deleted: Record<string, number>; activeReassigned: boolean }> {
  // Read the dataset row first so we can refuse-delete on the only-active
  // case and know the (region, vehicle_type) for re-activation logic.
  const rows = await snowSql(
    `SELECT REGION, VEHICLE_TYPE, IS_ACTIVE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     WHERE DATASET_ID = ${escVal(datasetId)} LIMIT 1`,
    'FLEET_INTELLIGENCE', 'CORE',
  );
  if (!rows.length) {
    throw new Error(`Dataset ${datasetId} not found in DIM_DATASETS`);
  }
  const region = (rows[0] as any).REGION as string;
  const vehicleType = (rows[0] as any).VEHICLE_TYPE as string;
  const wasActive = (rows[0] as any).IS_ACTIVE === true || (rows[0] as any).IS_ACTIVE === 'true';
  if (wasActive) {
    const others = await snowSql(
      `SELECT COUNT(*) AS N FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
       WHERE REGION = ${escVal(region)}
         AND VEHICLE_TYPE = ${escVal(vehicleType)}
         AND DATASET_ID <> ${escVal(datasetId)}`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    const otherCount = Number((others[0] as any)?.N ?? 0);
    if (otherCount === 0) {
      throw new Error(
        `Refusing to delete the only dataset for ${region} / ${vehicleType}. ` +
        `Generate a new one (or pick another) and re-try.`,
      );
    }
  }
  // Physical purge of fact/dim rows for this JOB_ID.
  const { deleted } = await deleteJobData(datasetId, snowSql);
  // Remove the registry row.
  await snowSql(
    `DELETE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
     WHERE DATASET_ID = ${escVal(datasetId)}`,
    'FLEET_INTELLIGENCE', 'CORE',
  );
  // If we just removed the active row, promote the most recent remaining.
  let activeReassigned = false;
  if (wasActive) {
    const upd = await snowSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
       SET IS_ACTIVE = TRUE
       WHERE DATASET_ID = (
         SELECT DATASET_ID FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
         WHERE REGION = ${escVal(region)}
           AND VEHICLE_TYPE = ${escVal(vehicleType)}
         ORDER BY CREATED_AT DESC
         LIMIT 1
       )`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    activeReassigned = Number((upd[0] as any)?.['number of rows updated'] ?? 0) > 0;
  }
  return { datasetId, deleted, activeReassigned };
}

// Make Data Studio runs non-destructive on natural-key tables. Each run is
// recorded as an immutable dataset in FLEET_INTELLIGENCE.CORE.DIM_DATASETS
// keyed by JOB_ID; at most one row per (REGION, VEHICLE_TYPE) is IS_ACTIVE.
// Downstream consumers read from V_*_CURRENT views which join to
// DIM_DATASETS and filter on IS_ACTIVE = TRUE — so prior runs stay queryable
// by JOB_ID without polluting the live UI.
//
// FACT_TRIPS, FACT_VEHICLE_TELEMETRY, DIM_TRIP_SCHEDULE keep their existing
// append-only semantics; the *_CURRENT views also filter them by active
// JOB_ID.
//
// archivePriorDatasets is the non-destructive replacement for legacy
// region-scoped DELETEs that used to wipe DIM_POIS / DIM_FLEET /
// FACT_FREIGHT_OFFERS / DIM_PARTNERS / FACT_PARTNER_HISTORY across ALL
// datasets in a region.
//
// INVARIANT: All destructive cleanup of fact/dim rows MUST be scoped by
// JOB_ID — never by REGION or (REGION, VEHICLE_TYPE). Each preset /
// generation run is an independent dataset keyed by JOB_ID; deleting one
// preset's data must never touch another preset's rows. The only
// JOB_ID-scoped destructive helper is deleteJobData() above. Do not add
// region-wide DELETE helpers here without changing the data model.
async function archivePriorDatasets(
  snowSql: SnowSqlFn,
  region: string,
  vehicleType: string,
  newJobId: string,
  label: string,
): Promise<void> {
  try {
    await snowSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
       SET IS_ACTIVE = FALSE
       WHERE REGION = ${escVal(region)}
         AND VEHICLE_TYPE = ${escVal(vehicleType)}
         AND IS_ACTIVE = TRUE`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
  } catch (e: any) {
    log('WARN', 'Studio',
        `archivePriorDatasets UPDATE failed for ${region}/${vehicleType} (non-fatal): ${e.message?.slice(0, 200)}`,
        { jobId: newJobId });
  }
  try {
    await snowSql(
      `INSERT INTO FLEET_INTELLIGENCE.CORE.DIM_DATASETS
         (DATASET_ID, REGION, VEHICLE_TYPE, LABEL, IS_ACTIVE)
       SELECT ${escVal(newJobId)}, ${escVal(region)}, ${escVal(vehicleType)},
              ${escVal(label)}, TRUE`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
  } catch (e: any) {
    log('WARN', 'Studio',
        `archivePriorDatasets INSERT failed for ${region}/${vehicleType} (non-fatal): ${e.message?.slice(0, 200)}`,
        { jobId: newJobId });
  }
}

// Revert archivePriorDatasets when a job fails before producing any data.
// Removes the just-inserted DIM_DATASETS row for newJobId and re-activates
// the most recent prior dataset for the same (REGION, VEHICLE_TYPE), so the
// failed run never appears as the active dataset and the previous active
// dataset is restored.
async function revertArchivePriorDatasets(
  snowSql: SnowSqlFn,
  region: string,
  vehicleType: string,
  newJobId: string,
): Promise<void> {
  try {
    await snowSql(
      `DELETE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE DATASET_ID = ${escVal(newJobId)}`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
  } catch (e: any) {
    log('WARN', 'Studio',
        `revertArchivePriorDatasets DELETE failed for ${newJobId} (non-fatal): ${e.message?.slice(0, 200)}`,
        { jobId: newJobId });
  }
  try {
    // Re-activate the most recent remaining dataset for this scope.
    await snowSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
       SET IS_ACTIVE = TRUE
       WHERE DATASET_ID = (
         SELECT DATASET_ID
         FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS
         WHERE REGION = ${escVal(region)}
           AND VEHICLE_TYPE = ${escVal(vehicleType)}
         ORDER BY CREATED_AT DESC
         LIMIT 1
       )`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
  } catch (e: any) {
    log('WARN', 'Studio',
        `revertArchivePriorDatasets restore-prior failed for ${region}/${vehicleType} (non-fatal): ${e.message?.slice(0, 200)}`,
        { jobId: newJobId });
  }
}

// Recompute ROW_COUNTS on DIM_DATASETS after a job's inserts complete.
// Best-effort — failure does not affect the job outcome.
async function updateDatasetRowCounts(
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<void> {
  try {
    await snowSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.DIM_DATASETS
       SET ROW_COUNTS = OBJECT_CONSTRUCT(
         'pois',      (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS              WHERE JOB_ID = ${escVal(jobId)}),
         'fleet',     (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET             WHERE JOB_ID = ${escVal(jobId)}),
         'offers',    (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_FREIGHT_OFFERS   WHERE JOB_ID = ${escVal(jobId)}),
         'partners',  (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_PARTNERS          WHERE JOB_ID = ${escVal(jobId)}),
         'history',   (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_PARTNER_HISTORY  WHERE JOB_ID = ${escVal(jobId)}),
         'trip_schedule', (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.DIM_TRIP_SCHEDULE WHERE JOB_ID = ${escVal(jobId)}),
         'places',    (SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES WHERE JOB_ID = ${escVal(jobId)}),
         'trips',     (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS            WHERE JOB_ID = ${escVal(jobId)}),
         'telemetry', (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY WHERE JOB_ID = ${escVal(jobId)})
       )
       WHERE DATASET_ID = ${escVal(jobId)}`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
  } catch (e: any) {
    log('WARN', 'Studio',
        `updateDatasetRowCounts failed for ${jobId} (non-fatal): ${e.message?.slice(0, 200)}`,
        { jobId });
  }
}

// NOTE: A region-scoped clearRegionScope() helper used to live here. It
// was removed because (a) it was already unused (deleteDataset() route
// calls deleteJobData() which is JOB_ID-scoped) and (b) its REGION-scoped
// DELETEs would have wiped data across ALL datasets in a region, breaking
// per-preset independence. See the INVARIANT comment above
// archivePriorDatasets. If you need to physically purge a single dataset,
// use deleteJobData(jobId) — it is the only sanctioned destructive helper.

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

// AUTO_SUSPEND pinning for the active studio job is now performed inside
// captureAndScaleUp() / scaleDown() (see ./scaling.ts) so it is region-aware
// and uses captured baselines for symmetric restore. The previous hardcoded
// disableOrsAutoSuspend / restoreOrsAutoSuspend helpers only pinned the
// gateway, the legacy ORS_SERVICE name, and ORS_SERVICE_SANFRANCISCO — they
// never touched the active job's per-region ORS_SERVICE_<REGION>,
// VROOM_SERVICE_<REGION>, or ORS_POOL_<REGION>, which is why ORS could
// auto-suspend mid-run. The new flow guarantees pin and unpin always travel
// together with capture/restore (single source of truth, no drift).

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
// CONFIG tables (DWELL_ANALYSIS, ROUTE_DEVIATION, FLEET_INTELLIGENCE_CAR,
// FLEET_INTELLIGENCE_EBIKE, CATCHMENT, ROUTE_OPTIMIZATION) are
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

      const pois = await loadPOIs(config, snowSql);
      const fleetResult = buildFleetWithDiagnostics(config, pois, createRng(config.fleet.num_vehicles * 31));
      const fleet = fleetResult.fleet;
      // Freight marketplace data (offers / partners / lane history) is generated
      // only for modes that declare generates_freight. Defaults to ON when unset
      // (back-compat for saved presets); the built-in car/e-bike templates set
      // it false so non-freight modes don't get semantically meaningless offers.
      const wantsFreight = config.generates_freight !== false;
      const partners = wantsFreight ? generatePartners(config, 80) : [];
      const partnerHistory = wantsFreight ? generatePartnerHistory(partners, config, 6) : [];
      const offerCount = Math.max(1, Math.floor(Number(config.offers?.count ?? 300)));
      const offers = wantsFreight ? generateFreightOffers(pois, config, offerCount, partners) : [];

      // Region-agnostic spatial spread diagnostics. Logged once at fleet build
      // time so users can verify on any of the 5,194 regions in REGION_CATALOG
      // that homes spread across multiple bins.
      const ssEnabled = config.spatial_spread?.enabled !== false;
      const effBinDeg = fleetResult.diagnostics.bin_deg;
      const poiSpread = ssEnabled ? spreadStats(pois, effBinDeg) : { populated_bins: 0, top_bin_share: 0, median_per_bin: 0 };
      const homeSpread = ssEnabled ? spreadStats(fleet.map(m => ({ lat: m.home_poi.lat, lng: m.home_poi.lng })), effBinDeg) : { populated_bins: 0, top_bin_share: 0, median_per_bin: 0 };
      log('INFO', 'Studio', `Spatial spread: bin_deg=${effBinDeg}, area_km2=${config.region_area_km2}, POI bins=${poiSpread.populated_bins} (top_share=${poiSpread.top_bin_share.toFixed(3)}), home bins=${homeSpread.populated_bins} (top_share=${homeSpread.top_bin_share.toFixed(3)}), stratification=${fleetResult.diagnostics.stratification_used}`, {
        jobId,
        detail: {
          bin_deg: effBinDeg,
          region_area_km2: config.region_area_km2,
          poi_populated_bins: poiSpread.populated_bins,
          poi_top_bin_share: poiSpread.top_bin_share,
          home_populated_bins: homeSpread.populated_bins,
          home_top_bin_share: homeSpread.top_bin_share,
          home_vehicles_per_bin_p50: fleetResult.diagnostics.vehicles_per_bin_p50,
          home_vehicles_per_bin_p95: fleetResult.diagnostics.vehicles_per_bin_p95,
          stratification_used: fleetResult.diagnostics.stratification_used,
          total_home_pois: fleetResult.diagnostics.total_home_pois,
          distance_distribution: config.distance_distribution,
        },
      });
      broadcast(job, 'progress', { status: `Spatial spread: ${homeSpread.populated_bins} home bins, top_share=${(homeSpread.top_bin_share * 100).toFixed(1)}% (bin=${effBinDeg} deg)` });

      // Dataset versioning (FLIP-LAST):
      // We INSERT all dimension/freight rows under the new JOB_ID FIRST, then
      // flip DIM_DATASETS.IS_ACTIVE at the very end of this block. This keeps
      // the previously-active dataset visible to downstream demos (Backload
      // Matching, Freight Exchange, Fleet Intelligence, Asset Velocity) for
      // the entire ~5-30s window during which the new data is being inserted,
      // and switches them atomically to the new dataset only once it is fully
      // populated. The new JOB_ID's rows live in the base tables but are
      // invisible to V_*_CURRENT views until the flip happens.
      // Old rows STAY IN PLACE forever and remain queryable by JOB_ID via the
      // bottom Datasets panel. Physical purge is via DELETE /api/studio/datasets/:id.
      const datasetLabel = `${presetName} @ ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

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
      try {
        const n = await insertDimPartners(partners, config, snowSql, jobId);
        log('INFO', 'Studio', `Inserted ${n} partners`, { jobId });
        broadcast(job, 'progress', { status: `Inserted ${n} partners` });
      } catch (e: any) {
        log('WARN', 'Studio', `DIM_PARTNERS insert failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
        broadcast(job, 'warning', { message: `DIM_PARTNERS insert failed: ${e.message?.slice(0, 150)}` });
      }
      try {
        const n = await insertFactPartnerHistory(partnerHistory, config, snowSql, jobId);
        log('INFO', 'Studio', `Inserted ${n} partner-history rows`, { jobId });
        broadcast(job, 'progress', { status: `Inserted ${n} partner-history rows` });
      } catch (e: any) {
        log('WARN', 'Studio', `FACT_PARTNER_HISTORY insert failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
        broadcast(job, 'warning', { message: `FACT_PARTNER_HISTORY insert failed: ${e.message?.slice(0, 150)}` });
      }

      // Universal-generation entities (Overture + free Marketplace). Each is
      // gated by a generates_* flag (default off) so existing presets are
      // unchanged. All write region-scoped, JOB_ID-versioned rows BEFORE the
      // atomic dataset flip below, so they join the new active dataset.
      if (config.generates_anchors) {
        try {
          const n = await generateAnchors(config, snowSql, jobId);
          log('INFO', 'Studio', `Inserted ${n} anchors`, { jobId });
          broadcast(job, 'progress', { status: `Inserted ${n} anchors` });
        } catch (e: any) {
          log('WARN', 'Studio', `DIM_ANCHORS generation failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
          broadcast(job, 'warning', { message: `Anchors generation failed: ${e.message?.slice(0, 150)}` });
        }
      }
      if (config.generates_demographics) {
        try {
          const n = await generateDemographics(config, snowSql, jobId);
          log('INFO', 'Studio', `Inserted ${n} demographic areas`, { jobId });
          broadcast(job, 'progress', { status: `Inserted ${n} demographic areas` });
        } catch (e: any) {
          log('WARN', 'Studio', `DIM_AREA_DEMOGRAPHICS generation failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
          broadcast(job, 'warning', { message: `Demographics generation failed: ${e.message?.slice(0, 150)}` });
        }
      }
      if (config.generates_hazard) {
        try {
          const n = await generateHazardZones(config, snowSql, jobId);
          log('INFO', 'Studio', `Inserted ${n} hazard zones`, { jobId });
          broadcast(job, 'progress', { status: `Inserted ${n} hazard zones` });
        } catch (e: any) {
          log('WARN', 'Studio', `FACT_HAZARD_ZONES generation failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
          broadcast(job, 'warning', { message: `Hazard generation failed: ${e.message?.slice(0, 150)}` });
        }
      }
      if (config.generates_demand) {
        try {
          const n = await generateDemandCatalog(config, snowSql, jobId);
          log('INFO', 'Studio', `Inserted ${n} demand-catalog items`, { jobId });
          broadcast(job, 'progress', { status: `Inserted ${n} demand-catalog items` });
        } catch (e: any) {
          log('WARN', 'Studio', `DIM_DEMAND_CATALOG generation failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
          broadcast(job, 'warning', { message: `Demand catalog generation failed: ${e.message?.slice(0, 150)}` });
        }
      }

      // Atomic switchover: now that all dimension/freight tables for this run
      // are fully populated, flip the active dataset pointer. From this
      // millisecond onwards, V_*_CURRENT views project the new dataset.
      await archivePriorDatasets(snowSql, config.region, vt, jobId, datasetLabel);
      broadcast(job, 'progress', {
        status: `Activated new dataset for ${config.region} / ${vt} (prior datasets kept queryable; jobId = ${jobId})`,
      });
      try {
        await ensureRouteOptimizationSeedData(snowSql, config.region, jobId);
      } catch (e: any) {
        log('WARN', 'Studio', `Route optimization seed failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
      }
      try {
        await precomputeOfferRoutes(snowSql, config.region, config.ors_profile, jobId);
      } catch (e: any) {
        log('WARN', 'Studio', `Offer-route precompute failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
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
              const batch = pendingTrips.splice(0);
              await insertTripBatch(batch, snowSql, jobId);
              await insertTripScheduleBatch(batch, snowSql, jobId);
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
          await insertTripScheduleBatch(pendingTrips, snowSql, jobId);
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
      // Always refresh ROW_COUNTS on the dataset registry so the Studio UI
      // can show row counts per archived dataset (POIs, fleet, offers,
      // partners, history, trips, telemetry). Best-effort.
      await updateDatasetRowCounts(snowSql, jobId);
    } catch (e: any) {
      job.status = 'FAILED';
      job.error = e.message;
      job.completedAt = new Date();
      log('ERROR', 'Studio', `Job ${jobId} failed: ${e.message?.slice(0, 300)}`, { jobId });
      broadcast(job, 'error', { error: e.message });
      // If the job failed before any data was actually written, revert the
      // archive: remove the new DIM_DATASETS row and re-activate the prior
      // one so the user is not left with an empty active dataset.
      if ((job.pointsGenerated || 0) === 0 && (job.tripsGenerated || 0) === 0) {
        try {
          await revertArchivePriorDatasets(snowSql, config.region, vt, jobId);
          log('INFO', 'Studio', `Reverted dataset archive for failed empty job ${jobId}`, { jobId });
        } catch (_e: any) { /* best-effort */ }
      }
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
      try { await persistJobLog(job, snowSql); } catch (_) { /* best-effort */ }
    }
  })();

  return jobId;
}
