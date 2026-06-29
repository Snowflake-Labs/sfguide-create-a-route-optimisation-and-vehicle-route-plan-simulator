import { log } from '../diagnostics';
import { normalizeRegion } from '../lib/region';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

export type ScalingState = {
  regionPoolName: string | null;
  regionSvcName: string | null;
  vroomSvcName: string | null;
  origRegionPoolMaxNodes: number | null;
  origRegionSvcMin: number | null;
  origRegionSvcMax: number | null;
  origGatewayPoolMaxNodes: number | null;
  origGatewaySvcMin: number | null;
  origGatewaySvcMax: number | null;
  // AUTO_SUSPEND_SECS baselines captured at start, restored on exit. Pinning
  // these to 0 for the duration of the studio run is what prevents
  // ORS_SERVICE_<REGION> / VROOM_SERVICE_<REGION> / ORS_POOL_<REGION> from
  // auto-suspending during a brief between-day idle window. Without this
  // pinning the global RECONCILE_AUTO_SUSPEND() safety net is the only line of
  // defense, and historically it did not know about studio jobs.
  origGatewayAutoSuspend: number | null;
  origRegionSvcAutoSuspend: number | null;
  origVroomSvcAutoSuspend: number | null;
  origRegionPoolAutoSuspend: number | null;
};

const TARGET_REGION_NODES = 4;
const TARGET_REGION_INSTANCES = 4;
const TARGET_GATEWAY_NODES = 8;
const TARGET_GATEWAY_INSTANCES = 8;
const ORS_READY_MAX_ATTEMPTS = 24;
const ORS_READY_INTERVAL_MS = 15_000;

// Steady-state defaults used as a fallback restore value when the original
// AUTO_SUSPEND_SECS could not be captured (best-effort SHOW failed, service
// did not exist yet, etc). These match the AGENTS.md AUTO_SUSPEND invariant:
// services = 14400 (4h), per-region pools = 3600 (1h).
const DEFAULT_SVC_AUTO_SUSPEND = 14400;
const DEFAULT_POOL_AUTO_SUSPEND = 3600;

export function pickFirstNumber(rows: any[], keys: string[]): number | null {
  if (!rows || rows.length === 0) return null;
  const r = rows[0];
  for (const k of keys) {
    if (r[k] !== undefined && r[k] !== null) {
      const n = Number(r[k]);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

export async function captureAndScaleUp(snowSql: SnowSqlFn, region: string): Promise<ScalingState> {
  const state: ScalingState = {
    regionPoolName: null,
    regionSvcName: null,
    vroomSvcName: null,
    origRegionPoolMaxNodes: null,
    origRegionSvcMin: null,
    origRegionSvcMax: null,
    origGatewayPoolMaxNodes: null,
    origGatewaySvcMin: null,
    origGatewaySvcMax: null,
    origGatewayAutoSuspend: null,
    origRegionSvcAutoSuspend: null,
    origVroomSvcAutoSuspend: null,
    origRegionPoolAutoSuspend: null,
  };

  const resolvedRegion = normalizeRegion(region);
  const upperRegion = resolvedRegion.toUpperCase();
  state.regionPoolName = `ORS_POOL_${upperRegion}`;
  state.regionSvcName = `ORS_SERVICE_${upperRegion}`;
  state.vroomSvcName = `VROOM_SERVICE_${upperRegion}`;

  // ---- Capture per-region pool sizing + AUTO_SUSPEND_SECS ----
  try {
    await snowSql(`SHOW COMPUTE POOLS LIKE '${state.regionPoolName}'`);
    const rows = await snowSql(`SELECT "max_nodes", "auto_suspend_secs" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origRegionPoolMaxNodes = pickFirstNumber(rows, ['max_nodes', 'MAX_NODES']);
    state.origRegionPoolAutoSuspend = pickFirstNumber(rows, ['auto_suspend_secs', 'AUTO_SUSPEND_SECS']);
  } catch (_) { /* best-effort */ }

  // ---- Capture per-region ORS_SERVICE sizing + AUTO_SUSPEND_SECS ----
  try {
    await snowSql(`SHOW SERVICES LIKE '${state.regionSvcName}' IN SCHEMA OPENROUTESERVICE_APP.CORE`);
    const rows = await snowSql(`SELECT "min_instances", "max_instances", "auto_suspend_secs" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origRegionSvcMin = pickFirstNumber(rows, ['min_instances', 'MIN_INSTANCES']);
    state.origRegionSvcMax = pickFirstNumber(rows, ['max_instances', 'MAX_INSTANCES']);
    state.origRegionSvcAutoSuspend = pickFirstNumber(rows, ['auto_suspend_secs', 'AUTO_SUSPEND_SECS']);
  } catch (_) { /* best-effort */ }

  // ---- Capture per-region VROOM_SERVICE AUTO_SUSPEND_SECS ----
  try {
    await snowSql(`SHOW SERVICES LIKE '${state.vroomSvcName}' IN SCHEMA OPENROUTESERVICE_APP.CORE`);
    const rows = await snowSql(`SELECT "auto_suspend_secs" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origVroomSvcAutoSuspend = pickFirstNumber(rows, ['auto_suspend_secs', 'AUTO_SUSPEND_SECS']);
  } catch (_) { /* best-effort */ }

  // ---- Pin per-region pool to AUTO_SUSPEND_SECS=0 + scale up MAX_NODES ----
  try {
    await snowSql(`ALTER COMPUTE POOL IF EXISTS ${state.regionPoolName} SET AUTO_SUSPEND_SECS = 0`);
  } catch (_) { /* best-effort */ }
  try {
    await snowSql(`ALTER COMPUTE POOL ${state.regionPoolName} SET MAX_NODES = ${TARGET_REGION_NODES}`);
  } catch (_) { /* best-effort */ }
  // ---- Pin per-region ORS_SERVICE to AUTO_SUSPEND_SECS=0 + scale instances ----
  try {
    await snowSql(`ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.${state.regionSvcName} SET AUTO_SUSPEND_SECS = 0`);
  } catch (_) { /* best-effort */ }
  try {
    await snowSql(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.${state.regionSvcName} SET MIN_INSTANCES = ${TARGET_REGION_INSTANCES} MAX_INSTANCES = ${TARGET_REGION_INSTANCES}`);
  } catch (_) { /* best-effort */ }
  // ---- Pin per-region VROOM_SERVICE to AUTO_SUSPEND_SECS=0 ----
  try {
    await snowSql(`ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.${state.vroomSvcName} SET AUTO_SUSPEND_SECS = 0`);
  } catch (_) { /* best-effort */ }

  // ---- Capture gateway pool sizing ----
  try {
    await snowSql(`SHOW COMPUTE POOLS LIKE 'OPENROUTESERVICE_APP_COMPUTE_POOL'`);
    const rows = await snowSql(`SELECT "max_nodes" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origGatewayPoolMaxNodes = pickFirstNumber(rows, ['max_nodes', 'MAX_NODES']);
  } catch (_) { /* best-effort */ }

  // ---- Capture gateway service sizing + AUTO_SUSPEND_SECS ----
  try {
    await snowSql(`SHOW SERVICES LIKE 'ROUTING_GATEWAY_SERVICE' IN SCHEMA OPENROUTESERVICE_APP.CORE`);
    const rows = await snowSql(`SELECT "min_instances", "max_instances", "auto_suspend_secs" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origGatewaySvcMin = pickFirstNumber(rows, ['min_instances', 'MIN_INSTANCES']);
    state.origGatewaySvcMax = pickFirstNumber(rows, ['max_instances', 'MAX_INSTANCES']);
    state.origGatewayAutoSuspend = pickFirstNumber(rows, ['auto_suspend_secs', 'AUTO_SUSPEND_SECS']);
  } catch (_) { /* best-effort */ }

  // ---- Pin gateway service to AUTO_SUSPEND_SECS=0 + scale up ----
  try {
    await snowSql(`ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ${TARGET_GATEWAY_NODES}`);
  } catch (_) { /* best-effort */ }
  try {
    await snowSql(`ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE SET AUTO_SUSPEND_SECS = 0`);
  } catch (_) { /* best-effort */ }
  try {
    await snowSql(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE SET MIN_INSTANCES = ${TARGET_GATEWAY_INSTANCES} MAX_INSTANCES = ${TARGET_GATEWAY_INSTANCES}`);
  } catch (_) { /* best-effort */ }

  log('INFO', 'Studio', 'Scaled compute pools up + pinned AUTO_SUSPEND for generation', {
    region: region || 'DEFAULT',
    targets: { regionNodes: TARGET_REGION_NODES, regionInstances: TARGET_REGION_INSTANCES, gatewayNodes: TARGET_GATEWAY_NODES, gatewayInstances: TARGET_GATEWAY_INSTANCES },
    captured: state as any,
  } as any);
  return state;
}

export async function scaleDown(snowSql: SnowSqlFn, state: ScalingState | null): Promise<void> {
  if (!state) return;

  // ---- Restore per-region pool MAX_NODES + AUTO_SUSPEND_SECS ----
  if (state.regionPoolName && state.origRegionPoolMaxNodes !== null) {
    try {
      await snowSql(`ALTER COMPUTE POOL ${state.regionPoolName} SET MAX_NODES = ${state.origRegionPoolMaxNodes}`);
    } catch (_) { /* best-effort */ }
  }
  if (state.regionPoolName) {
    const target = state.origRegionPoolAutoSuspend !== null ? state.origRegionPoolAutoSuspend : DEFAULT_POOL_AUTO_SUSPEND;
    try {
      await snowSql(`ALTER COMPUTE POOL IF EXISTS ${state.regionPoolName} SET AUTO_SUSPEND_SECS = ${target}`);
    } catch (_) { /* best-effort */ }
  }

  // ---- Restore per-region ORS_SERVICE instances + AUTO_SUSPEND_SECS ----
  if (state.regionSvcName && state.origRegionSvcMin !== null && state.origRegionSvcMax !== null) {
    try {
      await snowSql(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.${state.regionSvcName} SET MIN_INSTANCES = ${state.origRegionSvcMin} MAX_INSTANCES = ${state.origRegionSvcMax}`);
    } catch (_) { /* best-effort */ }
  }
  if (state.regionSvcName) {
    const target = state.origRegionSvcAutoSuspend !== null ? state.origRegionSvcAutoSuspend : DEFAULT_SVC_AUTO_SUSPEND;
    try {
      await snowSql(`ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.${state.regionSvcName} SET AUTO_SUSPEND_SECS = ${target}`);
    } catch (_) { /* best-effort */ }
  }

  // ---- Restore per-region VROOM_SERVICE AUTO_SUSPEND_SECS ----
  if (state.vroomSvcName) {
    const target = state.origVroomSvcAutoSuspend !== null ? state.origVroomSvcAutoSuspend : DEFAULT_SVC_AUTO_SUSPEND;
    try {
      await snowSql(`ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.${state.vroomSvcName} SET AUTO_SUSPEND_SECS = ${target}`);
    } catch (_) { /* best-effort */ }
  }

  // ---- Restore gateway pool MAX_NODES ----
  if (state.origGatewayPoolMaxNodes !== null) {
    try {
      await snowSql(`ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ${state.origGatewayPoolMaxNodes}`);
    } catch (_) { /* best-effort */ }
  }

  // ---- Restore gateway service instances + AUTO_SUSPEND_SECS ----
  if (state.origGatewaySvcMin !== null && state.origGatewaySvcMax !== null) {
    try {
      await snowSql(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE SET MIN_INSTANCES = ${state.origGatewaySvcMin} MAX_INSTANCES = ${state.origGatewaySvcMax}`);
    } catch (_) { /* best-effort */ }
  }
  // Gateway service AUTO_SUSPEND default is 0 (it has public endpoints and is
  // pinned at 0 in steady state per the AGENTS.md invariant). Restore the
  // captured value verbatim; if capture failed, leave it at 0 since that is
  // also the steady-state default for this service.
  {
    const target = state.origGatewayAutoSuspend !== null ? state.origGatewayAutoSuspend : 0;
    try {
      await snowSql(`ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE SET AUTO_SUSPEND_SECS = ${target}`);
    } catch (_) { /* best-effort */ }
  }

  log('INFO', 'Studio', 'Scaled compute pools back down + restored AUTO_SUSPEND after generation', {
    restored: {
      regionPool: state.origRegionPoolAutoSuspend,
      regionSvc: state.origRegionSvcAutoSuspend,
      vroomSvc: state.origVroomSvcAutoSuspend,
      gatewaySvc: state.origGatewayAutoSuspend,
    },
  } as any);
}

export async function waitForOrsReady(snowSql: SnowSqlFn, region: string, profile: string): Promise<void> {
  const resolvedRegion = normalizeRegion(region);
  for (let attempt = 0; attempt < ORS_READY_MAX_ATTEMPTS; attempt++) {
    try {
      const sql = `SELECT TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS('${resolvedRegion}')) AS S`;
      const rows = await snowSql(sql);
      const raw = rows?.[0]?.S || rows?.[0]?.s || '';
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.profiles && parsed.profiles[profile]) {
          log('INFO', 'Studio', `ORS profile ${profile} ready after ${attempt * (ORS_READY_INTERVAL_MS / 1000)}s`);
          return;
        }
      }
    } catch (_) { /* best-effort */ }
    await new Promise(resolve => setTimeout(resolve, ORS_READY_INTERVAL_MS));
  }
  log('WARN', 'Studio', `ORS profile ${profile} did not report ready within ${ORS_READY_MAX_ATTEMPTS * (ORS_READY_INTERVAL_MS / 1000)}s; continuing anyway`);
}
