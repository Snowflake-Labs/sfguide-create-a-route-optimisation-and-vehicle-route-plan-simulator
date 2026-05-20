import { log } from '../diagnostics.js';
import { normalizeRegion } from '../lib/region.js';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

export type ScalingState = {
  regionPoolName: string | null;
  regionSvcName: string | null;
  origRegionPoolMaxNodes: number | null;
  origRegionSvcMin: number | null;
  origRegionSvcMax: number | null;
  origGatewayPoolMaxNodes: number | null;
  origGatewaySvcMin: number | null;
  origGatewaySvcMax: number | null;
};

const TARGET_REGION_NODES = 4;
const TARGET_REGION_INSTANCES = 4;
const TARGET_GATEWAY_NODES = 8;
const TARGET_GATEWAY_INSTANCES = 8;
const ORS_READY_MAX_ATTEMPTS = 8;
const ORS_READY_INTERVAL_MS = 15_000;

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
    origRegionPoolMaxNodes: null,
    origRegionSvcMin: null,
    origRegionSvcMax: null,
    origGatewayPoolMaxNodes: null,
    origGatewaySvcMin: null,
    origGatewaySvcMax: null,
  };

  const resolvedRegion = normalizeRegion(region);
  const upperRegion = resolvedRegion.toUpperCase();
  state.regionPoolName = `ORS_POOL_${upperRegion}`;
  state.regionSvcName = `ORS_SERVICE_${upperRegion}`;

  try {
    await snowSql(`SHOW COMPUTE POOLS LIKE '${state.regionPoolName}'`);
    const rows = await snowSql(`SELECT "max_nodes" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origRegionPoolMaxNodes = pickFirstNumber(rows, ['max_nodes', 'MAX_NODES']);
  } catch (_) { /* best-effort */ }

  try {
    await snowSql(`SHOW SERVICES LIKE '${state.regionSvcName}' IN SCHEMA OPENROUTESERVICE_APP.CORE`);
    const rows = await snowSql(`SELECT "min_instances", "max_instances" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origRegionSvcMin = pickFirstNumber(rows, ['min_instances', 'MIN_INSTANCES']);
    state.origRegionSvcMax = pickFirstNumber(rows, ['max_instances', 'MAX_INSTANCES']);
  } catch (_) { /* best-effort */ }

  try {
    await snowSql(`ALTER COMPUTE POOL ${state.regionPoolName} SET MAX_NODES = ${TARGET_REGION_NODES}`);
  } catch (_) { /* best-effort */ }
  try {
    await snowSql(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.${state.regionSvcName} SET MIN_INSTANCES = ${TARGET_REGION_INSTANCES} MAX_INSTANCES = ${TARGET_REGION_INSTANCES}`);
  } catch (_) { /* best-effort */ }

  try {
    await snowSql(`SHOW COMPUTE POOLS LIKE 'OPENROUTESERVICE_APP_COMPUTE_POOL'`);
    const rows = await snowSql(`SELECT "max_nodes" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origGatewayPoolMaxNodes = pickFirstNumber(rows, ['max_nodes', 'MAX_NODES']);
  } catch (_) { /* best-effort */ }

  try {
    await snowSql(`SHOW SERVICES LIKE 'ROUTING_GATEWAY_SERVICE' IN SCHEMA OPENROUTESERVICE_APP.CORE`);
    const rows = await snowSql(`SELECT "min_instances", "max_instances" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1`);
    state.origGatewaySvcMin = pickFirstNumber(rows, ['min_instances', 'MIN_INSTANCES']);
    state.origGatewaySvcMax = pickFirstNumber(rows, ['max_instances', 'MAX_INSTANCES']);
  } catch (_) { /* best-effort */ }

  try {
    await snowSql(`ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ${TARGET_GATEWAY_NODES}`);
  } catch (_) { /* best-effort */ }
  try {
    await snowSql(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE SET MIN_INSTANCES = ${TARGET_GATEWAY_INSTANCES} MAX_INSTANCES = ${TARGET_GATEWAY_INSTANCES}`);
  } catch (_) { /* best-effort */ }

  log('INFO', 'Studio', 'Scaled compute pools up for generation', {
    region: region || 'DEFAULT',
    targets: { regionNodes: TARGET_REGION_NODES, regionInstances: TARGET_REGION_INSTANCES, gatewayNodes: TARGET_GATEWAY_NODES, gatewayInstances: TARGET_GATEWAY_INSTANCES },
    captured: state as any,
  } as any);
  return state;
}

export async function scaleDown(snowSql: SnowSqlFn, state: ScalingState | null): Promise<void> {
  if (!state) return;

  if (state.regionPoolName && state.origRegionPoolMaxNodes !== null) {
    try {
      await snowSql(`ALTER COMPUTE POOL ${state.regionPoolName} SET MAX_NODES = ${state.origRegionPoolMaxNodes}`);
    } catch (_) { /* best-effort */ }
  }
  if (state.regionSvcName && state.origRegionSvcMin !== null && state.origRegionSvcMax !== null) {
    try {
      await snowSql(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.${state.regionSvcName} SET MIN_INSTANCES = ${state.origRegionSvcMin} MAX_INSTANCES = ${state.origRegionSvcMax}`);
    } catch (_) { /* best-effort */ }
  }
  if (state.origGatewayPoolMaxNodes !== null) {
    try {
      await snowSql(`ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ${state.origGatewayPoolMaxNodes}`);
    } catch (_) { /* best-effort */ }
  }
  if (state.origGatewaySvcMin !== null && state.origGatewaySvcMax !== null) {
    try {
      await snowSql(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE SET MIN_INSTANCES = ${state.origGatewaySvcMin} MAX_INSTANCES = ${state.origGatewaySvcMax}`);
    } catch (_) { /* best-effort */ }
  }

  log('INFO', 'Studio', 'Scaled compute pools back down after generation');
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
