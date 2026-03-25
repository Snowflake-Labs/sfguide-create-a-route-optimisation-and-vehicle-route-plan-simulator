import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStudioRouter } from './studio/routes.js';

config();

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.stack || err.message);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('UNHANDLED REJECTION:', reason?.stack || reason?.message || reason);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const IS_SPCS = existsSync('/snowflake/session/token');

const SF_DATABASE = process.env.SNOWFLAKE_DATABASE || 'DEMO_DASHBOARD_APP';
const SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || 'ROUTING_ANALYTICS';
const CONN = process.env.SNOWFLAKE_CONNECTION_NAME || 'FREE_TRIAL';
const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';
const MOCK_MODE = process.env.MOCK_MODE === 'true';

function getSpcsToken(): string {
  return readFileSync('/snowflake/session/token', 'utf-8').trim();
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[\d;]*m/g, '');
}

function snowSqlLocal(sql: string, database?: string, schema?: string): any[] {
  const tmpFile = join(tmpdir(), `dash_query_${Date.now()}.sql`);
  const db = database || SF_DATABASE;
  const sc = schema || 'CORE';
  const fullSql = `USE WAREHOUSE ${SF_WAREHOUSE};\nUSE DATABASE ${db};\nUSE SCHEMA ${sc};\n${sql};`;
  writeFileSync(tmpFile, fullSql);
  try {
    const cmd = `snow sql -c ${CONN} -f "${tmpFile}" --format json 2>/dev/null`;
    const result = execSync(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000, encoding: 'utf-8' });
    const parsed = JSON.parse(result.trim());
    if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
      return parsed[parsed.length - 1];
    }
    return parsed;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function snowSqlSpcs(sql: string, database?: string, schema?: string, timeoutSecs: number = 600): Promise<any[]> {
  const token = getSpcsToken();
  const host = SNOWFLAKE_HOST;
  const statementsUrl = `https://${host}/api/v2/statements`;
  const body = {
    statement: sql,
    timeout: timeoutSecs,
    database: database || SF_DATABASE,
    schema: schema || 'CORE',
    warehouse: SF_WAREHOUSE,
  };
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };

  const res = await fetch(statementsUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text();
    if (errText.toLowerCase().includes('upstream request timeout')) {
      throw new Error('Request timed out — the query took too long. Please try a simpler question or try again.');
    }
    throw new Error(`Snowflake SQL API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const resText = await res.text();
  let result: any;
  try {
    result = JSON.parse(resText);
  } catch {
    if (resText.toLowerCase().includes('upstream request timeout')) {
      throw new Error('Request timed out — the query took too long. Please try a simpler question or try again.');
    }
    throw new Error(`Unexpected non-JSON response from SQL API: ${resText.slice(0, 200)}`);
  }

  if (result.statementStatusUrl && (!result.data || result.code === '333334')) {
    const pollUrl = `https://${host}${result.statementStatusUrl}`;
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const pollRes = await fetch(pollUrl, { method: 'GET', headers });
      if (!pollRes.ok) {
        const errText = await pollRes.text();
        if (errText.toLowerCase().includes('upstream request timeout')) {
          throw new Error('Request timed out — the query took too long. Please try a simpler question or try again.');
        }
        throw new Error(`Snowflake poll error ${pollRes.status}: ${errText.slice(0, 500)}`);
      }
      const pollText = await pollRes.text();
      try {
        result = JSON.parse(pollText);
      } catch {
        if (pollText.toLowerCase().includes('upstream request timeout')) {
          throw new Error('Request timed out — the query took too long. Please try a simpler question or try again.');
        }
        throw new Error(`Unexpected non-JSON poll response: ${pollText.slice(0, 200)}`);
      }
      if (result.data || (result.statementStatusUrl == null && result.message !== 'Statement is still running.')) break;
      if (result.message?.includes('error') || result.code === '000001') {
        throw new Error(`Query failed: ${result.message?.slice(0, 500)}`);
      }
    }
  }

  if (!result.data) return [];

  const columns = result.resultSetMetaData?.rowType?.map((c: any) => c.name) || [];
  let allData = [...result.data];
  const partitions = result.resultSetMetaData?.partitionInfo || [];
  const statementHandle = result.statementHandle;

  if (partitions.length > 1 && statementHandle) {
    for (let p = 1; p < partitions.length; p++) {
      const partUrl = `https://${host}/api/v2/statements/${statementHandle}?partition=${p}`;
      const partRes = await fetch(partUrl, { method: 'GET', headers });
      if (partRes.ok) {
        const partData: any = await partRes.json();
        if (partData.data) allData = allData.concat(partData.data);
      }
    }
  }

  return allData.map((row: any[]) => {
    const obj: any = {};
    columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
    return obj;
  });
}

export async function snowSql(sql: string, database?: string, schema?: string): Promise<any[]> {
  if (IS_SPCS) return snowSqlSpcs(sql, database, schema);
  return snowSqlLocal(sql, database, schema);
}

// --- Tile proxy with LRU cache ---
const TILE_CACHE = new Map<string, { data: Buffer; contentType: string; ts: number }>();
const TILE_CACHE_MAX = 5000;

function evictTiles() {
  if (TILE_CACHE.size <= TILE_CACHE_MAX) return;
  const entries = [...TILE_CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const toRemove = entries.slice(0, entries.length - TILE_CACHE_MAX);
  for (const [key] of toRemove) TILE_CACHE.delete(key);
}

app.get('/api/tiles/:z/:x/:y', async (req, res) => {
  const { z, x, y } = req.params;
  const cacheKey = `${z}/${x}/${y}`;
  const cached = TILE_CACHE.get(cacheKey);
  if (cached) {
    cached.ts = Date.now();
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached.data);
  }
  try {
    const tileUrl = `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}@2x.png`;
    const tileRes = await fetch(tileUrl);
    if (!tileRes.ok) return res.status(tileRes.status).send('Tile fetch failed');
    const buffer = Buffer.from(await tileRes.arrayBuffer());
    const contentType = tileRes.headers.get('Content-Type') || 'image/png';
    TILE_CACHE.set(cacheKey, { data: buffer, contentType, ts: Date.now() });
    evictTiles();
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Health check ---
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// --- Registry: map DB demo_id → PageRegistry component ID + route path ---
const PAGE_DEFS: Record<string, { componentId: string; path: string; title: string }> = {
  'dwell-overview':       { componentId: 'dwell-overview',           path: '/dwell/overview',         title: 'Overview' },
  'dwell-congestion':     { componentId: 'dwell-congestion',         path: '/dwell/congestion',       title: 'Congestion Map' },
  'dwell-utilization':    { componentId: 'dwell-facility',           path: '/dwell/utilization',      title: 'Facility Utilization' },
  'dwell-sla':            { componentId: 'dwell-sla',               path: '/dwell/sla',              title: 'SLA Alerts' },
  'dwell-trip':           { componentId: 'dwell-trips',             path: '/dwell/trips',            title: 'Trip Inspector' },
  'dwell-driver':         { componentId: 'dwell-drivers',           path: '/dwell/drivers',          title: 'Driver Performance' },
  'dwell-live':           { componentId: 'dwell-live',              path: '/dwell/live',             title: 'Live Operations' },
  'fleet-map':            { componentId: 'fleet-delivery-map',      path: '/fleet/map',              title: 'Fleet Map' },
  'fleet-data':           { componentId: 'fleet-delivery-builder',  path: '/fleet/data',             title: 'Data Builder' },
  'fleet-matrix':         { componentId: 'fleet-delivery-matrix',   path: '/fleet/matrix',           title: 'Matrix Builder' },
  'fleet-catchment':      { componentId: 'fleet-delivery-catchment',path: '/fleet/catchment',        title: 'Catchment Panel' },
  'taxi-overview':        { componentId: 'fleet-taxis-overview',    path: '/taxis/overview',         title: 'Fleet Overview' },
  'taxi-routes':          { componentId: 'fleet-taxis-drivers',     path: '/taxis/routes',           title: 'Driver Routes' },
  'taxi-heatmap':         { componentId: 'fleet-taxis-heatmap',     path: '/taxis/heatmap',          title: 'Heat Map' },
  'route-opt':            { componentId: 'route-optimization',      path: '/route-optimization',     title: 'Route Optimization' },
  'retail-catch':         { componentId: 'retail-catchment',        path: '/retail-catchment',       title: 'Retail Catchment' },
  'deviation-dashboard':  { componentId: 'route-deviation-dashboard', path: '/deviation/dashboard',  title: 'Deviation Dashboard' },
  'deviation-compare':    { componentId: 'route-deviation-compare', path: '/deviation/compare',      title: 'Route Comparison' },
  'deviation-inspector':  { componentId: 'route-deviation-inspector', path: '/deviation/inspector',  title: 'Route Inspector' },
  'routing-agent':        { componentId: 'routing-agent',           path: '/routing-agent',          title: 'Routing Agent' },
  'travel-time':          { componentId: 'travel-time-matrix',      path: '/travel-time',            title: 'Travel Time Explorer' },
  'data-studio':          { componentId: 'data-studio',             path: '/data-studio',            title: 'Fleet Data Studio' },
};

const ORS_CATEGORIES = new Set(['Route Optimization', 'Fleet Delivery', 'Fleet Taxis', 'Routing Agent', 'Route Deviation']);

const CATEGORY_DEPS: Record<string, { app?: string; schema?: string }> = {
  'Dwell Analysis':     { schema: 'DWELL_ANALYSIS' },
  'Fleet Delivery':     { schema: 'FLEET_INTELLIGENCE_FOOD_DELIVERY' },
  'Fleet Taxis':        { schema: 'FLEET_INTELLIGENCE_TAXIS' },
  'Route Optimization': { schema: 'ROUTE_OPTIMIZATION' },
  'Retail Catchment':   { schema: 'RETAIL_CATCHMENT' },
  'Route Deviation':    { schema: 'ROUTE_DEVIATION' },
  'Routing Agent':      { schema: 'ROUTING_AGENT' },
  'Travel Time Matrix': { app: 'OPENROUTESERVICE_NATIVE_APP' },
  'Data Studio':        {},
};

async function getInstalledDeps(): Promise<{ apps: Set<string>; schemas: Set<string> }> {
  const apps = new Set<string>();
  const schemas = new Set<string>();
  try {
    const appRows = await snowSql('SHOW APPLICATIONS', undefined, undefined);
    for (const r of appRows) apps.add((r.name || '').toUpperCase());
  } catch {}
  try {
    const schemaRows = await snowSql('SHOW SCHEMAS IN DATABASE FLEET_INTELLIGENCE', undefined, undefined);
    for (const r of schemaRows) schemas.add((r.name || '').toUpperCase());
  } catch {}
  return { apps, schemas };
}

const CATEGORY_ICONS: Record<string, string> = {
  'Dwell Analysis': 'clock',
  'Fleet Delivery': 'utensils',
  'Fleet Taxis': 'car-taxi',
  'Route Optimization': 'truck',
  'Retail Catchment': 'store',
  'Route Deviation': 'git-branch',
  'Routing Agent': 'bot',
  'Travel Time Matrix': 'timer',
  'Data Studio': 'database',
};

// --- Mock Mode (no Snowflake needed) ---
if (MOCK_MODE) {
  console.log('🔶 MOCK_MODE enabled — returning fake data for all API endpoints');
  app.get('/api/registry', (_req, res) => {
    res.json([{
      demo_id: 'travel-time-matrix',
      display_name: 'Travel Time Matrix',
      description: 'Mock travel time matrix demo',
      icon: 'timer',
      sort_order: 1,
      source_db: 'MOCK_DB',
      source_schema: 'MOCK_SCHEMA',
      pages: [{ id: 'travel-time-matrix', path: '/travel-time', title: 'Travel Time Explorer' }],
      requires_ors: false,
      installed: true,
      installed_at: '2026-01-01',
      version: '1.0',
      config: {},
    }]);
  });
  app.get('/api/ors/status', (_req, res) => res.json({ installed: false, status: 'not_installed' }));
  app.get('/api/regions', (_req, res) => res.json({
    active: 'SanFrancisco',
    regions: [{
      REGION_NAME: 'SanFrancisco', DISPLAY_NAME: 'San Francisco',
      CENTER_LAT: 37.7749, CENTER_LON: -122.4194,
      BBOX_MIN_LAT: 37.700, BBOX_MAX_LAT: 37.820, BBOX_MIN_LON: -122.520, BBOX_MAX_LON: -122.350,
      ZOOM_LEVEL: 11, ORS_REGION_KEY: null, DATA_SOURCE: 'mock',
    }],
  }));
  app.get('/api/matrix/viewer-inventory', (_req, res) => res.json({ tables: [{
    region: 'SanFrancisco', profile: 'driving-car', resolution: 'RES8',
    row_count: 50000, bytes: 5000000, table_name: 'MOCK_MATRIX_TABLE',
    full_table: 'MOCK_DB.MOCK_SCHEMA.MOCK_MATRIX_TABLE',
  }]}));
  app.get('/api/matrix/random-origin', (_req, res) => res.json({
    origin_hex: '8828308281fffff',
    origin_lat: 37.7749,
    origin_lon: -122.4194,
    global_max_time_secs: 3600,
  }));
  app.get('/api/matrix/all-hexes', (_req, res) => {
    const hexes = ['8828308281fffff', '882830828bfffff', '8828308283fffff', '882830829dfffff',
      '8828308285fffff', '882830828dfffff', '8828308287fffff', '882830829bfffff',
      '8828308289fffff', '8828308295fffff', '882830829ffffff', '8828308291fffff',
      '8828308293fffff', '8828308297fffff', '8828308299fffff'];
    res.json({ hexes });
  });
  app.get('/api/matrix/reachability', (_req, res) => {
    const dests = [
      { HEX_ID: '882830828bfffff', LAT: 37.780, LON: -122.425, TRAVEL_TIME_SECONDS: 120, TRAVEL_DISTANCE_METERS: 1500 },
      { HEX_ID: '8828308283fffff', LAT: 37.770, LON: -122.410, TRAVEL_TIME_SECONDS: 300, TRAVEL_DISTANCE_METERS: 3000 },
      { HEX_ID: '882830829dfffff', LAT: 37.785, LON: -122.430, TRAVEL_TIME_SECONDS: 450, TRAVEL_DISTANCE_METERS: 4500 },
      { HEX_ID: '8828308285fffff', LAT: 37.765, LON: -122.400, TRAVEL_TIME_SECONDS: 600, TRAVEL_DISTANCE_METERS: 6000 },
      { HEX_ID: '882830828dfffff', LAT: 37.790, LON: -122.435, TRAVEL_TIME_SECONDS: 900, TRAVEL_DISTANCE_METERS: 8000 },
      { HEX_ID: '8828308287fffff', LAT: 37.760, LON: -122.415, TRAVEL_TIME_SECONDS: 1200, TRAVEL_DISTANCE_METERS: 10000 },
      { HEX_ID: '882830829bfffff', LAT: 37.755, LON: -122.405, TRAVEL_TIME_SECONDS: 1500, TRAVEL_DISTANCE_METERS: 12000 },
      { HEX_ID: '8828308289fffff', LAT: 37.795, LON: -122.440, TRAVEL_TIME_SECONDS: 1800, TRAVEL_DISTANCE_METERS: 15000 },
    ];
    res.json({ destinations: dests, origin_lat: 37.7749, origin_lon: -122.4194 });
  });
  app.get('/api/tiles/:z/:x/:y', async (req, res) => {
    const { z, x, y } = req.params;
    try {
      const tileRes = await fetch(`https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`);
      const buf = Buffer.from(await tileRes.arrayBuffer());
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch {
      res.status(404).send('');
    }
  });
}

// --- Registry API ---
app.get('/api/registry', async (_req, res) => {
  try {
    const rows = await snowSql('SELECT * FROM CORE.DEMO_REGISTRY WHERE ENABLED = TRUE ORDER BY SORT_ORDER, DEMO_NAME');
    const groups: Record<string, any[]> = {};
    for (const r of rows) {
      const cat = r.CATEGORY || 'Other';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(r);
    }
    const { apps: installedApps, schemas: installedSchemas } = await getInstalledDeps();
    const demos = Object.entries(groups).map(([category, pageRows]) => {
      const pages = pageRows
        .map((r: any) => {
          const def = PAGE_DEFS[r.DEMO_ID];
          if (!def) return null;
          return { id: def.componentId, path: def.path, title: def.title };
        })
        .filter(Boolean);
      const first = pageRows[0];
      const deps = CATEGORY_DEPS[category];
      const installed = !deps || (
        (!deps.app || installedApps.has(deps.app)) &&
        (!deps.schema || installedSchemas.has(deps.schema))
      );
      return {
        demo_id: category.toLowerCase().replace(/\s+/g, '-'),
        display_name: category,
        description: pageRows.map((r: any) => r.DEMO_DESCRIPTION).filter(Boolean).join('; '),
        icon: CATEGORY_ICONS[category] || 'box',
        sort_order: Math.min(...pageRows.map((r: any) => Number(r.SORT_ORDER || 100))),
        source_db: first?.REQUIRED_DATABASE || '',
        source_schema: first?.REQUIRED_SCHEMA || '',
        pages,
        requires_ors: ORS_CATEGORIES.has(category),
        installed: installed,
        installed_at: first?.REGISTERED_AT || '',
        version: '1.0',
        config: {},
      };
    });
    demos.sort((a, b) => a.sort_order - b.sort_order);
    res.json(demos);
  } catch (err: any) {
    if (err.message?.includes('does not exist') || err.message?.includes('DEMO_REGISTRY')) {
      res.json([]);
    } else {
      console.error('Registry fetch error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

// --- ORS status check (enhanced with region, profiles, bounds) ---
app.get('/api/ors/status', async (_req, res) => {
  try {
    const rows = await snowSql(
      "SHOW DATABASES LIKE 'OPENROUTESERVICE_NATIVE_APP'",
      undefined,
      undefined
    );
    const installed = rows.length > 0;
    if (!installed) {
      return res.json({ installed: false, status: 'not_installed' });
    }

    let status = 'available';
    try {
      const svcRows = await snowSql(
        "SELECT SYSTEM$GET_SERVICE_STATUS('CORE.ORS_CONTROL_APP') AS STATUS",
        'OPENROUTESERVICE_NATIVE_APP',
        'CORE'
      );
      const svcStatus = svcRows?.[0]?.STATUS;
      const running = svcStatus && (svcStatus.includes('READY') || svcStatus.includes('RUNNING'));
      if (!running) status = 'starting';
    } catch { /* keep available */ }

    let region = 'Unknown';
    let profiles: string[] = [];
    let bounds: any = {};

    try {
      const mapConfig = await snowSql(
        "SELECT CITY_NAME, CENTER_LAT, CENTER_LON, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM CORE.MAP_CONFIG ORDER BY UPDATED_AT DESC LIMIT 1",
        'OPENROUTESERVICE_NATIVE_APP',
        'CORE'
      );
      if (mapConfig.length) {
        const mc = mapConfig[0];
        region = mc.CITY_NAME || 'Unknown';
        bounds = {
          center: { lat: Number(mc.CENTER_LAT), lng: Number(mc.CENTER_LON) },
          min: { lat: Number(mc.MIN_LAT), lng: Number(mc.MIN_LON) },
          max: { lat: Number(mc.MAX_LAT), lng: Number(mc.MAX_LON) },
        };
      }
    } catch { /* map config may not exist */ }

    try {
      const orsStatus = await snowSql(
        "SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS() AS S",
        undefined,
        undefined
      );
      if (orsStatus.length) {
        const parsed = typeof orsStatus[0].S === 'string' ? JSON.parse(orsStatus[0].S) : orsStatus[0].S;
        if (parsed?.profiles) {
          profiles = Object.keys(parsed.profiles);
        }
      }
    } catch { /* ORS_STATUS may not be ready */ }

    let availableRegions: string[] = [];
    try {
      const services = await snowSql(
        "SHOW SERVICES LIKE 'ORS_SERVICE%' IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE",
        undefined,
        undefined
      );
      availableRegions = services
        .map((s: any) => (s.name || s.NAME || ''))
        .filter((n: string) => n.startsWith('ORS_SERVICE_'))
        .map((n: string) => n.replace('ORS_SERVICE_', ''));
    } catch { /* ignore */ }

    res.json({ installed: true, status, region, profiles, bounds, availableRegions });
  } catch {
    try {
      const rows = await snowSql(
        "SELECT 1 AS OK FROM OPENROUTESERVICE_NATIVE_APP.INFORMATION_SCHEMA.SCHEMATA LIMIT 1",
        undefined,
        undefined
      );
      res.json({ installed: rows.length > 0, status: rows.length > 0 ? 'available' : 'not_installed' });
    } catch {
      res.json({ installed: false, status: 'unknown' });
    }
  }
});

// --- Region API ---
app.get('/api/regions', async (_req, res) => {
  try {
    const regions = await snowSql(
      `SELECT REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON,
              BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON,
              ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE, IS_DEFAULT
       FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
       ORDER BY IS_DEFAULT DESC, PROVISIONED_AT`,
      'FLEET_INTELLIGENCE', 'CORE'
    );
    const active = regions.find((r: any) => r.IS_DEFAULT === true || r.IS_DEFAULT === 'true')?.REGION_NAME || 'SanFrancisco';
    res.json({ regions, active });
  } catch (err: any) {
    if (err.message?.includes('does not exist')) {
      res.json({
        regions: [{
          REGION_NAME: 'SanFrancisco',
          DISPLAY_NAME: 'San Francisco',
          CENTER_LAT: 37.7749,
          CENTER_LON: -122.4194,
          BBOX_MIN_LAT: 37.700,
          BBOX_MAX_LAT: 37.820,
          BBOX_MIN_LON: -122.520,
          BBOX_MAX_LON: -122.350,
          ZOOM_LEVEL: 11,
          ORS_REGION_KEY: 'SanFrancisco',
          DATA_SOURCE: 'S3_BASELINE',
          IS_DEFAULT: true,
        }],
        active: 'SanFrancisco',
      });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get('/api/regions/active', async (_req, res) => {
  try {
    const rows = await snowSql(
      `SELECT REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON,
              BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON,
              ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE
       FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
       WHERE IS_DEFAULT = TRUE LIMIT 1`,
      'FLEET_INTELLIGENCE', 'CORE'
    );
    res.json(rows[0] || {
      REGION_NAME: 'SanFrancisco',
      DISPLAY_NAME: 'San Francisco',
      CENTER_LAT: 37.7749,
      CENTER_LON: -122.4194,
      ZOOM_LEVEL: 11,
    });
  } catch {
    res.json({
      REGION_NAME: 'SanFrancisco',
      DISPLAY_NAME: 'San Francisco',
      CENTER_LAT: 37.7749,
      CENTER_LON: -122.4194,
      ZOOM_LEVEL: 11,
    });
  }
});

app.post('/api/regions/active', async (req, res) => {
  try {
    const { region } = req.body;
    if (!region) return res.status(400).json({ error: 'region required' });
    await snowSql(
      `CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${region.replace(/'/g, "''")}')`,
      'FLEET_INTELLIGENCE', 'CORE'
    );
    res.json({ ok: true, region });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/regions/status', async (req, res) => {
  try {
    const region = (req.query.region as string) || null;
    const param = region ? `'${region.replace(/'/g, "''")}'` : 'NULL';
    const rows = await snowSql(
      `CALL FLEET_INTELLIGENCE.CORE.GET_REGION_STATUS(${param})`,
      'FLEET_INTELLIGENCE', 'CORE'
    );
    res.json(rows[0] || {});
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Travel Time Matrix Viewer (reads from OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX) ---
const ORS_DB = 'OPENROUTESERVICE_NATIVE_APP';
const ORS_MATRIX_SCHEMA = 'TRAVEL_MATRIX';
const VIEWER_PROFILE_PATTERNS = ['DRIVING_CAR', 'DRIVING_HGV', 'CYCLING_REGULAR', 'CYCLING_ROAD', 'CYCLING_MOUNTAIN', 'CYCLING_ELECTRIC', 'FOOT_WALKING', 'FOOT_HIKING', 'WHEELCHAIR'];

function parseMatrixTableName(name: string): { region: string; profile: string; resolution: string } | null {
  for (const profile of VIEWER_PROFILE_PATTERNS) {
    const pattern = new RegExp(`^(.+?)_${profile}_MATRIX_(RES\\d+)$`);
    const match = name.match(pattern);
    if (match) {
      return { region: match[1], profile: profile.toLowerCase().replace(/_/g, '-'), resolution: match[2] };
    }
  }
  return null;
}

let matrixInventoryCache: { tables: any[]; ts: number } = { tables: [], ts: 0 };

async function getMatrixInventory(): Promise<any[]> {
  if (Date.now() - matrixInventoryCache.ts < 60000 && matrixInventoryCache.tables.length > 0) {
    return matrixInventoryCache.tables;
  }
  const rows = await snowSql(`
    SELECT TABLE_NAME, ROW_COUNT, BYTES
    FROM ${ORS_DB}.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = '${ORS_MATRIX_SCHEMA}'
      AND TABLE_NAME LIKE '%\\_MATRIX\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_MATRIX\\_RAW\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_LIST\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_WORK\\_QUEUE\\_%' ESCAPE '\\\\'
      AND TABLE_NAME != 'MATRIX_BUILD_JOBS'
    ORDER BY TABLE_NAME
  `, ORS_DB, 'INFORMATION_SCHEMA');
  const tables = rows.map((r: any) => {
    const parsed = parseMatrixTableName(r.TABLE_NAME);
    if (!parsed) return null;
    return {
      ...parsed,
      row_count: parseInt(r.ROW_COUNT || '0'),
      bytes: parseInt(r.BYTES || '0'),
      table_name: r.TABLE_NAME,
      full_table: `${ORS_DB}.${ORS_MATRIX_SCHEMA}.${r.TABLE_NAME}`,
    };
  }).filter(Boolean);
  matrixInventoryCache = { tables, ts: Date.now() };
  return tables;
}

function validateMatrixTable(tableName: string): string | null {
  const tables = matrixInventoryCache.tables;
  const found = tables.find((t: any) => t.full_table === tableName || t.table_name === tableName);
  if (found) return found.full_table;
  return null;
}

app.get('/api/matrix/viewer-inventory', async (_req, res) => {
  try {
    const tables = await getMatrixInventory();
    res.json({ tables });
  } catch (err: any) {
    res.json({ tables: [], error: err.message });
  }
});

app.get('/api/matrix/random-origin', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    if (!tableParam) return res.status(400).json({ error: 'table parameter required' });
    await getMatrixInventory();
    const table = validateMatrixTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const [[originRow], [maxRow]] = await Promise.all([
      snowSql(`SELECT ORIGIN_H3 FROM (SELECT ORIGIN_H3, COUNT(*) AS CNT FROM ${table} GROUP BY ORIGIN_H3 ORDER BY CNT DESC LIMIT 10) ORDER BY RANDOM() LIMIT 1`, ORS_DB, ORS_MATRIX_SCHEMA),
      snowSql(`SELECT MAX(TRAVEL_TIME_SECONDS) AS GLOBAL_MAX FROM ${table}`, ORS_DB, ORS_MATRIX_SCHEMA),
    ]);
    const hex = originRow?.ORIGIN_H3;
    if (!hex) return res.json({ error: 'No data in table' });
    const latLon = await snowSql(
      `SELECT ST_Y(H3_CELL_TO_POINT('${hex}')) AS LAT, ST_X(H3_CELL_TO_POINT('${hex}')) AS LON`, ORS_DB, ORS_MATRIX_SCHEMA
    );
    res.json({
      origin_hex: hex,
      origin_lat: Number(latLon[0]?.LAT || 0),
      origin_lon: Number(latLon[0]?.LON || 0),
      global_max_time_secs: Number(maxRow?.GLOBAL_MAX || 0),
    });
  } catch (err: any) {
    console.error('Random-origin error:', err.message);
    res.json({ error: err.message });
  }
});

app.get('/api/matrix/all-hexes', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    if (!tableParam) return res.status(400).json({ error: 'table parameter required' });
    await getMatrixInventory();
    const table = validateMatrixTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const rows = await snowSql(`SELECT DISTINCT ORIGIN_H3 AS HEX_ID FROM ${table}`, ORS_DB, ORS_MATRIX_SCHEMA);
    res.json({ hexes: rows.map((r: any) => r.HEX_ID) });
  } catch (err: any) {
    console.error('All-hexes error:', err.message);
    res.json({ hexes: [] });
  }
});

app.get('/api/matrix/reachability', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    const origin = req.query.origin as string;
    if (!tableParam || !origin) return res.status(400).json({ error: 'table and origin required' });
    await getMatrixInventory();
    const table = validateMatrixTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const safeOrigin = origin.replace(/[^a-fA-F0-9]/g, '');
    const maxTimeSecs = req.query.max_time ? Number(req.query.max_time) : null;
    const timeFilter = maxTimeSecs ? `AND TRAVEL_TIME_SECONDS <= ${maxTimeSecs}` : '';
    const rows = await snowSql(`
      SELECT
        DEST_H3 AS HEX_ID,
        ST_Y(H3_CELL_TO_POINT(DEST_H3)) AS LAT,
        ST_X(H3_CELL_TO_POINT(DEST_H3)) AS LON,
        TRAVEL_TIME_SECONDS,
        TRAVEL_DISTANCE_METERS,
        0 AS RING
      FROM ${table}
      WHERE ORIGIN_H3 = '${safeOrigin}'
        AND TRAVEL_TIME_SECONDS IS NOT NULL
        ${timeFilter}
    `, ORS_DB, ORS_MATRIX_SCHEMA);
    const originLatLon = await snowSql(
      `SELECT ST_Y(H3_CELL_TO_POINT('${safeOrigin}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safeOrigin}')) AS LON`, ORS_DB, ORS_MATRIX_SCHEMA
    );
    res.json({
      destinations: rows,
      origin_lat: Number(originLatLon[0]?.LAT || 0),
      origin_lon: Number(originLatLon[0]?.LON || 0),
    });
  } catch (err: any) {
    console.error('Reachability error:', err.message);
    res.json({ destinations: [], origin_lat: 0, origin_lon: 0 });
  }
});

// --- Routing Agent via CORTEX.COMPLETE with tool-calling loop ---
const TOOL_PROCEDURE_MAP: Record<string, { identifier: string; params: string[] }> = {
  tool_directions: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS',
    params: ['locations_description', 'profile'],
  },
  tool_isochrone: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE',
    params: ['location_description', 'range_minutes', 'profile'],
  },
  tool_optimization: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_OPTIMIZATION',
    params: ['jobs_description', 'vehicles_description', 'num_vehicles', 'profile'],
  },
};

const ROUTING_SYSTEM_PROMPT = `You are a routing agent powered by OpenRouteService. You help users with:
1. Driving/cycling/walking directions between locations
2. Reachability analysis (isochrones) - areas reachable within X minutes
3. Multi-stop delivery route optimization

You have access to three tools. To call a tool, respond with EXACTLY this JSON format and NOTHING else:
{"tool_call": {"name": "TOOL_NAME", "input": {PARAMS}}}

Available tools:
1. tool_directions - Get directions between locations (auto-detects region: Berlin, London, San Francisco)
   Input: {"locations_description": "string describing start/end/waypoints (required)", "profile": "string (default: driving-car)"}
2. tool_isochrone - Get area reachable within specified minutes from a location
   Input: {"location_description": "string describing the center location (required)", "range_minutes": number (required), "profile": "string (default: driving-car)"}
3. tool_optimization - Optimize delivery/pickup routes for multiple stops with one or more vehicles
   Input: {"jobs_description": "string describing all delivery/pickup locations (required)", "vehicles_description": "string describing vehicle start/end locations (required)", "num_vehicles": number (default: 1), "profile": "string (default: driving-car)"}

Transport profiles: driving-car, cycling-electric (for any bike/cycling request), driving-hgv (trucks)
Note: For cycling requests, ALWAYS use "cycling-electric" as the profile value. Other cycling profiles may not be available in all regions.

CRITICAL RULES:
1. ALWAYS call the appropriate tool for ANY routing question. NEVER answer from general knowledge.
2. When you need to call a tool, respond ONLY with the JSON tool_call object. No other text.
3. After receiving tool results, format them clearly: distances in km, durations in minutes.
4. If a tool returns an error, report it clearly. Do NOT provide alternative estimates.
5. NEVER fabricate routing data.
6. The tools auto-detect the geographic region (Berlin, London, San Francisco). Include city names in descriptions for best results.`;

function escSql(val: any): string {
  if (val === undefined || val === null) return "''";
  const s = String(val);
  return "'" + s.replace(/'/g, "''") + "'";
}

const VALID_PROFILES = new Set([
  'driving-car', 'driving-hgv', 'cycling-regular', 'cycling-mountain',
  'cycling-road', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair',
]);

const PROFILE_ALIASES: Record<string, string> = {
  'bike': 'cycling-electric',
  'bicycle': 'cycling-electric',
  'cycling': 'cycling-electric',
  'cycle': 'cycling-electric',
  'cycling-regular': 'cycling-electric',
  'cycling-mountain': 'cycling-electric',
  'cycling-road': 'cycling-electric',
  'ebike': 'cycling-electric',
  'e-bike': 'cycling-electric',
  'walk': 'foot-walking',
  'walking': 'foot-walking',
  'hike': 'foot-hiking',
  'hiking': 'foot-hiking',
  'car': 'driving-car',
  'drive': 'driving-car',
  'driving': 'driving-car',
  'truck': 'driving-hgv',
  'hgv': 'driving-hgv',
  'foot': 'foot-walking',
};

function normalizeProfile(profile: string | undefined): string {
  if (!profile) return 'driving-car';
  const lower = profile.toLowerCase().trim();
  if (VALID_PROFILES.has(lower)) return lower;
  return PROFILE_ALIASES[lower] || 'driving-car';
}

async function executeToolLocally(toolName: string, input: Record<string, any>): Promise<any> {
  const mapping = TOOL_PROCEDURE_MAP[toolName];
  if (!mapping) {
    return { error: `Unknown tool: ${toolName}`, status: 'FAILED' };
  }
  const args = mapping.params.map(p => {
    let val = input[p];
    if (p === 'profile') val = normalizeProfile(val as string);
    if (val === undefined || val === null) return 'DEFAULT';
    if (typeof val === 'number') return String(val);
    return escSql(val);
  });
  const sql = `CALL ${mapping.identifier}(${args.join(', ')})`;
  console.log(`[Agent] Executing tool locally: ${sql.slice(0, 200)}`);
  try {
    const rows = await snowSqlSpcs(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT', 120);
    const result = rows?.[0];
    if (result) {
      const firstVal = Object.values(result)[0];
      if (typeof firstVal === 'string') {
        try { return JSON.parse(firstVal); } catch { return firstVal; }
      }
      return firstVal;
    }
    return { error: 'No result from tool execution', status: 'FAILED' };
  } catch (err: any) {
    console.error(`[Agent] Tool execution error: ${err.message}`);
    return { error: `Tool execution failed: ${err.message}`, status: 'FAILED' };
  }
}

function escSqlStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function callCortexComplete(messages: Array<{role: string; content: string}>): Promise<string> {
  const msgArray = messages.map(m => {
    return `{'role':'${m.role}','content':'${escSqlStr(m.content)}'}`;
  }).join(',');
  const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-opus-4-6', [${msgArray}], {'max_tokens':4096,'temperature':0}) as RESPONSE`;
  console.log(`[Agent] CORTEX.COMPLETE call, messages: ${messages.length}`);
  const rows = await snowSqlSpcs(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT', 120);
  if (!rows || rows.length === 0) throw new Error('No response from CORTEX.COMPLETE');
  const raw = rows[0].RESPONSE || rows[0][Object.keys(rows[0])[0]] || '';
  let content = '';
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    content = parsed.choices?.[0]?.messages || parsed.choices?.[0]?.message?.content || '';
  } catch {
    content = String(raw);
  }
  return content.trim();
}

function parseToolCall(text: string): { name: string; input: Record<string, any> } | null {
  try {
    const match = text.match(/\{\s*"tool_call"\s*:/s);
    if (!match) return null;
    const jsonStr = text.slice(text.indexOf('{'));
    const braceEnd = findMatchingBrace(jsonStr);
    if (braceEnd < 0) return null;
    const parsed = JSON.parse(jsonStr.slice(0, braceEnd + 1));
    if (parsed.tool_call?.name && TOOL_PROCEDURE_MAP[parsed.tool_call.name]) {
      return { name: parsed.tool_call.name, input: parsed.tool_call.input || {} };
    }
  } catch {}
  return null;
}

function findMatchingBrace(s: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

async function callCortexAgentWithToolLoop(
  message: string,
  threadId?: string,
  parentMessageId?: string,
  onProgress?: (data: { step: string; detail?: string }) => void,
): Promise<any> {
  if (!IS_SPCS) {
    throw new Error('Cortex Agent is only available in SPCS mode');
  }

  const messages: Array<{role: string; content: string}> = [
    { role: 'system', content: ROUTING_SYSTEM_PROMPT },
    { role: 'user', content: message },
  ];
  const maxIterations = 5;
  const allToolResults: any[] = [];

  for (let iter = 0; iter < maxIterations; iter++) {
    onProgress?.({ step: 'calling_llm', detail: `Iteration ${iter}` });
    console.log(`[Agent] Iteration ${iter}: calling CORTEX.COMPLETE with ${messages.length} messages`);
    const response = await callCortexComplete(messages);
    console.log(`[Agent] Response (iter ${iter}): ${response.slice(0, 500)}`);

    const toolCall = parseToolCall(response);
    if (!toolCall) {
      return {
        role: 'assistant',
        content: [{ type: 'text', text: response }],
        _toolResults: allToolResults,
      };
    }

    const toolLabel = toolCall.name.replace('tool_', '');
    onProgress?.({ step: 'executing_tool', detail: toolLabel });
    console.log(`[Agent] Tool call: ${toolCall.name} input=${JSON.stringify(toolCall.input).slice(0, 200)}`);
    messages.push({ role: 'assistant', content: response });

    const toolResult = await executeToolLocally(toolCall.name, toolCall.input);
    allToolResults.push(toolResult);

    onProgress?.({ step: 'formatting', detail: 'Processing tool results' });
    const resultStr = JSON.stringify(toolResult).slice(0, 30000);
    messages.push({ role: 'user', content: `Tool result from ${toolCall.name}:\n${resultStr}\n\nNow provide your final answer based on this data. Format distances in km and durations in minutes. Be concise.` });
  }

  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'I was unable to complete the request after multiple attempts.' }],
    _toolResults: allToolResults,
  };
}

function parseAgentResponse(agentResult: any): { message: string; geometry: any; toolResults: any[] } {
  const content = agentResult?.content || [];
  let message = '';
  const toolResults: any[] = agentResult?._toolResults || [];
  let geometry: any = null;

  for (const item of content) {
    if (item.type === 'text') {
      message += (message ? '\n' : '') + item.text;
    }
  }

  for (const tr of toolResults) {
    if (tr && typeof tr === 'object' && tr.geometry && !geometry) {
      geometry = tr.geometry;
    }
  }

  if (!message) {
    message = agentResult?.message || 'No response from agent';
  }

  return { message, geometry, toolResults };
}

function sendSseEvent(res: any, event: string, data: any) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post('/api/agent/chat', async (req, res) => {
  const { message, thread_id, parent_message_id } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const onProgress = (data: { step: string; detail?: string }) => {
      sendSseEvent(res, 'progress', data);
    };

    const agentResult = await callCortexAgentWithToolLoop(message, thread_id, parent_message_id, onProgress);
    const parsed = parseAgentResponse(agentResult);

    const response: any = {
      message: parsed.message,
      tool_results: parsed.toolResults,
    };
    if (parsed.geometry) {
      response.geometry = parsed.geometry;
    }
    if (agentResult?.metadata?.thread_id) {
      response.thread_id = agentResult.metadata.thread_id;
    }
    if (agentResult?.metadata?.message_id) {
      response.message_id = agentResult.metadata.message_id;
    }

    sendSseEvent(res, 'result', response);
    res.end();
  } catch (err: any) {
    console.error('Agent chat error:', err.message);
    sendSseEvent(res, 'error', { error: err.message });
    res.end();
  }
});

// --- Data Studio API ---
app.use('/api/studio', createStudioRouter(snowSql));

// --- Generic SQL query endpoint (read-only) ---
app.post('/api/query', async (req, res) => {
  try {
    const { sql, database, schema } = req.body;
    if (!sql) return res.status(400).json({ error: 'sql required' });
    const trimmed = sql.trim().toUpperCase();
    const allowed = ['SELECT', 'SHOW', 'DESCRIBE', 'CALL', 'WITH'];
    if (!allowed.some(kw => trimmed.startsWith(kw))) {
      return res.status(403).json({ error: 'Only read operations allowed' });
    }
    const rows = await snowSql(sql, database, schema);
    res.json(rows);
  } catch (err: any) {
    console.error('Query error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Static file serving in SPCS ---
if (IS_SPCS) {
  const staticDir = join(process.cwd(), 'dist');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => {
      res.sendFile(join(staticDir, 'index.html'));
    });
  }
}

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Demo Dashboard server running on port ${PORT} (${IS_SPCS ? 'SPCS' : 'local'} mode)`);
});
