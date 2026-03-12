import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);
import { writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const IS_SPCS = existsSync('/snowflake/session/token');

const SF_DATABASE = process.env.SNOWFLAKE_DATABASE || 'FLEET_INTELLIGENCE_APP';
const SF_SCHEMA = process.env.SNOWFLAKE_SCHEMA || 'DATA';
const SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH';
const CONN = process.env.SNOWFLAKE_CONNECTION_NAME || 'FREE_TRIAL';
const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';

interface CityOrsConfig {
  cityKey: string;
  pbfUrl: string;
  pbfFilename: string;
  orsRegion: string;
  country: string;
  state: string;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

const CITY_ORS_MAP: Record<string, CityOrsConfig> = {
  'London': { cityKey: 'LONDON', pbfUrl: 'https://download.bbbike.org/osm/bbbike/London/London.osm.pbf', pbfFilename: 'London.osm.pbf', orsRegion: 'London', country: 'GB', state: '', bbox: { minLat: 51.28, maxLat: 51.69, minLon: -0.51, maxLon: 0.33 } },
  'Paris': { cityKey: 'PARIS', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Paris/Paris.osm.pbf', pbfFilename: 'Paris.osm.pbf', orsRegion: 'Paris', country: 'FR', state: '', bbox: { minLat: 48.81, maxLat: 48.90, minLon: 2.22, maxLon: 2.47 } },
  'Berlin': { cityKey: 'BERLIN', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Berlin/Berlin.osm.pbf', pbfFilename: 'Berlin.osm.pbf', orsRegion: 'Berlin', country: 'DE', state: 'BE', bbox: { minLat: 52.34, maxLat: 52.68, minLon: 13.09, maxLon: 13.76 } },
  'New York': { cityKey: 'NEW_YORK', pbfUrl: 'https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf', pbfFilename: 'NewYork.osm.pbf', orsRegion: 'NewYork', country: 'US', state: 'NY', bbox: { minLat: 40.49, maxLat: 40.92, minLon: -74.26, maxLon: -73.70 } },
  'Chicago': { cityKey: 'CHICAGO', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Chicago/Chicago.osm.pbf', pbfFilename: 'Chicago.osm.pbf', orsRegion: 'Chicago', country: 'US', state: 'IL', bbox: { minLat: 41.64, maxLat: 42.02, minLon: -87.94, maxLon: -87.52 } },
  'Los Angeles': { cityKey: 'LOS_ANGELES', pbfUrl: 'https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf', pbfFilename: 'LosAngeles.osm.pbf', orsRegion: 'LosAngeles', country: 'US', state: 'CA', bbox: { minLat: 33.70, maxLat: 34.34, minLon: -118.67, maxLon: -117.65 } },
  'San Francisco': { cityKey: 'SAN_FRANCISCO', pbfUrl: 'https://download.bbbike.org/osm/bbbike/SanFrancisco/SanFrancisco.osm.pbf', pbfFilename: 'SanFrancisco.osm.pbf', orsRegion: 'SanFrancisco', country: 'US', state: 'CA', bbox: { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 } },
  'San Jose': { cityKey: 'SAN_JOSE', pbfUrl: 'https://download.bbbike.org/osm/bbbike/SanJose/SanJose.osm.pbf', pbfFilename: 'SanJose.osm.pbf', orsRegion: 'SanJose', country: 'US', state: 'CA', bbox: { minLat: 37.12, maxLat: 37.47, minLon: -122.05, maxLon: -121.72 } },
  'Sacramento': { cityKey: 'SACRAMENTO', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Sacramento/Sacramento.osm.pbf', pbfFilename: 'Sacramento.osm.pbf', orsRegion: 'Sacramento', country: 'US', state: 'CA', bbox: { minLat: 38.43, maxLat: 38.70, minLon: -121.56, maxLon: -121.35 } },
  'Santa Barbara': { cityKey: 'SANTA_BARBARA', pbfUrl: 'https://download.bbbike.org/osm/bbbike/SantaBarbara/SantaBarbara.osm.pbf', pbfFilename: 'SantaBarbara.osm.pbf', orsRegion: 'SantaBarbara', country: 'US', state: 'CA', bbox: { minLat: 34.38, maxLat: 34.46, minLon: -119.78, maxLon: -119.63 } },
  'Stockton': { cityKey: 'STOCKTON', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Stockton/Stockton.osm.pbf', pbfFilename: 'Stockton.osm.pbf', orsRegion: 'Stockton', country: 'US', state: 'CA', bbox: { minLat: 37.90, maxLat: 38.05, minLon: -121.38, maxLon: -121.20 } },
};

function getOrsRegion(city: string): string {
  return CITY_ORS_MAP[city]?.orsRegion || 'SanFrancisco';
}

const ORS_REGION_CONFIG: Record<string, { pbfUrl: string; pbfFilename: string; cities: string[] }> = {};
for (const [city, cfg] of Object.entries(CITY_ORS_MAP)) {
  if (!ORS_REGION_CONFIG[cfg.orsRegion]) {
    ORS_REGION_CONFIG[cfg.orsRegion] = { pbfUrl: cfg.pbfUrl, pbfFilename: cfg.pbfFilename, cities: [] };
  }
  ORS_REGION_CONFIG[cfg.orsRegion].cities.push(city);
}

interface CityProvisionState {
  status: 'idle' | 'downloading_pbf' | 'creating_pool' | 'creating_service' | 'building_graph' | 'creating_functions' | 'ready' | 'building_data' | 'complete' | 'error';
  message?: string;
  orsRegion: string;
  started_at?: number;
  error?: string;
  dataSteps?: { step: string; status: string; message?: string; rows?: number; elapsed_seconds?: number; started_at?: number }[];
}

const cityProvisionStates: Record<string, CityProvisionState> = {};

function getSpcsToken(): string {
  return readFileSync('/snowflake/session/token', 'utf-8').trim();
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[\d;]*m/g, '');
}

function cortexCompleteLocal(prompt: string, model: string = 'claude-3-5-sonnet'): string {
  const tmpFile = join(tmpdir(), `cortex_prompt_${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt);
  try {
    const cmd = `cat "${tmpFile}" | snow cortex complete --model ${model} -c ${CONN} 2>/dev/null`;
    const raw = execSync(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 120000, encoding: 'utf-8' }).trim();
    return stripAnsi(raw);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function cortexCompleteLocalFile(messages: any[], model: string = 'claude-3-5-sonnet'): string {
  const tmpFile = join(tmpdir(), `cortex_messages_${Date.now()}.json`);
  writeFileSync(tmpFile, JSON.stringify({ messages }));
  try {
    const cmd = `snow cortex complete --file "${tmpFile}" --model ${model} -c ${CONN} 2>/dev/null`;
    const raw = execSync(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 120000, encoding: 'utf-8' }).trim();
    return stripAnsi(raw);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function getSpcsConfig(): { host: string; token: string } {
  return { host: SNOWFLAKE_HOST, token: getSpcsToken() };
}

async function snowSqlLocal(sql: string): Promise<any[]> {
  const tmpFile = join(tmpdir(), `fleet_query_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  const fullSql = `USE WAREHOUSE ${SF_WAREHOUSE};\nUSE DATABASE ${SF_DATABASE};\nUSE SCHEMA ${SF_SCHEMA};\n${sql};`;
  writeFileSync(tmpFile, fullSql);
  try {
    const cmd = `snow sql -c ${CONN} -f "${tmpFile}" --format json 2>/dev/null`;
    const { stdout } = await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 600000 });
    const parsed = JSON.parse(stdout.trim());
    if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
      return parsed[parsed.length - 1];
    }
    return parsed;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function snowSqlSpcs(sql: string): Promise<any[]> {
  const token = getSpcsToken();
  const host = SNOWFLAKE_HOST;
  const statementsUrl = `https://${host}/api/v2/statements`;
  const body = {
    statement: sql,
    timeout: 120,
    database: SF_DATABASE,
    schema: SF_SCHEMA,
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
    throw new Error(`Snowflake SQL API error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const result: any = await res.json();
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

async function snowSql(sql: string): Promise<any[]> {
  if (IS_SPCS) return snowSqlSpcs(sql);
  return snowSqlLocal(sql);
}

if (IS_SPCS) {
  const staticDir = join(process.cwd(), 'dist');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
  }
}

app.get('/api/routes', async (req, res) => {
  try {
    const city = req.query.city as string || 'Los Angeles';
    const statusFilter = req.query.status as string || '';
    const conditions: string[] = [];
    if (city !== 'All Cities') conditions.push(`CITY = '${city.replace(/'/g, "''")}'`);
    if (statusFilter === 'active') conditions.push(`ORDER_STATUS != 'delivered'`);
    else if (statusFilter && statusFilter !== 'all') conditions.push(`ORDER_STATUS = '${statusFilter.replace(/'/g, "''")}'`);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT
  COURIER_ID,
  ORDER_ID,
  RESTAURANT_NAME,
  CUSTOMER_ADDRESS,
  ST_ASGEOJSON(GEOMETRY) AS GEOMETRY_JSON,
  ROUTE_DISTANCE_METERS/1000 AS DISTANCE_KM,
  ROUTE_DURATION_SECS/60 AS ETA_MINS,
  ORDER_STATUS,
  CITY
FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY
${whereClause}
LIMIT 300`;

    console.log(`Fetching routes for ${city}...`);
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} routes`);
    res.json(rows);
  } catch (err: any) {
    console.error('Routes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fleet-stats', async (_req, res) => {
  try {
    const sql = `SELECT
  CITY,
  COUNT(*) AS ORDERS,
  COUNT(DISTINCT COURIER_ID) AS COURIERS,
  COUNT(DISTINCT RESTAURANT_ID) AS RESTAURANTS,
  ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_KM,
  ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_MINS
FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY
GROUP BY CITY
ORDER BY ORDERS DESC`;

    console.log('Fetching fleet stats...');
    const rows = await snowSql(sql);

    const cities = rows.map((r: any) => ({
      city: r.CITY,
      orders: Number(r.ORDERS || 0),
      couriers: Number(r.COURIERS || 0),
      restaurants: Number(r.RESTAURANTS || 0),
      total_km: Number(r.TOTAL_KM || 0),
      avg_mins: Number(r.AVG_MINS || 0),
    }));

    const total_orders = cities.reduce((s: number, c: any) => s + c.orders, 0);
    const total_couriers = cities.reduce((s: number, c: any) => s + c.couriers, 0);
    const total_restaurants = cities.reduce((s: number, c: any) => s + c.restaurants, 0);
    const total_km = cities.reduce((s: number, c: any) => s + c.total_km, 0);
    const avg_delivery_mins = total_orders > 0
      ? cities.reduce((s: number, c: any) => s + c.avg_mins * c.orders, 0) / total_orders
      : 0;

    res.json({ total_orders, total_couriers, total_restaurants, total_km, avg_delivery_mins, cities });
  } catch (err: any) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/active-stats', async (_req, res) => {
  try {
    const sql = `SELECT
  CITY,
  ORDER_STATUS,
  COUNT(*) AS CNT
FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY
GROUP BY CITY, ORDER_STATUS
ORDER BY CITY, ORDER_STATUS`;

    const rows = await snowSql(sql);
    const byCity: Record<string, { active: number; delivered: number; in_transit: number; picked_up: number }> = {};
    for (const r of rows) {
      const city = r.CITY;
      if (!byCity[city]) byCity[city] = { active: 0, delivered: 0, in_transit: 0, picked_up: 0 };
      const cnt = Number(r.CNT || 0);
      if (r.ORDER_STATUS === 'delivered') byCity[city].delivered += cnt;
      else if (r.ORDER_STATUS === 'in_transit') { byCity[city].in_transit += cnt; byCity[city].active += cnt; }
      else if (r.ORDER_STATUS === 'picked_up') { byCity[city].picked_up += cnt; byCity[city].active += cnt; }
      else byCity[city].active += cnt;
    }
    const totals = { active: 0, delivered: 0, in_transit: 0, picked_up: 0 };
    const cities = Object.entries(byCity).map(([city, s]) => {
      totals.active += s.active;
      totals.delivered += s.delivered;
      totals.in_transit += s.in_transit;
      totals.picked_up += s.picked_up;
      return { city, ...s };
    });
    res.json({ ...totals, cities });
  } catch (err: any) {
    console.error('Active stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/hex-activity', async (req, res) => {
  try {
    const city = req.query.city as string || 'Los Angeles';
    const cityFilter = city === 'All Cities' ? '' : `WHERE cl.CITY = '${city.replace(/'/g, "''")}'`;

    const sql = `SELECT
  H3_LATLNG_TO_CELL_STRING(ST_Y(TO_GEOGRAPHY(POINT_GEOM)), ST_X(TO_GEOGRAPHY(POINT_GEOM)), 9) AS HEX_ID,
  COUNT(*) AS COUNT,
  AVG(ST_Y(TO_GEOGRAPHY(POINT_GEOM))) AS LAT,
  AVG(ST_X(TO_GEOGRAPHY(POINT_GEOM))) AS LON
FROM ${SF_DATABASE}.${SF_SCHEMA}.COURIER_LOCATIONS cl
${cityFilter}
GROUP BY HEX_ID
HAVING COUNT > 0
ORDER BY COUNT DESC
LIMIT 5000`;

    console.log(`Fetching hex activity for ${city}...`);
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} hexagons`);
    res.json(rows);
  } catch (err: any) {
    console.error('Hex activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/hex-matrix', async (req, res) => {
  try {
    const city = req.query.city as string || 'Los Angeles';
    const cityClause = city === 'All Cities' ? '' : `AND CITY = '${city.replace(/'/g, "''")}'`;

    const sql = `SELECT
  H3_LATLNG_TO_CELL_STRING(ST_Y(TO_GEOGRAPHY(RESTAURANT_LOCATION)), ST_X(TO_GEOGRAPHY(RESTAURANT_LOCATION)), 9) AS HEX_ID,
  COUNT(*) AS DELIVERY_COUNT,
  ROUND(AVG(ROUTE_DISTANCE_METERS)/1000, 2) AS AVG_DISTANCE_KM,
  ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DURATION_MINS,
  ROUND(AVG(ROUTE_DISTANCE_METERS/NULLIF(ROUTE_DURATION_SECS,0) * 3.6), 1) AS AVG_SPEED_KMH,
  COUNT(DISTINCT COURIER_ID) AS UNIQUE_COURIERS,
  COUNT(DISTINCT RESTAURANT_NAME) AS UNIQUE_RESTAURANTS,
  ROUND(AVG(ST_Y(TO_GEOGRAPHY(RESTAURANT_LOCATION))), 6) AS LAT,
  ROUND(AVG(ST_X(TO_GEOGRAPHY(RESTAURANT_LOCATION))), 6) AS LON
FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY
WHERE ROUTE_DISTANCE_METERS > 0 AND ROUTE_DURATION_SECS > 0
${cityClause}
GROUP BY HEX_ID
HAVING DELIVERY_COUNT >= 1
ORDER BY DELIVERY_COUNT DESC
LIMIT 5000`;

    console.log(`Fetching hex matrix for ${city}...`);
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} matrix hexagons`);
    res.json(rows);
  } catch (err: any) {
    console.error('Hex matrix error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/restaurants', async (_req, res) => {
  try {
    const sql = `
      SELECT
        RESTAURANT_NAME AS NAME,
        CUISINE_TYPE AS CUISINE,
        CITY,
        ST_X(RESTAURANT_LOCATION) AS LON,
        ST_Y(RESTAURANT_LOCATION) AS LAT,
        COUNT(*) AS ORDERS
      FROM ${SF_DATABASE}.DATA.DELIVERY_SUMMARY
      GROUP BY 1,2,3,4,5
      ORDER BY ORDERS DESC`;
    console.log('Fetching all restaurants...');
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} unique restaurants`);
    res.json(rows);
  } catch (err: any) {
    console.error('Restaurants error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matrix/travel-times', async (req, res) => {
  try {
    const resolution = Number(req.query.resolution) || 7;
    if (![7, 8, 9].includes(resolution)) {
      return res.status(400).json({ error: 'Resolution must be 7, 8, or 9' });
    }

    const travelTable = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${resolution}`;
    const hexTable = `${SF_DATABASE}.DATA.CA_H3_RES${resolution}`;

    const sql = `
      SELECT
        t.ORIGIN_H3 AS HEX_ID,
        h.CENTER_LAT AS LAT,
        h.CENTER_LON AS LON,
        COUNT(t.DEST_H3) AS DEST_COUNT,
        ROUND(AVG(t.TRAVEL_TIME_SECONDS), 1) AS AVG_TRAVEL_TIME_SECS,
        ROUND(MIN(t.TRAVEL_TIME_SECONDS), 1) AS MIN_TRAVEL_TIME_SECS,
        ROUND(MAX(t.TRAVEL_TIME_SECONDS), 1) AS MAX_TRAVEL_TIME_SECS,
        ROUND(AVG(t.TRAVEL_DISTANCE_METERS), 0) AS AVG_DISTANCE_METERS,
        ROUND(MAX(t.TRAVEL_DISTANCE_METERS), 0) AS MAX_DISTANCE_METERS
      FROM ${travelTable} t
      JOIN ${hexTable} h ON t.ORIGIN_H3 = h.H3_INDEX
      WHERE t.TRAVEL_TIME_SECONDS IS NOT NULL
      GROUP BY t.ORIGIN_H3, h.CENTER_LAT, h.CENTER_LON
      ORDER BY DEST_COUNT DESC
      LIMIT 5000`;

    console.log(`Fetching travel time matrix res${resolution}...`);
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} origin hexagons for res${resolution}`);

    const countSql = `SELECT COUNT(*) AS CNT FROM ${travelTable}`;
    const countRows = await snowSql(countSql);
    const totalPairs = Number(countRows[0]?.CNT || 0);

    res.json({ resolution, total_pairs: totalPairs, hexagons: rows });
  } catch (err: any) {
    console.error('Travel time matrix error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matrix/reachability', async (req, res) => {
  try {
    const resolution = Number(req.query.resolution) || 8;
    const origin = req.query.origin as string;
    if (!origin) return res.status(400).json({ error: 'origin H3 index required' });
    if (![7, 8, 9].includes(resolution)) return res.status(400).json({ error: 'Resolution must be 7, 8, or 9' });

    const travelTable = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${resolution}`;
    const hexTable = `${SF_DATABASE}.DATA.CA_H3_RES${resolution}`;
    const safeOrigin = origin.replace(/'/g, "''");

    const sql = `
      WITH reachable AS (
        SELECT DEST_H3 AS HEX_ID, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
        FROM ${travelTable}
        WHERE ORIGIN_H3 = '${safeOrigin}' AND TRAVEL_TIME_SECONDS IS NOT NULL
        UNION ALL
        SELECT ORIGIN_H3 AS HEX_ID, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
        FROM ${travelTable}
        WHERE DEST_H3 = '${safeOrigin}' AND TRAVEL_TIME_SECONDS IS NOT NULL
      )
      SELECT
        r.HEX_ID,
        h.CENTER_LAT AS LAT,
        h.CENTER_LON AS LON,
        ROUND(r.TRAVEL_TIME_SECONDS, 1) AS TRAVEL_TIME_SECS,
        ROUND(r.TRAVEL_DISTANCE_METERS, 0) AS DISTANCE_METERS
      FROM reachable r
      JOIN ${hexTable} h ON r.HEX_ID = h.H3_INDEX
      ORDER BY r.TRAVEL_TIME_SECONDS`;

    console.log(`Fetching reachability from ${origin} at res${resolution}...`);
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} reachable hexagons`);

    const originCoords = await snowSql(
      `SELECT CENTER_LAT AS LAT, CENTER_LON AS LON FROM ${hexTable} WHERE H3_INDEX = '${safeOrigin}'`
    );

    res.json({
      origin: origin,
      origin_lat: Number(originCoords[0]?.LAT || 0),
      origin_lon: Number(originCoords[0]?.LON || 0),
      resolution,
      destinations: rows,
    });
  } catch (err: any) {
    console.error('Reachability error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matrix/catchment', async (req, res) => {
  try {
    const resolution = Number(req.query.resolution) || 8;
    const origin = req.query.origin as string;
    const maxMinutes = Number(req.query.max_minutes) || 60;
    if (!origin) return res.status(400).json({ error: 'origin H3 index required' });
    if (![7, 8, 9].includes(resolution)) return res.status(400).json({ error: 'Resolution must be 7, 8, or 9' });

    const travelTable = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${resolution}`;
    const safeOrigin = origin.replace(/'/g, "''");
    const maxSecs = maxMinutes * 60;

    const sql = `
      WITH reachable AS (
        SELECT DEST_H3 AS HEX_ID, TRAVEL_TIME_SECONDS
        FROM ${travelTable}
        WHERE ORIGIN_H3 = '${safeOrigin}' AND TRAVEL_TIME_SECONDS IS NOT NULL AND TRAVEL_TIME_SECONDS <= ${maxSecs}
        UNION ALL
        SELECT ORIGIN_H3 AS HEX_ID, TRAVEL_TIME_SECONDS
        FROM ${travelTable}
        WHERE DEST_H3 = '${safeOrigin}' AND TRAVEL_TIME_SECONDS IS NOT NULL AND TRAVEL_TIME_SECONDS <= ${maxSecs}
      )
      SELECT
        d.RESTAURANT_NAME,
        d.CUISINE_TYPE,
        d.CITY,
        ST_X(d.RESTAURANT_LOCATION) AS REST_LON,
        ST_Y(d.RESTAURANT_LOCATION) AS REST_LAT,
        ST_X(d.CUSTOMER_LOCATION) AS CUST_LON,
        ST_Y(d.CUSTOMER_LOCATION) AS CUST_LAT,
        d.ORDER_STATUS,
        d.ORDER_ID,
        ROUND(MIN(r.TRAVEL_TIME_SECONDS) / 60, 1) AS DRIVE_MINS
      FROM ${SF_DATABASE}.DATA.DELIVERY_SUMMARY d
      JOIN reachable r ON H3_POINT_TO_CELL_STRING(d.RESTAURANT_LOCATION, ${resolution}) = r.HEX_ID
      GROUP BY 1,2,3,4,5,6,7,8,9
      ORDER BY DRIVE_MINS
      LIMIT 500`;

    console.log(`Fetching catchment from ${origin} at res${resolution}, max ${maxMinutes}min...`);
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} catchment deliveries`);

    const restaurants: Record<string, any> = {};
    const customers: any[] = [];

    for (const r of rows) {
      const name = r.RESTAURANT_NAME || 'Unknown';
      if (!restaurants[name]) {
        restaurants[name] = {
          name,
          cuisine: r.CUISINE_TYPE,
          city: r.CITY,
          lon: Number(r.REST_LON),
          lat: Number(r.REST_LAT),
          drive_mins: Number(r.DRIVE_MINS),
          orders: 0,
          active: 0,
        };
      }
      restaurants[name].orders++;
      if (r.ORDER_STATUS !== 'delivered') restaurants[name].active++;

      customers.push({
        lon: Number(r.CUST_LON),
        lat: Number(r.CUST_LAT),
        status: r.ORDER_STATUS,
        restaurant: name,
        drive_mins: Number(r.DRIVE_MINS),
      });
    }

    const restaurantList = Object.values(restaurants).sort((a: any, b: any) => b.orders - a.orders);

    res.json({
      origin,
      resolution,
      max_minutes: maxMinutes,
      total_deliveries: rows.length,
      restaurants: restaurantList,
      customers,
    });
  } catch (err: any) {
    console.error('Catchment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent', async (req, res) => {
  try {
    const { message, history } = req.body;
    const userQuestion = message || '';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'status', message: 'Analyzing your question...' });
    send({ type: 'thinking_delta', text: 'Interpreting your question and generating a data query...\n' });

    send({ type: 'tool_use', tool_name: 'fleet_data', tool_type: 'cortex_analyst_text_to_sql' });
    send({ type: 'status', message: 'Querying fleet intelligence data...' });

    console.log('Generating SQL for:', userQuestion.slice(0, 200));

    const systemPrompt = `You are a fleet intelligence analyst for SwiftBite, a food delivery company operating across 20 California cities. Generate a SQL query for the user's question.

Available tables in ${SF_DATABASE}.${SF_SCHEMA}:
- DELIVERY_SUMMARY: ORDER_ID, COURIER_ID, RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, CUSTOMER_ADDRESS, CITY, ORDER_TIME (TIMESTAMP), PICKUP_TIME (TIMESTAMP), DELIVERY_TIME (TIMESTAMP), ORDER_STATUS (values: 'delivered', 'in_transit', 'picked_up'), ROUTE_DISTANCE_METERS, ROUTE_DURATION_SECS, PREP_TIME_MINS, SHIFT_TYPE (Lunch/Dinner/Afternoon), VEHICLE_TYPE (car/scooter/bicycle), AVERAGE_KMH, MAX_KMH, GEOMETRY, RESTAURANT_LOCATION (GEOGRAPHY point), CUSTOMER_LOCATION (GEOGRAPHY point)
- COURIER_LOCATIONS: ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DROPOFF_TIME, RESTAURANT_LOCATION (GeoJSON Point), CUSTOMER_LOCATION (GeoJSON Point), ROUTE (GeoJSON LineString), POINT_GEOM (GeoJSON Point - current position), CURR_TIME, POINT_INDEX, COURIER_STATE (en_route, etc.), KMH, CITY
- ORDERS_ASSIGNED_TO_COURIERS: ORDER_ID, COURIER_ID, RESTAURANT_ID, RESTAURANT_NAME, CUSTOMER_ADDRESS, CITY, ORDER_TIME, ORDER_STATUS

TRAVEL TIME MATRIX TABLES (pre-computed drive times between H3 hexagons at multiple resolutions):
- CA_TRAVEL_TIME_RES7: ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS (1,406 pairs, ~36km hex size, strategic/inter-city)
- CA_TRAVEL_TIME_RES8: ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS (36,258 pairs, ~4.6km hex size, mid-range/cross-city)
- CA_TRAVEL_TIME_RES9: ORIGIN_H3, DEST_H3, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS (last-mile delivery, ~1.2km hex size — may have 0 rows if not yet flattened)
- CA_H3_RES7: H3_INDEX, CENTER_LAT, CENTER_LON (hexagon grid cells at res 7)
- CA_H3_RES8: H3_INDEX, CENTER_LAT, CENTER_LON (hexagon grid cells at res 8)
- CA_H3_RES9: H3_INDEX, CENTER_LAT, CENTER_LON (hexagon grid cells at res 9)

JOINING DELIVERIES WITH TRAVEL TIME MATRIX:
To find the H3 hex for a delivery location, use: H3_POINT_TO_CELL_STRING(location_geography, resolution)
Example: H3_POINT_TO_CELL_STRING(RESTAURANT_LOCATION, 8) gives the res-8 hex for a restaurant.

CRITICAL: Travel time data is stored ONE-DIRECTIONALLY. You MUST use a UNION ALL (bidirectional pattern) when looking up reachability from a hex:
  SELECT DEST_H3 AS HEX_ID, TRAVEL_TIME_SECONDS FROM CA_TRAVEL_TIME_RES8 WHERE ORIGIN_H3 = :hex
  UNION ALL
  SELECT ORIGIN_H3 AS HEX_ID, TRAVEL_TIME_SECONDS FROM CA_TRAVEL_TIME_RES8 WHERE DEST_H3 = :hex

For a point-to-point lookup between two hexes, check both orderings:
  WHERE (ORIGIN_H3 = :hex_a AND DEST_H3 = :hex_b) OR (ORIGIN_H3 = :hex_b AND DEST_H3 = :hex_a)

CRITICAL RULE — MATRIX CONTEXT HANDLING:
When the user's message contains [Matrix Context: ...], they have selected a hexagon origin on the map.
You MUST generate a SQL query that joins DELIVERY_SUMMARY with the travel time matrix to find deliveries near that hex.
Do NOT just describe the context. Do NOT return a trivial query. You MUST use the hex ID from the context to query real delivery data.

Use resolution 8 by default for travel time queries unless the user specifies otherwise.

REQUIRED SQL PATTERN when [Matrix Context] is present — adapt this template:
WITH reachable AS (
  SELECT DEST_H3 AS HEX_ID, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
  FROM ${SF_DATABASE}.${SF_SCHEMA}.CA_TRAVEL_TIME_RES8
  WHERE ORIGIN_H3 = '<origin_hex_from_context>'
  UNION ALL
  SELECT ORIGIN_H3 AS HEX_ID, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
  FROM ${SF_DATABASE}.${SF_SCHEMA}.CA_TRAVEL_TIME_RES8
  WHERE DEST_H3 = '<origin_hex_from_context>'
)
SELECT
  d.RESTAURANT_NAME,
  d.CUISINE_TYPE,
  d.CITY,
  d.ORDER_STATUS,
  ROUND(r.TRAVEL_TIME_SECONDS / 60, 1) AS DRIVE_MINS,
  ROUND(r.TRAVEL_DISTANCE_METERS / 1000, 1) AS DRIVE_KM,
  COUNT(*) AS ORDER_COUNT
FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY d
JOIN reachable r
  ON H3_POINT_TO_CELL_STRING(d.RESTAURANT_LOCATION, 8) = r.HEX_ID
GROUP BY 1,2,3,4,5,6
ORDER BY ORDER_COUNT DESC
LIMIT 50;

Replace '<origin_hex_from_context>' with the actual hex ID from the [Matrix Context].
Adapt the SELECT columns, WHERE filters, and GROUP BY to match what the user is asking about (e.g., nearby jobs, restaurants, couriers, delivery volume, etc.), but ALWAYS keep the reachable CTE and the JOIN pattern.

For time-series/trend queries, use DATE_TRUNC or HOUR(ORDER_TIME) to bucket time. For "delivery load over time" queries, count deliveries grouped by time bucket.

IMPORTANT: ORDER_STATUS can be 'delivered', 'in_transit', or 'picked_up'. Active/pending orders are those NOT 'delivered'. When the user asks about active, in-progress, pending, or not-yet-delivered orders, filter with ORDER_STATUS != 'delivered'.

You can also emit map_action commands to control the dashboard map. If the user asks to show active/in-transit orders on the map, or to filter the map, include a "map_action" field:
- {"sql": "...", "explanation": "...", "map_action": {"filter": "active"}} — show only active (non-delivered) routes on map
- {"sql": "...", "explanation": "...", "map_action": {"filter": "in_transit"}} — show only in_transit routes
- {"sql": "...", "explanation": "...", "map_action": {"filter": "all"}} — show all routes (reset filter)

Return ONLY a JSON object: {"sql": "SELECT ...", "explanation": "...", "map_action": {...} (optional)}
Keep queries efficient. Use fully qualified table names.`;

    let sqlStatement = '';
    let sqlExplanation = '';
    let mapAction: any = null;

    if (IS_SPCS) {
      try {
        const escapedSystem = systemPrompt.replace(/'/g, "\\'");
        const escapedUser = userQuestion.replace(/'/g, "\\'");
        const cortexSql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-3-5-sonnet', [{'role':'system','content':'${escapedSystem}'},{'role':'user','content':'${escapedUser}'}], {'max_tokens':1024}) as RESPONSE`;
        console.log('Calling CORTEX.COMPLETE via SQL for SQL gen...');
        const rows = await snowSqlSpcs(cortexSql);
        console.log('CORTEX.COMPLETE SQL gen returned rows:', rows.length);
        if (rows.length > 0) {
          const raw = rows[0].RESPONSE || rows[0][Object.keys(rows[0])[0]] || '';
          console.log('CORTEX.COMPLETE SQL gen raw preview:', String(raw).slice(0, 300));
          let content = '';
          try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            content = parsed.choices?.[0]?.messages || parsed.choices?.[0]?.message?.content || parsed.choices?.[0]?.content || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
          } catch {
            content = String(raw);
          }
          console.log('CORTEX.COMPLETE SQL gen content preview:', content.slice(0, 300));
          try {
            const jsonMatch = content.match(/\{[\s\S]*"sql"[\s\S]*\}/);
            if (jsonMatch) {
              const parsedJson = JSON.parse(jsonMatch[0]);
              sqlStatement = parsedJson.sql || '';
              sqlExplanation = parsedJson.explanation || '';
              mapAction = parsedJson.map_action || null;
            }
          } catch {}
        }
      } catch (cortexErr: any) {
        console.error('CORTEX.COMPLETE SQL gen exception:', cortexErr.name, cortexErr.message);
      }
    } else {
      let result = '';
      try {
        result = cortexCompleteLocalFile([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userQuestion },
        ], 'claude-3-5-sonnet');
      } catch (e: any) {
        console.error('cortexCompleteLocalFile error:', e.message?.slice(0, 300));
      }
      try {
        const jsonMatch = result.match(/\{[\s\S]*"sql"[\s\S]*\}/);
        if (jsonMatch) {
          const sanitized = jsonMatch[0].replace(/(?<="[^"]*)\n(?=[^"]*")/g, '\\n').replace(/[\x00-\x1f]/g, (ch: string) => ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '');
          let parsed: any;
          try {
            parsed = JSON.parse(sanitized);
          } catch {
            const lines = result.split('\n');
            let sqlLines: string[] = [];
            let explanation = '';
            let inSql = false;
            for (const line of lines) {
              const sqlStart = line.match(/"sql"\s*:\s*"(.*)/);
              if (sqlStart) { inSql = true; sqlLines.push(sqlStart[1]); continue; }
              if (inSql) {
                const endMatch = line.match(/^(.*)",?\s*$/);
                if (endMatch) { sqlLines.push(endMatch[1]); inSql = false; continue; }
                sqlLines.push(line);
              }
              const expMatch = line.match(/"explanation"\s*:\s*"(.*)"/);
              if (expMatch) explanation = expMatch[1];
            }
            parsed = { sql: sqlLines.join(' ').replace(/\\n/g, ' ').trim(), explanation };
          }
          sqlStatement = parsed.sql || '';
          sqlExplanation = parsed.explanation || '';
          mapAction = parsed.map_action || null;
        } else {
          console.error('No JSON match in cortex result. Full result:', result.slice(0, 1000));
        }
      } catch (parseErr: any) {
        console.error('JSON parse error:', parseErr.message, 'from:', result.slice(0, 500));
      }
    }

    if (mapAction) {
      send({ type: 'map_filter', filter: mapAction.filter || 'all' });
    }

    let queryResults: any[] = [];
    let queryError = '';

    if (sqlStatement) {
      sqlStatement = sqlStatement.replace(/;\s*$/, '');
      console.log('Generated SQL (full):', sqlStatement);
      send({ type: 'thinking_delta', text: `Generated SQL query. Executing...\n` });
      const toolResult: any = { type: 'tool_result', tool_name: 'fleet_data', status: 'complete', sql: sqlStatement };
      if (sqlExplanation) toolResult.sql_explanation = sqlExplanation;

      try {
        queryResults = await snowSql(sqlStatement);
        toolResult.has_results = true;
        toolResult.row_count = queryResults.length;
        console.log(`SQL returned ${queryResults.length} rows`);
      } catch (sqlErr: any) {
        queryError = sqlErr.message;
        toolResult.status = 'error';
        console.error('SQL execution error:', queryError);
      }
      send(toolResult);
    } else {
      send({ type: 'tool_result', tool_name: 'fleet_data', status: 'error' });
    }

    send({ type: 'status', message: 'Generating response...' });

    const responsePrompt = `You are a fleet intelligence analyst for SwiftBite food delivery. Present data clearly with context.
Use markdown formatting with proper GFM tables when showing tabular data. Provide specific numbers and percentages when available.
If the data query returned no results (0 rows), say clearly that no data was found. Do NOT make up or hallucinate data. If the tables are empty, explain that the delivery data has not been built yet and suggest running the data build process.

IMPORTANT: When the query results contain time-series, trend, or comparative data that would benefit from visualization, include a chart block in your response.
Chart blocks use this exact format (the JSON must be valid):

\`\`\`chart
{
  "type": "line",
  "title": "Chart Title",
  "xKey": "column_name_for_x_axis",
  "yKeys": [{"key": "column_name", "label": "Display Label"}],
  "data": [{"column_name_for_x_axis": "value1", "column_name": 123}, ...]
}
\`\`\`

Rules for charts:
- Use type "line" for time-series/trends, "bar" for comparisons/rankings
- The data array should contain the actual query result values (extract from the query results provided)
- xKey must match a key in each data object
- yKeys array lists the numeric columns to plot, each with a "key" and optional "label"
- Keep data to at most 30 rows for readability
- Always include a descriptive title
- You can include both a markdown table AND a chart in the same response
- For time data, format dates/times as short readable strings (e.g. "17:00", "Jan 15", "Mon")`;

    let dataContext = '';
    if (queryResults.length > 0) {
      const maxRows = queryResults.slice(0, 50);
      dataContext = `\n\nQuery results (${queryResults.length} rows):\n${JSON.stringify(maxRows, null, 2)}`;
      if (sqlStatement) dataContext = `\nSQL executed: ${sqlStatement}` + dataContext;
    } else if (queryError) {
      dataContext = `\n\nThe data query failed: ${queryError}`;
    } else if (sqlStatement) {
      dataContext = `\nSQL executed: ${sqlStatement}\n\nThe query returned 0 rows. The data tables are currently empty — no delivery data has been generated yet. Do NOT make up or invent any data. Tell the user the tables are empty and they need to build data first.`;
    }

    if (IS_SPCS) {
      try {
        const escapedSys = responsePrompt.replace(/'/g, "\\'");
        const userContent = `${userQuestion}${dataContext}`.replace(/'/g, "\\'");
        const cortexSql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-3-5-sonnet', [{'role':'system','content':'${escapedSys}'},{'role':'user','content':'${userContent}'}], {'max_tokens':2048}) as RESPONSE`;
        console.log('Calling CORTEX.COMPLETE via SQL for response gen...');
        const rows = await snowSqlSpcs(cortexSql);
        console.log('CORTEX.COMPLETE response gen returned rows:', rows.length);
        if (rows.length > 0) {
          const raw = rows[0].RESPONSE || rows[0][Object.keys(rows[0])[0]] || '';
          let content = '';
          try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            content = parsed.choices?.[0]?.messages || parsed.choices?.[0]?.message?.content || parsed.choices?.[0]?.content || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
          } catch {
            content = String(raw);
          }
          if (content) {
            send({ type: 'text_delta', text: content });
          } else {
            send({ type: 'text_delta', text: sqlExplanation || 'I was unable to generate a response.' });
          }
        } else {
          send({ type: 'text_delta', text: sqlExplanation || 'I was unable to generate a response.' });
        }
      } catch (cortexErr: any) {
        console.error('CORTEX.COMPLETE response gen exception:', cortexErr.name, cortexErr.message);
        send({ type: 'text_delta', text: sqlExplanation || 'I encountered an error generating a response.' });
      }
    } else {
      const result = cortexCompleteLocalFile([
        { role: 'system', content: responsePrompt },
        { role: 'user', content: `${userQuestion}${dataContext}` },
      ], 'claude-3-5-sonnet');
      if (result) {
        send({ type: 'text_delta', text: result });
      } else {
        send({ type: 'text_delta', text: sqlExplanation || 'I was unable to generate a response.' });
      }
    }

    send({ type: 'done' });
    res.end();
  } catch (err: any) {
    console.error('Agent error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
});

const ORS_REGION_BOUNDS: Record<string, { minLat: number; maxLat: number; minLon: number; maxLon: number; label: string }> = {
  London: { minLat: 51.28, maxLat: 51.69, minLon: -0.51, maxLon: 0.33, label: 'London' },
  Paris: { minLat: 48.81, maxLat: 48.90, minLon: 2.22, maxLon: 2.47, label: 'Paris' },
  Berlin: { minLat: 52.34, maxLat: 52.68, minLon: 13.09, maxLon: 13.76, label: 'Berlin' },
  NewYork: { minLat: 40.49, maxLat: 40.92, minLon: -74.26, maxLon: -73.70, label: 'New York' },
  Chicago: { minLat: 41.64, maxLat: 42.02, minLon: -87.94, maxLon: -87.52, label: 'Chicago' },
  SanFrancisco: { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37, label: 'San Francisco' },
  LosAngeles: { minLat: 33.70, maxLat: 34.34, minLon: -118.67, maxLon: -117.65, label: 'Los Angeles' },
  SanJose: { minLat: 37.12, maxLat: 37.47, minLon: -122.05, maxLon: -121.72, label: 'San Jose' },
  Sacramento: { minLat: 38.43, maxLat: 38.70, minLon: -121.56, maxLon: -121.35, label: 'Sacramento' },
  SantaBarbara: { minLat: 34.38, maxLat: 34.46, minLon: -119.78, maxLon: -119.63, label: 'Santa Barbara' },
  Stockton: { minLat: 37.90, maxLat: 38.05, minLon: -121.38, maxLon: -121.20, label: 'Stockton' },
};

app.get('/api/matrix/regions', async (_req, res) => {
  try {
    const regions: any[] = [];

    let services: any[] = [];
    try {
      services = await snowSql(`SHOW SERVICES IN SCHEMA ${SF_DATABASE}.ROUTING`);
    } catch {}

    let functions: any[] = [];
    try {
      functions = await snowSql(`SHOW FUNCTIONS IN SCHEMA ${SF_DATABASE}.ROUTING`);
    } catch {}

    for (const [regionKey, bounds] of Object.entries(ORS_REGION_BOUNDS)) {
      const isSF = regionKey === 'SanFrancisco';
      const svcName = isSF ? 'ORS_SERVICE' : `ORS_SERVICE_${regionKey.toUpperCase()}`;
      const matrixFnName = isSF ? 'MATRIX_TABULAR' : `MATRIX_${regionKey.toUpperCase()}`;
      const dirFnName = isSF ? 'DIRECTIONS' : `DIRECTIONS_${regionKey.toUpperCase()}`;

      const svc = services.find((r: any) => (r.name || r.NAME) === svcName);
      const svcStatus = svc ? (svc.status || svc.STATUS || 'UNKNOWN') : 'NOT_FOUND';
      const svcExists = !!svc;

      const matrixFnExists = functions.some((f: any) => {
        const name = f.arguments || f.ARGUMENTS || '';
        return name.startsWith(matrixFnName + '(');
      });
      const dirFnExists = functions.some((f: any) => {
        const name = f.arguments || f.ARGUMENTS || '';
        return name.startsWith(dirFnName + '(');
      });

      const ready = (svcStatus === 'RUNNING' || svcStatus === 'SUSPENDED') && matrixFnExists && dirFnExists;
      const provisioned = svcExists;

      regions.push({
        region: regionKey,
        label: bounds.label,
        bounds: { minLat: bounds.minLat, maxLat: bounds.maxLat, minLon: bounds.minLon, maxLon: bounds.maxLon },
        serviceStatus: svcStatus,
        serviceExists: svcExists,
        matrixFunctionExists: matrixFnExists,
        directionsFunctionExists: dirFnExists,
        ready,
        provisioned,
        matrixFn: isSF ? 'routing.MATRIX_TABULAR' : `routing.MATRIX_${regionKey.toUpperCase()}`,
        cities: ORS_REGION_CONFIG[regionKey]?.cities || [],
      });
    }

    res.json({ regions });
  } catch (err: any) {
    res.status(500).json({ error: err.message, regions: [] });
  }
});

const matrixBuildJobs: Record<string, { region: string; resolutions: number[]; started: number; statuses: Record<number, any> }> = {};

app.get('/api/matrix/existing', async (req, res) => {
  try {
    const region = req.query.region as string || '';
    const counts: Record<string, number> = {};
    for (const tbl of ['CA_TRAVEL_TIME_RES7', 'CA_TRAVEL_TIME_RES8', 'CA_TRAVEL_TIME_RES9']) {
      try {
        const where = region ? ` WHERE REGION = '${region}'` : '';
        const rows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.DATA.${tbl}${where}`);
        counts[tbl] = Number(rows[0]?.CNT || 0);
      } catch {
        counts[tbl] = 0;
      }
    }
    res.json(counts);
  } catch (err: any) {
    res.json({});
  }
});

app.post('/api/matrix/build', async (req, res) => {
  try {
    const { region, resolutions } = req.body;
    if (!region || !resolutions?.length) {
      return res.status(400).json({ error: 'region and resolutions required' });
    }

    const bounds = ORS_REGION_BOUNDS[region];
    if (!bounds) {
      return res.status(400).json({ error: `Unknown region: ${region}` });
    }

    const isSF = region === 'SanFrancisco';
    const matrixFn = isSF ? 'routing.MATRIX_TABULAR' : `routing.MATRIX_${region.toUpperCase()}`;

    const svcName = isSF ? 'ORS_SERVICE' : `ORS_SERVICE_${region.toUpperCase()}`;
    try {
      const svcs = await snowSql(`SHOW SERVICES LIKE '${svcName}' IN SCHEMA ${SF_DATABASE}.ROUTING`);
      const svc = svcs.find((r: any) => (r.name || r.NAME) === svcName);
      const status = (svc?.status || svc?.STATUS || '').toUpperCase();
      if (status === 'SUSPENDED') {
        console.log(`Auto-resuming suspended ORS service ${svcName} for matrix build...`);
        await snowSql(`ALTER SERVICE ${SF_DATABASE}.ROUTING.${svcName} RESUME`);
        for (let i = 0; i < 60; i++) {
          const rows = await snowSql(`SHOW SERVICES LIKE '${svcName}' IN SCHEMA ${SF_DATABASE}.ROUTING`);
          const row = rows.find((r: any) => (r.name || r.NAME) === svcName);
          if (row && (row.status || row.STATUS) === 'RUNNING') {
            console.log(`ORS service ${svcName} is now RUNNING`);
            break;
          }
          await new Promise((r) => setTimeout(r, 10000));
        }
      }
    } catch (err: any) {
      console.error(`Failed to check/resume ORS service: ${err.message}`);
    }

    const jobId = `${region}_${Date.now()}`;
    const statuses: Record<number, any> = {};
    for (const r of resolutions) {
      statuses[r] = {
        resolution: r,
        status: 'building',
        stage: 'STARTING',
        total_origins: 0,
        processed_origins: 0,
        total_pairs: 0,
        built_pairs: 0,
        percent_complete: 0,
        elapsed_seconds: 0,
        est_remaining_seconds: 0,
        hexagons: 0,
        work_queue: 0,
        raw_ingested: 0,
        flattened: 0,
      };
    }
    matrixBuildJobs[region] = { region, resolutions, started: Date.now(), statuses };

    for (const r of resolutions) {
      (async () => {
        try {
          statuses[r].stage = 'BUILDING';
          const result = await snowSql(
            `CALL ${SF_DATABASE}.DATA.BUILD_MATRIX_FOR_REGION('RES${r}', ${bounds.minLat}, ${bounds.maxLat}, ${bounds.minLon}, ${bounds.maxLon}, '${matrixFn}', '${region}')`
          );
          const returnVal = result[0]?.[Object.keys(result[0])[0]] || '';
          console.log(`Build RES${r} for ${region} returned: ${returnVal}`);

          let progressData: any = {};
          try {
            const rows = await snowSql(`CALL ${SF_DATABASE}.DATA.MATRIX_PROGRESS()`);
            const raw = rows[0]?.MATRIX_PROGRESS || rows[0]?.[Object.keys(rows[0])[0]] || '{}';
            progressData = typeof raw === 'string' ? JSON.parse(raw) : raw;
          } catch {}
          const p = progressData[`RES${r}`] || {};
          const flattened = Number(p.flattened || 0);

          if (flattened > 0) {
            statuses[r].status = 'complete';
            statuses[r].stage = 'COMPLETE';
            statuses[r].percent_complete = 100;
            statuses[r].flattened = flattened;
            statuses[r].raw_ingested = Number(p.raw_ingested || 0);
            statuses[r].total_pairs = flattened;
            statuses[r].built_pairs = flattened;
          } else {
            statuses[r].status = 'error';
            statuses[r].stage = 'NO_DATA';
            statuses[r].error = `Build completed but produced 0 travel time pairs. Raw ingested: ${Number(p.raw_ingested || 0)}. Is ORS service running?`;
            statuses[r].raw_ingested = Number(p.raw_ingested || 0);
            statuses[r].flattened = 0;
          }

          statuses[r].summary = {
            hexagons: Number(p.hexagons || 0),
            work_queue: Number(p.work_queue || 0),
            raw_ingested: Number(p.raw_ingested || 0),
            flattened,
            returnValue: returnVal,
          };
        } catch (err: any) {
          statuses[r].status = 'error';
          statuses[r].stage = 'ERROR';
          statuses[r].error = err.message?.slice(0, 200);
        }
      })();
    }

    res.json({ status: 'started', jobId, region });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matrix/status', async (req, res) => {
  try {
    const region = req.query.region as string;
    const job = matrixBuildJobs[region];

    let progressData: any = {};
    try {
      const rows = await snowSql(`CALL ${SF_DATABASE}.DATA.MATRIX_PROGRESS()`);
      const raw = rows[0]?.MATRIX_PROGRESS || rows[0]?.[Object.keys(rows[0])[0]] || '{}';
      progressData = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {}

    if (!job) {
      const resolutions = [7, 8, 9].map((r) => {
        const resKey = `RES${r}`;
        const p = progressData[resKey] || {};
        return {
          resolution: r,
          status: p.stage === 'COMPLETE' ? 'complete' : (p.stage === 'NOT_STARTED' ? 'idle' : 'building'),
          stage: p.stage || 'NOT_STARTED',
          hexagons: Number(p.hexagons || 0),
          work_queue: Number(p.work_queue || 0),
          raw_ingested: Number(p.raw_ingested || 0),
          flattened: Number(p.flattened || 0),
          total_pairs: Number(p.flattened || 0),
          built_pairs: Number(p.flattened || 0),
          percent_complete: Number(p.pct || 0),
          elapsed_seconds: 0,
          est_remaining_seconds: 0,
        };
      });
      return res.json({ region: region || 'unknown', resolutions });
    }

    for (const r of job.resolutions) {
      const resKey = `RES${r}`;
      const p = progressData[resKey] || {};
      const s = job.statuses[r];
      s.hexagons = Number(p.hexagons || 0);
      s.work_queue = Number(p.work_queue || 0);
      s.raw_ingested = Number(p.raw_ingested || 0);
      s.flattened = Number(p.flattened || 0);
      s.total_origins = Number(p.work_queue || 0);
      s.processed_origins = Number(p.raw_ingested || 0);

      const elapsed = (Date.now() - job.started) / 1000;
      s.elapsed_seconds = elapsed;

      if (s.status !== 'complete' && s.status !== 'error') {
        s.stage = p.stage || 'STARTING';
        s.percent_complete = Number(p.pct || 0);
        if (s.work_queue > 0 && s.raw_ingested > 0 && s.raw_ingested < s.work_queue) {
          const rate = s.raw_ingested / elapsed;
          s.est_remaining_seconds = rate > 0 ? (s.work_queue - s.raw_ingested) / rate : 0;
        }
        s.total_pairs = s.work_queue;
        s.built_pairs = s.raw_ingested;
      } else if (s.status === 'complete') {
        s.stage = 'COMPLETE';
        s.percent_complete = 100;
        s.total_pairs = s.flattened || s.work_queue;
        s.built_pairs = s.flattened || s.work_queue;
      }
    }

    res.json({
      region,
      resolutions: Object.values(job.statuses),
    });
  } catch (err: any) {
    res.json({ region: req.query.region, resolutions: [] });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: IS_SPCS ? 'spcs' : 'local' });
});

app.delete('/api/matrix/remove', async (req, res) => {
  try {
    const resolutions = (req.query.resolutions as string || '7,8,9').split(',').map(Number);
    const region = req.query.region as string || '';
    const results: Record<string, { table: string; rows_before: number; status: string }> = {};

    for (const r of resolutions) {
      const travelTable = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${r}`;
      const key = `CA_TRAVEL_TIME_RES${r}`;
      try {
        if (region) {
          const countRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${travelTable} WHERE REGION = '${region}'`);
          const rowsBefore = Number(countRows[0]?.CNT || 0);
          await snowSql(`DELETE FROM ${travelTable} WHERE REGION = '${region}'`);
          results[key] = { table: travelTable, rows_before: rowsBefore, status: 'removed' };
        } else {
          const countRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${travelTable}`);
          const rowsBefore = Number(countRows[0]?.CNT || 0);
          await snowSql(`TRUNCATE TABLE ${travelTable}`);
          results[key] = { table: travelTable, rows_before: rowsBefore, status: 'removed' };
        }
      } catch (err: any) {
        results[key] = { table: travelTable, rows_before: 0, status: 'error' };
      }
    }

    res.json({ status: 'removed', region: region || 'ALL', resolutions: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matrix/restore', async (req, res) => {
  try {
    const { resolutions = [7, 8, 9], offset_minutes = 5, region = '' } = req.body;
    const results: Record<string, { table: string; rows_restored: number; status: string }> = {};

    for (const r of resolutions) {
      const travelTable = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${r}`;
      const key = `CA_TRAVEL_TIME_RES${r}`;
      try {
        if (region) {
          await snowSql(`INSERT INTO ${travelTable} SELECT * FROM ${travelTable} AT(OFFSET => -${offset_minutes * 60}) WHERE REGION = '${region}'`);
        } else {
          await snowSql(`INSERT INTO ${travelTable} SELECT * FROM ${travelTable} AT(OFFSET => -${offset_minutes * 60})`);
        }
        const countRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${travelTable}${region ? ` WHERE REGION = '${region}'` : ''}`);
        const rowsRestored = Number(countRows[0]?.CNT || 0);
        results[key] = { table: travelTable, rows_restored: rowsRestored, status: 'restored' };
      } catch (err: any) {
        results[key] = { table: travelTable, rows_restored: 0, status: 'error' };
      }
    }

    res.json({ status: 'restored', region: region || 'ALL', resolutions: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// SPCS SERVICE MANAGEMENT
// =============================================================================

app.get('/api/services/status', async (_req, res) => {
  try {
    const services: Record<string, { name: string; status: string; schema: string }> = {};
    const targets = [
      { name: 'ORS_SERVICE', schema: 'ROUTING' },
      { name: 'FLEET_INTELLIGENCE_SERVICE', schema: 'CORE' },
    ];
    for (const svc of targets) {
      try {
        const rows = await snowSql(`SHOW SERVICES LIKE '${svc.name}' IN SCHEMA ${SF_DATABASE}.${svc.schema}`);
        const row = rows.find((r: any) => r.name === svc.name || r.NAME === svc.name);
        const status = row?.status || row?.STATUS || row?.database_name ? 'UNKNOWN' : 'NOT_FOUND';
        services[svc.name] = { name: svc.name, status: row?.status || row?.STATUS || status, schema: svc.schema };
      } catch {
        services[svc.name] = { name: svc.name, status: 'NOT_FOUND', schema: svc.schema };
      }
    }
    res.json(services);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/services/start', async (req, res) => {
  try {
    const results: Record<string, { name: string; action: string; status: string; error?: string }> = {};
    const targets = [
      { name: 'ORS_SERVICE', schema: 'ROUTING' },
      { name: 'FLEET_INTELLIGENCE_SERVICE', schema: 'CORE' },
    ];
    for (const svc of targets) {
      try {
        const rows = await snowSql(`SHOW SERVICES LIKE '${svc.name}' IN SCHEMA ${SF_DATABASE}.${svc.schema}`);
        const row = rows.find((r: any) => r.name === svc.name || r.NAME === svc.name);
        const currentStatus = (row?.status || row?.STATUS || '').toUpperCase();
        if (currentStatus === 'RUNNING' || currentStatus === 'READY') {
          results[svc.name] = { name: svc.name, action: 'none', status: currentStatus };
        } else {
          await snowSql(`ALTER SERVICE ${SF_DATABASE}.${svc.schema}.${svc.name} RESUME`);
          results[svc.name] = { name: svc.name, action: 'resumed', status: 'RESUMING' };
        }
      } catch (err: any) {
        results[svc.name] = { name: svc.name, action: 'error', status: 'ERROR', error: err.message?.slice(0, 200) };
      }
    }
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// PER-CITY ORS PROVISIONING + DATA BUILD
// =============================================================================

const DATA_BUILD_STEPS = [
  { id: 'restaurants', label: 'Load Restaurants' },
  { id: 'addresses', label: 'Load Addresses' },
  { id: 'couriers', label: 'Create Couriers' },
  { id: 'orders', label: 'Generate Orders' },
  { id: 'routes', label: 'Generate ORS Routes' },
  { id: 'geometries', label: 'Parse Routes & Geometries' },
  { id: 'locations', label: 'Interpolate Courier Locations' },
];

function getCityProvisionState(city: string): CityProvisionState {
  if (!cityProvisionStates[city]) {
    cityProvisionStates[city] = { status: 'idle', orsRegion: getOrsRegion(city) };
  }
  return cityProvisionStates[city];
}

function updateCityState(city: string, update: Partial<CityProvisionState>) {
  if (!cityProvisionStates[city]) {
    cityProvisionStates[city] = { status: 'idle', orsRegion: getOrsRegion(city) };
  }
  Object.assign(cityProvisionStates[city], update);
}

function updateCityDataStep(city: string, step: string, update: Partial<CityProvisionState['dataSteps'][0]>) {
  const state = getCityProvisionState(city);
  if (!state.dataSteps) return;
  const s = state.dataSteps.find((x) => x.step === step);
  if (s) Object.assign(s, update);
}

async function checkOrsRegionReady(region: string): Promise<{ serviceExists: boolean; serviceStatus: string; pbfExists: boolean; functionExists: boolean }> {
  const svcName = region === 'SanFrancisco' ? 'ORS_SERVICE' : `ORS_SERVICE_${region.toUpperCase()}`;
  const gwName = region === 'SanFrancisco' ? 'ROUTING_GATEWAY_SERVICE' : `ROUTING_GATEWAY_${region.toUpperCase()}`;
  let serviceExists = false, serviceStatus = 'NOT_FOUND', pbfExists = false, functionExists = false;

  try {
    const rows = await snowSql(`SHOW SERVICES LIKE '${svcName}' IN SCHEMA ${SF_DATABASE}.ROUTING`);
    const row = rows.find((r: any) => (r.name || r.NAME) === svcName);
    if (row) { serviceExists = true; serviceStatus = row.status || row.STATUS || 'UNKNOWN'; }
  } catch {}

  try {
    const regionCfg = ORS_REGION_CONFIG[region];
    if (regionCfg) {
      const rows = await snowSql(`LIST @${SF_DATABASE}.ROUTING.ORS_SPCS_STAGE/${region}/`);
      pbfExists = rows.some((r: any) => (r.name || '').includes('.osm.pbf'));
    }
    if (!pbfExists && region === 'SanFrancisco') {
      const rows = await snowSql(`LIST @${SF_DATABASE}.ROUTING.ORS_SPCS_STAGE/California/`);
      pbfExists = rows.some((r: any) => (r.name || '').includes('.osm.pbf'));
    }
  } catch {
    if (serviceExists && serviceStatus === 'RUNNING') pbfExists = true;
  }

  try {
    const fnName = region === 'SanFrancisco' ? 'DIRECTIONS' : `DIRECTIONS_${region.toUpperCase()}`;
    const rows = await snowSql(`SHOW FUNCTIONS LIKE '${fnName}' IN SCHEMA ${SF_DATABASE}.ROUTING`);
    functionExists = rows.length > 0;
  } catch {}

  return { serviceExists, serviceStatus, pbfExists, functionExists };
}

app.get('/api/city/:city/status', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const config = CITY_ORS_MAP[city];
    if (!config) return res.status(404).json({ error: `Unknown city: ${city}` });

    const region = config.orsRegion;
    const regionStatus = await checkOrsRegionReady(region);
    const provisionState = getCityProvisionState(city);

    let hasData = false;
    try {
      const rows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE CITY = '${city.replace(/'/g, "''")}'`);
      hasData = Number(rows[0]?.CNT || 0) > 0;
    } catch {}

    let downloaderReady = false;
    try {
      const rows = await snowSql(`SHOW FUNCTIONS LIKE 'DOWNLOAD_PBF' IN SCHEMA ${SF_DATABASE}.ROUTING`);
      downloaderReady = rows.length > 0;
    } catch {}

    res.json({
      city,
      region,
      orsServiceStatus: regionStatus.serviceStatus,
      orsServiceExists: regionStatus.serviceExists,
      pbfDownloaded: regionStatus.pbfExists,
      directionsFunctionExists: regionStatus.functionExists,
      downloaderReady,
      orsReady: regionStatus.serviceStatus === 'RUNNING' && regionStatus.functionExists,
      hasData,
      provisionState: provisionState.status,
      provisionMessage: provisionState.message,
      provisionError: provisionState.error,
      dataSteps: provisionState.dataSteps,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function provisionOrsForRegion(region: string): Promise<void> {
  const DB = SF_DATABASE;
  const regionCfg = ORS_REGION_CONFIG[region];
  if (!regionCfg) throw new Error(`Unknown ORS region: ${region}`);

  const isSF = region === 'SanFrancisco';
  const svcName = isSF ? 'ORS_SERVICE' : `ORS_SERVICE_${region.toUpperCase()}`;
  const stageDir = region;

  const existing = await checkOrsRegionReady(region);
  if (existing.serviceStatus === 'RUNNING' && existing.functionExists) {
    return;
  }

  if (!existing.pbfExists) {
    const pbfUrl = regionCfg.pbfUrl;
    const pbfFilename = regionCfg.pbfFilename;
    const targetName = `${region}.osm.pbf`;

    try { await snowSql(`CALL ${DB}.ROUTING.CREATE_STAGES()`); } catch (e: any) {
      console.log('create_stages call info:', e.message?.slice(0, 200));
    }

    if (!isSF) {
      let downloaderReady = false;
      try {
        const rows = await snowSql(`SHOW FUNCTIONS LIKE 'DOWNLOAD_PBF' IN SCHEMA ${DB}.ROUTING`);
        downloaderReady = rows.length > 0;
      } catch {}

      if (!downloaderReady) {
        try {
          await snowSql(`CALL ${DB}.ROUTING.START_DOWNLOADER()`);
          downloaderReady = true;
        } catch (e: any) {
          console.log('start_downloader failed (EAI may not be granted):', e.message?.slice(0, 200));
        }
      }

      if (downloaderReady) {
        try {
          await snowSql(`SELECT ${DB}.ROUTING.DOWNLOAD_PBF('ors_spcs_stage/${stageDir}', '${targetName}', '${pbfUrl}')`);
        } catch (e: any) {
          console.log('DOWNLOAD_PBF failed, trying local download+PUT fallback:', e.message?.slice(0, 200));
          await downloadPbfLocally(pbfUrl, targetName, stageDir, DB);
        }
      } else {
        await downloadPbfLocally(pbfUrl, targetName, stageDir, DB);
      }
    }

    const orsConfigYaml = `ors:
  engine:
    profile_default:
      build:
        source_file: /home/ors/files/${targetName}
        instructions: false
        maximum_visited_nodes: 100000000
    profiles:
      driving-car:
        enabled: true
      driving-hgv:
        enabled: true
      cycling-regular:
        enabled: true
      cycling-road:
        enabled: true
  endpoints:
    matrix:
      maximum_visited_nodes: 100000000
      maximum_routes: 250000`;

    const tmpConfigDir = join(tmpdir(), `ors_stage_${region}_${Date.now()}`);
    mkdirSync(tmpConfigDir, { recursive: true });
    const tmpConfigFile = join(tmpConfigDir, 'ors-config.yml');
    writeFileSync(tmpConfigFile, orsConfigYaml);
    try {
      await execAsync(`snow sql -c ${CONN} -q "PUT 'file://${tmpConfigFile}' @${DB}.ROUTING.ORS_SPCS_STAGE/${stageDir}/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE" 2>/dev/null`);
    } finally {
      try { unlinkSync(tmpConfigFile); rmSync(tmpConfigDir, { recursive: true, force: true }); } catch {}
    }
  }

  if (!existing.serviceExists || existing.serviceStatus === 'SUSPENDED') {
    if (!isSF) {
      await snowSql(`CALL ${DB}.ROUTING.CREATE_CITY_ORS_SERVICE('${region}')`);
    } else if (existing.serviceStatus === 'SUSPENDED') {
      await snowSql(`CALL ${DB}.ROUTING.SETUP_ORS()`);
    }
  }

  for (let i = 0; i < 60; i++) {
    try {
      const rows = await snowSql(`SHOW SERVICES LIKE '${svcName}' IN SCHEMA ${DB}.ROUTING`);
      const row = rows.find((r: any) => (r.name || r.NAME) === svcName);
      if (row && (row.status || row.STATUS) === 'RUNNING') break;
    } catch {}
    await new Promise((r) => setTimeout(r, 10000));
  }

  if (!existing.functionExists) {
    if (!isSF) {
      await snowSql(`CALL ${DB}.ROUTING.CREATE_CITY_FUNCTIONS('${region}')`);
    } else {
      await snowSql(`CALL ${DB}.ROUTING.CREATE_FUNCTIONS()`);
    }
  }
}

async function downloadPbfLocally(pbfUrl: string, targetName: string, stageDir: string, db: string): Promise<void> {
  const tmpPbfDir = join(tmpdir(), `pbf_stage_${Date.now()}`);
  mkdirSync(tmpPbfDir, { recursive: true });
  const tmpPbf = join(tmpPbfDir, targetName);
  try {
    console.log(`Downloading PBF locally: ${pbfUrl}`);
    await execAsync(`curl -L -o "${tmpPbf}" "${pbfUrl}"`, { timeout: 600000 });
    console.log(`Uploading PBF to stage: @${db}.ROUTING.ORS_SPCS_STAGE/${stageDir}/`);
    await execAsync(`snow sql -c ${CONN} -q "PUT 'file://${tmpPbf}' @${db}.ROUTING.ORS_SPCS_STAGE/${stageDir}/ AUTO_COMPRESS=FALSE OVERWRITE=TRUE" 2>/dev/null`, { timeout: 600000 });
    console.log('PBF uploaded successfully');
  } catch (e: any) {
    throw new Error(`Failed to download/upload PBF for ${stageDir}: ${e.message?.slice(0, 300)}`);
  } finally {
    try { unlinkSync(tmpPbf); rmSync(tmpPbfDir, { recursive: true, force: true }); } catch {}
  }
}

function getDirectionsFn(city: string): string {
  const region = getOrsRegion(city);
  if (region === 'SanFrancisco') return `${SF_DATABASE}.ROUTING.DIRECTIONS`;
  return `${SF_DATABASE}.ROUTING.DIRECTIONS_${region.toUpperCase()}`;
}

app.post('/api/city/:city/provision', async (req, res) => {
  const city = decodeURIComponent(req.params.city);
  const config = CITY_ORS_MAP[city];
  if (!config) return res.status(404).json({ error: `Unknown city: ${city}` });

  const today = new Date().toISOString().slice(0, 10);
  const { num_couriers = 50, num_days = 1, start_date = today, shifts } = req.body || {};
  const region = config.orsRegion;

  if (cityProvisionStates[city]?.status !== 'idle' && cityProvisionStates[city]?.status !== 'error' && cityProvisionStates[city]?.status !== 'complete') {
    return res.status(409).json({ error: 'Provisioning already in progress', state: cityProvisionStates[city] });
  }

  updateCityState(city, { status: 'building_data', message: 'Starting data build...', started_at: Date.now(), error: undefined, dataSteps: undefined });
  res.json({ status: 'started', city, region });

  (async () => {
    try {
      const regionStatus = await checkOrsRegionReady(region);
      let orsPromise: Promise<void> | null = null;
      if (regionStatus.serviceStatus === 'RUNNING' && regionStatus.functionExists) {
        // ORS already ready, no need to provision
      } else {
        orsPromise = provisionOrsForRegion(region).catch((e: any) => {
          throw new Error(`ORS provisioning failed: ${e.message?.slice(0, 400)}`);
        });
      }

      await runCityDataBuild(city, { num_couriers, num_days, start_date, shifts, orsPromise });
      updateCityState(city, { status: 'complete', message: `Data build complete for ${city}` });
    } catch (err: any) {
      updateCityState(city, { status: 'error', error: err.message?.slice(0, 500), message: 'Build failed' });
    }
  })();
});

async function runCityDataBuild(city: string, opts: { num_couriers: number; num_days: number; start_date: string; shifts?: any; orsPromise?: Promise<void> | null }) {
  const DB = SF_DATABASE;
  const { num_couriers, num_days, start_date } = opts;
  const cityList = `'${city.replace(/'/g, "''")}'`;
  const routingFn = getDirectionsFn(city);
  const cityConfig = CITY_ORS_MAP[city];
  const cityState = cityConfig?.state || 'CA';
  const cityCountry = cityConfig?.country || 'US';
  const cityBbox = cityConfig?.bbox || { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 };
  const isInternational = cityCountry !== 'US';
  const shifts = opts.shifts || {
    breakfast: Math.round(num_couriers * 0.1),
    lunch: Math.round(num_couriers * 0.3),
    afternoon: Math.round(num_couriers * 0.16),
    dinner: Math.round(num_couriers * 0.34),
    late_night: Math.round(num_couriers * 0.1),
  };

  const steps = DATA_BUILD_STEPS.map((s) => ({ step: s.id, status: 'idle' as string }));
  updateCityState(city, { status: 'building_data', dataSteps: steps });

  function updateStep(step: string, update: any) {
    updateCityDataStep(city, step, update);
  }

  try {
    // Step 1: Restaurants
    updateStep('restaurants', { status: 'running', message: 'Loading restaurants from Overture Maps...', started_at: Date.now() });
    try {
      await snowSql(`DELETE FROM ${DB}.DATA.RESTAURANTS WHERE CITY IN (${cityList})`);
      await snowSql(`INSERT INTO ${DB}.DATA.RESTAURANTS
SELECT ID AS RESTAURANT_ID, GEOMETRY AS LOCATION, NAMES:primary::STRING AS NAME,
  CATEGORIES:primary::STRING AS CUISINE_TYPE, ADDRESSES[0]:freeform::STRING AS ADDRESS,
  '${city.replace(/'/g, "''")}' AS CITY, ADDRESSES[0]:region::STRING AS STATE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_Y(GEOMETRY) BETWEEN ${cityBbox.minLat} AND ${cityBbox.maxLat}
  AND ST_X(GEOMETRY) BETWEEN ${cityBbox.minLon} AND ${cityBbox.maxLon}
  AND NAMES:primary IS NOT NULL
  AND (CATEGORIES:primary::STRING ILIKE '%restaurant%' OR CATEGORIES:primary::STRING ILIKE '%food%'
    OR CATEGORIES:primary::STRING ILIKE '%pizza%' OR CATEGORIES:primary::STRING ILIKE '%burger%'
    OR CATEGORIES:primary::STRING ILIKE '%sushi%' OR CATEGORIES:primary::STRING ILIKE '%coffee%'
    OR CATEGORIES:primary::STRING ILIKE '%bakery%' OR CATEGORIES:primary::STRING ILIKE '%bar%'
    OR CATEGORIES:primary::STRING ILIKE '%cafe%' OR CATEGORIES:primary::STRING ILIKE '%deli%'
    OR CATEGORIES:primary::STRING ILIKE '%taco%' OR CATEGORIES:primary::STRING ILIKE '%thai%'
    OR CATEGORIES:primary::STRING ILIKE '%chinese%' OR CATEGORIES:primary::STRING ILIKE '%indian%'
    OR CATEGORIES:primary::STRING ILIKE '%mexican%' OR CATEGORIES:primary::STRING ILIKE '%italian%')`);
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.RESTAURANTS WHERE CITY IN (${cityList})`);
      updateStep('restaurants', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (getCityProvisionState(city).dataSteps?.find(s => s.step === 'restaurants')?.started_at || Date.now())) / 1000 });
    } catch (err: any) { updateStep('restaurants', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    // Step 2: Addresses
    updateStep('addresses', { status: 'running', message: 'Loading addresses from Overture Maps...', started_at: Date.now() });
    try {
      await snowSql(`DELETE FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE CITY IN (${cityList})`);
      if (cityCountry === 'GB') {
        await snowSql(`INSERT INTO ${DB}.DATA.CUSTOMER_ADDRESSES
SELECT ID AS ADDRESS_ID, GEOMETRY AS LOCATION,
  COALESCE(ADDRESSES[0]:freeform::STRING, NAMES:primary::STRING) AS FULL_ADDRESS,
  COALESCE(ADDRESSES[0]:freeform::STRING, NAMES:primary::STRING) AS STREET,
  ADDRESSES[0]:postcode::STRING AS POSTCODE,
  ADDRESSES[0]:region::STRING AS STATE,
  '${city.replace(/'/g, "''")}' AS CITY
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_Y(GEOMETRY) BETWEEN ${cityBbox.minLat} AND ${cityBbox.maxLat}
  AND ST_X(GEOMETRY) BETWEEN ${cityBbox.minLon} AND ${cityBbox.maxLon}
  AND NAMES:primary IS NOT NULL
LIMIT 50000`);
      } else {
        await snowSql(`INSERT INTO ${DB}.DATA.CUSTOMER_ADDRESSES
SELECT ID AS ADDRESS_ID, GEOMETRY AS LOCATION,
  COALESCE(ADDRESS_LEVELS[0]:value::STRING || ' ' || STREET, STREET) AS FULL_ADDRESS,
  STREET, POSTCODE,
  ADDRESS_LEVELS[0]:value::STRING AS STATE,
  '${city.replace(/'/g, "''")}' AS CITY
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE ST_Y(GEOMETRY) BETWEEN ${cityBbox.minLat} AND ${cityBbox.maxLat}
  AND ST_X(GEOMETRY) BETWEEN ${cityBbox.minLon} AND ${cityBbox.maxLon}
  AND STREET IS NOT NULL
LIMIT 50000`);
      }
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE CITY IN (${cityList})`);
      updateStep('addresses', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (getCityProvisionState(city).dataSteps?.find(s => s.step === 'addresses')?.started_at || Date.now())) / 1000 });
    } catch (err: any) { updateStep('addresses', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    // Step 3: Couriers
    updateStep('couriers', { status: 'running', message: 'Creating courier fleet...', started_at: Date.now() });
    try {
      const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
      await snowSql(`DELETE FROM ${DB}.DATA.COURIERS WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      await snowSql(`INSERT INTO ${DB}.DATA.COURIERS
WITH shift_patterns AS (
  SELECT * FROM (VALUES
    ('Breakfast', 5, 11, ${shifts.breakfast}), ('Lunch', 10, 15, ${shifts.lunch}),
    ('Afternoon', 14, 20, ${shifts.afternoon}), ('Dinner', 17, 23, ${shifts.dinner}),
    ('Late Night', 21, 3, ${shifts.late_night})
  ) AS t(shift_name, shift_start, shift_end, courier_count)
),
courier_assignments AS (
  SELECT ROW_NUMBER() OVER (ORDER BY sp.shift_name, seq.seq) AS courier_num,
    sp.shift_name AS shift_type, sp.shift_start AS shift_start_hour, sp.shift_end AS shift_end_hour,
    CASE WHEN sp.shift_start > sp.shift_end THEN 'True' ELSE 'False' END AS shift_crosses_midnight
  FROM shift_patterns sp
  CROSS JOIN (SELECT SEQ4() + 1 AS seq FROM TABLE(GENERATOR(ROWCOUNT => 1000))) seq
  WHERE seq.seq <= sp.courier_count
),
home_locations AS (
  SELECT ADDRESS_ID, ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
  FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE CITY IN (${cityList}) LIMIT 200
)
SELECT '${cityPrefix}-' || LPAD(ca.courier_num::STRING, 4, '0') AS COURIER_ID,
  hl.ADDRESS_ID AS HOME_ADDRESS_ID, ca.shift_type AS SHIFT_TYPE, ca.shift_start_hour AS SHIFT_START_HOUR,
  ca.shift_end_hour AS SHIFT_END_HOUR, ca.shift_crosses_midnight AS SHIFT_CROSSES_MIDNIGHT,
  CASE WHEN UNIFORM(1,100,RANDOM())<=60 THEN 'bicycle' WHEN UNIFORM(1,100,RANDOM())<=85 THEN 'car' ELSE 'scooter' END AS VEHICLE_TYPE
FROM courier_assignments ca LEFT JOIN home_locations hl ON ca.courier_num = hl.rn`);
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.COURIERS WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      updateStep('couriers', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (getCityProvisionState(city).dataSteps?.find(s => s.step === 'couriers')?.started_at || Date.now())) / 1000 });
    } catch (err: any) { updateStep('couriers', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    // Step 4: Orders (skipped — orders are generated inline in the combined routes+geometries step)
    updateStep('orders', { status: 'complete', message: 'Orders generated in routes step', rows: 0 });

    // Wait for ORS provisioning if it's still running
    if (opts.orsPromise) {
      updateStep('routes', { status: 'waiting_for_ors', message: 'Waiting for ORS routing service to be ready...', started_at: Date.now() });
      await opts.orsPromise;
    }

    // Step 5: ORS Routes + Step 6: Parse & Geometries (combined — generates routes and inserts geometries in one query)
    updateStep('routes', { status: 'running', message: 'Generating routes via OpenRouteService...', started_at: Date.now() });
    try {
      const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
      const sd = start_date;

      await snowSql(`DELETE FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE CITY IN (${cityList})`);
      await snowSql(`INSERT INTO ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES
WITH restaurants_numbered AS (
  SELECT RESTAURANT_ID, LOCATION, NAME, CUISINE_TYPE, ADDRESS, CITY,
    ROW_NUMBER() OVER (ORDER BY HASH(RESTAURANT_ID)) AS RN
  FROM ${DB}.DATA.RESTAURANTS WHERE NAME IS NOT NULL AND LENGTH(NAME) > 2 AND CITY IN (${cityList})
),
addresses_numbered AS (
  SELECT ADDRESS_ID, LOCATION, FULL_ADDRESS, CITY,
    ROW_NUMBER() OVER (ORDER BY HASH(ADDRESS_ID)) AS RN
  FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE FULL_ADDRESS IS NOT NULL AND LENGTH(FULL_ADDRESS) > 3 AND CITY IN (${cityList})
),
courier_order_counts AS (
  SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR,
    c.SHIFT_CROSSES_MIDNIGHT, c.VEHICLE_TYPE,
    CASE c.SHIFT_TYPE WHEN 'Lunch' THEN UNIFORM(12,18,RANDOM()) WHEN 'Dinner' THEN UNIFORM(14,20,RANDOM())
      WHEN 'Breakfast' THEN UNIFORM(6,10,RANDOM()) WHEN 'Afternoon' THEN UNIFORM(8,12,RANDOM())
      WHEN 'Late Night' THEN UNIFORM(4,8,RANDOM()) END AS NUM_ORDERS
  FROM ${DB}.DATA.COURIERS c WHERE c.COURIER_ID LIKE '${cityPrefix}-%'
),
order_sequence AS (
  SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR, c.SHIFT_CROSSES_MIDNIGHT,
    c.VEHICLE_TYPE, c.NUM_ORDERS, ROW_NUMBER() OVER (PARTITION BY c.COURIER_ID ORDER BY RANDOM()) AS ORDER_NUMBER
  FROM courier_order_counts c CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 25)) g
  QUALIFY ORDER_NUMBER <= c.NUM_ORDERS
),
orders_with_hours AS (
  SELECT os.*, CASE WHEN os.SHIFT_CROSSES_MIDNIGHT = 'True'
    THEN MOD(os.SHIFT_START_HOUR + FLOOR((os.ORDER_NUMBER-1)*6.0/os.NUM_ORDERS) + UNIFORM(0,1,RANDOM()), 24)
    ELSE os.SHIFT_START_HOUR + FLOOR((os.ORDER_NUMBER-1)*(os.SHIFT_END_HOUR-os.SHIFT_START_HOUR)/os.NUM_ORDERS) + UNIFORM(0,1,RANDOM())
    END AS ORDER_HOUR FROM order_sequence os
),
rest_count AS (SELECT COUNT(*) AS cnt FROM restaurants_numbered),
addr_count AS (SELECT COUNT(*) AS cnt FROM addresses_numbered),
orders_indexed AS (
  SELECT MD5(o.COURIER_ID||'-'||o.ORDER_NUMBER||'-'||RANDOM()) AS ORDER_ID, o.COURIER_ID,
    o.ORDER_HOUR::INT AS ORDER_HOUR, o.ORDER_NUMBER::INT AS ORDER_NUMBER, o.SHIFT_TYPE, o.VEHICLE_TYPE,
    MOD(ABS(HASH(o.COURIER_ID||o.ORDER_NUMBER||'R')), rc.cnt)+1 AS RESTAURANT_IDX,
    MOD(ABS(HASH(o.COURIER_ID||o.ORDER_NUMBER||'C')), ac.cnt)+1 AS CUSTOMER_IDX,
    UNIFORM(5,25,RANDOM()) AS PREP_TIME_MINS,
    MOD(ABS(HASH(o.COURIER_ID||o.ORDER_NUMBER||'D')), ${num_days}) AS DAY_OFFSET,
    CASE
      WHEN MOD(ABS(HASH(o.COURIER_ID||o.ORDER_NUMBER||'D')), ${num_days}) = 0
        THEN CASE WHEN UNIFORM(1,100,RANDOM())<=82 THEN 'delivered' WHEN UNIFORM(1,100,RANDOM())<=92 THEN 'in_transit' ELSE 'picked_up' END
      ELSE 'delivered'
    END AS ORDER_STATUS
  FROM orders_with_hours o CROSS JOIN rest_count rc CROSS JOIN addr_count ac
),
orders_with_locations AS (
  SELECT o.ORDER_ID, o.COURIER_ID, o.ORDER_HOUR, o.ORDER_NUMBER, o.SHIFT_TYPE, o.VEHICLE_TYPE,
    r.RESTAURANT_ID, r.NAME AS RESTAURANT_NAME, r.CUISINE_TYPE, r.LOCATION AS RESTAURANT_LOCATION,
    r.ADDRESS AS RESTAURANT_ADDRESS, a.ADDRESS_ID AS CUSTOMER_ADDRESS_ID, a.FULL_ADDRESS AS CUSTOMER_ADDRESS,
    a.LOCATION AS CUSTOMER_LOCATION, o.PREP_TIME_MINS, o.ORDER_STATUS, o.DAY_OFFSET, r.CITY
  FROM orders_indexed o
  JOIN restaurants_numbered r ON o.RESTAURANT_IDX = r.RN
  JOIN addresses_numbered a ON o.CUSTOMER_IDX = a.RN
),
routed AS (
  SELECT COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
    RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS, DAY_OFFSET,
    ${routingFn}(
      CASE VEHICLE_TYPE WHEN 'bicycle' THEN 'cycling-regular' ELSE 'driving-car' END,
      ARRAY_CONSTRUCT(ST_X(RESTAURANT_LOCATION), ST_Y(RESTAURANT_LOCATION)),
      ARRAY_CONSTRUCT(ST_X(CUSTOMER_LOCATION), ST_Y(CUSTOMER_LOCATION))
    ) AS ROUTE_RESPONSE, CITY
  FROM orders_with_locations
),
parsed AS (
  SELECT COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
    RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
    CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS, DAY_OFFSET,
    TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry) AS ROUTE_GEOMETRY,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:distance::FLOAT AS ROUTE_DISTANCE_METERS,
    PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:duration::FLOAT AS ROUTE_DURATION_SECS, CITY
  FROM routed WHERE ROUTE_RESPONSE IS NOT NULL
),
order_timing AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY COURIER_ID ORDER BY ORDER_HOUR, ORDER_NUMBER) AS COURIER_ORDER_SEQ
  FROM parsed WHERE ROUTE_GEOMETRY IS NOT NULL
),
cumulative_timing AS (
  SELECT t.*,
    SUM(COALESCE(ROUTE_DURATION_SECS,0)+(PREP_TIME_MINS*60)+120) OVER (
      PARTITION BY COURIER_ID ORDER BY COURIER_ORDER_SEQ ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS TIME_OFFSET_SECS
  FROM order_timing t
)
SELECT COURIER_ID, ORDER_ID,
  DATEADD('second', COALESCE(TIME_OFFSET_SECS,0), DATEADD('hour', ORDER_HOUR, DATEADD('day', -DAY_OFFSET, '${sd}'::TIMESTAMP_NTZ))) AS ORDER_TIME,
  DATEADD('second', COALESCE(TIME_OFFSET_SECS,0)+(PREP_TIME_MINS*60), DATEADD('hour', ORDER_HOUR, DATEADD('day', -DAY_OFFSET, '${sd}'::TIMESTAMP_NTZ))) AS PICKUP_TIME,
  DATEADD('second', COALESCE(TIME_OFFSET_SECS,0)+(PREP_TIME_MINS*60)+ROUTE_DURATION_SECS, DATEADD('hour', ORDER_HOUR, DATEADD('day', -DAY_OFFSET, '${sd}'::TIMESTAMP_NTZ))) AS DELIVERY_TIME,
  RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
  CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
  ROUTE_DURATION_SECS, ROUTE_DISTANCE_METERS, ROUTE_GEOMETRY AS GEOMETRY, SHIFT_TYPE, VEHICLE_TYPE,
  CITY
FROM cumulative_timing`);

      updateStep('routes', { status: 'complete', elapsed_seconds: (Date.now() - (getCityProvisionState(city).dataSteps?.find(s => s.step === 'routes')?.started_at || Date.now())) / 1000 });
    } catch (err: any) { updateStep('routes', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    updateStep('geometries', { status: 'running', message: 'Counting results...', started_at: Date.now() });
    try {
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE CITY IN (${cityList})`);
      updateStep('orders', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
      updateStep('geometries', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (getCityProvisionState(city).dataSteps?.find(s => s.step === 'geometries')?.started_at || Date.now())) / 1000 });
    } catch (err: any) { updateStep('geometries', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    // Step 7: Courier Locations
    updateStep('locations', { status: 'running', message: 'Interpolating courier positions...', started_at: Date.now() });
    try {
      await snowSql(`DELETE FROM ${DB}.DATA.COURIER_LOCATIONS WHERE CITY IN (${cityList})`);
      await snowSql(`INSERT INTO ${DB}.DATA.COURIER_LOCATIONS
WITH route_info AS (
  SELECT COURIER_ID, ORDER_ID, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, GEOMETRY AS ROUTE,
    ROUTE_DURATION_SECS, ROUTE_DISTANCE_METERS, VEHICLE_TYPE, SHIFT_TYPE,
    ST_NPOINTS(GEOMETRY)::NUMBER(10,0) AS NUM_POINTS, PREP_TIME_MINS, CITY
  FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE GEOMETRY IS NOT NULL AND CITY IN (${cityList})
),
point_seq AS (SELECT SEQ4()::NUMBER(10,0) AS POINT_INDEX FROM TABLE(GENERATOR(ROWCOUNT => 15))),
expanded AS (
  SELECT r.COURIER_ID, r.ORDER_ID, r.ORDER_TIME, r.PICKUP_TIME, r.DELIVERY_TIME,
    r.RESTAURANT_LOCATION, r.CUSTOMER_LOCATION, r.ROUTE, r.NUM_POINTS,
    r.ROUTE_DURATION_SECS, r.VEHICLE_TYPE, r.CITY, p.POINT_INDEX,
    UNIFORM(1,100,RANDOM()) AS SPEED_ROLL,
    CASE WHEN p.POINT_INDEX=0 THEN 'at_restaurant' WHEN p.POINT_INDEX=1 THEN 'picking_up'
      WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN 'en_route' WHEN p.POINT_INDEX=13 THEN 'arriving'
      WHEN p.POINT_INDEX=14 THEN 'delivered' END AS COURIER_STATE,
    CASE WHEN p.POINT_INDEX=0 THEN r.ORDER_TIME WHEN p.POINT_INDEX=1 THEN r.PICKUP_TIME
      WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN DATEADD('second', FLOOR(r.ROUTE_DURATION_SECS*(p.POINT_INDEX-2)/10.0)::INT, r.PICKUP_TIME)
      WHEN p.POINT_INDEX=13 THEN DATEADD('second', -30, r.DELIVERY_TIME)
      ELSE r.DELIVERY_TIME END AS CURR_TIME,
    CASE WHEN p.POINT_INDEX IN (0,1) THEN 1::NUMBER(10,0) WHEN p.POINT_INDEX IN (13,14) THEN r.NUM_POINTS
      ELSE GREATEST(1::NUMBER(10,0), LEAST(r.NUM_POINTS, CEIL((p.POINT_INDEX-2)*r.NUM_POINTS/10.0)::NUMBER(10,0)))
      END AS GEOM_IDX
  FROM route_info r CROSS JOIN point_seq p
)
SELECT ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME AS DROPOFF_TIME,
  RESTAURANT_LOCATION, CUSTOMER_LOCATION, ROUTE, ST_POINTN(ROUTE, GEOM_IDX::INT) AS POINT_GEOM,
  CURR_TIME, POINT_INDEX, COURIER_STATE,
  CASE WHEN COURIER_STATE='at_restaurant' THEN 0 WHEN COURIER_STATE='picking_up' THEN 0
    WHEN COURIER_STATE='arriving' THEN UNIFORM(2,8,RANDOM()) WHEN COURIER_STATE='delivered' THEN 0
    WHEN COURIER_STATE='en_route' THEN
      CASE VEHICLE_TYPE WHEN 'bicycle' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(8,15,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(15,22,RANDOM()) ELSE UNIFORM(20,30,RANDOM()) END
      WHEN 'scooter' THEN
        CASE WHEN SPEED_ROLL<=15 THEN UNIFORM(10,20,RANDOM()) WHEN SPEED_ROLL<=50 THEN UNIFORM(20,35,RANDOM()) ELSE UNIFORM(30,45,RANDOM()) END
      ELSE CASE WHEN HOUR(CURR_TIME) BETWEEN 11 AND 13 THEN
          CASE WHEN SPEED_ROLL<=25 THEN UNIFORM(5,15,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(15,30,RANDOM()) ELSE UNIFORM(25,45,RANDOM()) END
        WHEN HOUR(CURR_TIME) BETWEEN 18 AND 20 THEN
          CASE WHEN SPEED_ROLL<=30 THEN UNIFORM(5,15,RANDOM()) WHEN SPEED_ROLL<=65 THEN UNIFORM(15,30,RANDOM()) ELSE UNIFORM(25,40,RANDOM()) END
        ELSE CASE WHEN SPEED_ROLL<=15 THEN UNIFORM(10,20,RANDOM()) WHEN SPEED_ROLL<=45 THEN UNIFORM(20,35,RANDOM()) ELSE UNIFORM(30,55,RANDOM()) END
        END END END AS KMH,
  CITY
FROM expanded`);

      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.COURIER_LOCATIONS WHERE CITY IN (${cityList})`);
      updateStep('locations', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (getCityProvisionState(city).dataSteps?.find(s => s.step === 'locations')?.started_at || Date.now())) / 1000 });
    } catch (err: any) { updateStep('locations', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

  } catch (err: any) {
    console.error(`City build error for ${city}:`, err.message);
    throw err;
  }
}

app.get('/api/city/:city/progress', (req, res) => {
  const city = decodeURIComponent(req.params.city);
  const state = getCityProvisionState(city);
  res.json(state);
});

const CITY_DATA_TABLES = [
  'COURIER_LOCATIONS',
  'DELIVERY_ROUTE_GEOMETRIES',
  'COURIERS',
];

app.delete('/api/city/:city/data', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const cityList = `'${city.replace(/'/g, "''")}'`;
    const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
    const DB = SF_DATABASE;
    const results: Record<string, { rows_before: number; status: string }> = {};

    for (const table of CITY_DATA_TABLES) {
      try {
        const fqn = `${DB}.DATA.${table}`;
        const cityCol = table === 'COURIERS' ? `COURIER_ID LIKE '${cityPrefix}-%'` : `CITY IN (${cityList})`;
        const countRows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${fqn} WHERE ${cityCol}`);
        const rowsBefore = Number(countRows[0]?.CNT || 0);
        await snowSql(`DELETE FROM ${fqn} WHERE ${cityCol}`);
        results[table] = { rows_before: rowsBefore, status: 'removed' };
      } catch (err: any) {
        results[table] = { rows_before: 0, status: 'error' };
      }
    }

    try {
      await snowSql(`DELETE FROM ${DB}.DATA.RESTAURANTS WHERE CITY IN (${cityList})`);
      results['RESTAURANTS'] = { rows_before: 0, status: 'removed' };
    } catch { results['RESTAURANTS'] = { rows_before: 0, status: 'error' }; }
    try {
      await snowSql(`DELETE FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE CITY IN (${cityList})`);
      results['CUSTOMER_ADDRESSES'] = { rows_before: 0, status: 'removed' };
    } catch { results['CUSTOMER_ADDRESSES'] = { rows_before: 0, status: 'error' }; }

    if (cityProvisionStates[city]) {
      cityProvisionStates[city] = { status: 'idle', orsRegion: getOrsRegion(city) };
    }

    res.json({ status: 'removed', city, tables: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/city/:city/restore', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const { offset_minutes = 5 } = req.body || {};
    const cityList = `'${city.replace(/'/g, "''")}'`;
    const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
    const DB = SF_DATABASE;
    const results: Record<string, { rows_restored: number; status: string }> = {};
    const offsetSecs = offset_minutes * 60;

    const tableCityFilters: Record<string, string> = {
      COURIER_LOCATIONS: `CITY IN (${cityList})`,
      DELIVERY_ROUTE_GEOMETRIES: `CITY IN (${cityList})`,
      COURIERS: `COURIER_ID LIKE '${cityPrefix}-%'`,
      RESTAURANTS: `CITY IN (${cityList})`,
      CUSTOMER_ADDRESSES: `CITY IN (${cityList})`,
    };

    for (const [table, filter] of Object.entries(tableCityFilters)) {
      const fqn = `${DB}.DATA.${table}`;
      try {
        await snowSql(`INSERT INTO ${fqn} SELECT * FROM ${fqn} AT(OFFSET => -${offsetSecs}) WHERE ${filter} AND NOT EXISTS (SELECT 1 FROM ${fqn} curr WHERE curr.${table === 'COURIERS' ? 'COURIER_ID' : table === 'RESTAURANTS' ? 'RESTAURANT_ID' : table === 'CUSTOMER_ADDRESSES' ? 'ADDRESS_ID' : 'ORDER_ID'} = ${fqn}.${table === 'COURIERS' ? 'COURIER_ID' : table === 'RESTAURANTS' ? 'RESTAURANT_ID' : table === 'CUSTOMER_ADDRESSES' ? 'ADDRESS_ID' : 'ORDER_ID'})`);
        const countRows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${fqn} WHERE ${filter}`);
        results[table] = { rows_restored: Number(countRows[0]?.CNT || 0), status: 'restored' };
      } catch (err: any) {
        results[table] = { rows_restored: 0, status: 'error' };
      }
    }

    res.json({ status: 'restored', city, tables: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// DATA BUILDER: Generate food delivery data pipeline
// =============================================================================

const dataBuildState: {
  running: boolean;
  steps: { step: string; status: string; message?: string; rows?: number; elapsed_seconds?: number; started_at?: number }[];
  config: any;
} = { running: false, steps: [], config: null };

app.get('/api/data/status', async (_req, res) => {
  try {
    const tables = ['RESTAURANTS', 'CUSTOMER_ADDRESSES', 'COURIERS', 'DELIVERY_ORDERS',
      'ORDERS_WITH_LOCATIONS', 'DELIVERY_ROUTES', 'DELIVERY_ROUTES_PARSED',
      'DELIVERY_ROUTE_GEOMETRIES', 'COURIER_LOCATIONS'];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      try {
        const rows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.DATA.${t}`);
        counts[t.toLowerCase()] = Number(rows[0]?.CNT || 0);
      } catch { counts[t.toLowerCase()] = 0; }
    }
    res.json(counts);
  } catch (err: any) { res.json({}); }
});

app.get('/api/data/progress', (_req, res) => {
  res.json({ running: dataBuildState.running, steps: dataBuildState.steps });
});

app.delete('/api/data/clear', async (_req, res) => {
  try {
    const tables = ['COURIER_LOCATIONS', 'DELIVERY_ROUTE_GEOMETRIES', 'DELIVERY_ROUTES_PARSED',
      'DELIVERY_ROUTES', 'ORDERS_WITH_LOCATIONS', 'DELIVERY_ORDERS', 'COURIERS',
      'ADDRESSES_NUMBERED', 'RESTAURANTS_NUMBERED', 'CUSTOMER_ADDRESSES', 'RESTAURANTS'];
    for (const t of tables) {
      try { await snowSql(`TRUNCATE TABLE ${SF_DATABASE}.DATA.${t}`); } catch {}
    }
    res.json({ status: 'cleared' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/data/build', async (req, res) => {
  if (dataBuildState.running) return res.status(409).json({ error: 'Build already in progress' });

  const todayStr = new Date().toISOString().slice(0, 10);
  const { cities = ['San Francisco'], num_couriers = 50, num_days = 1, start_date = todayStr, shifts } = req.body;
  const DB = SF_DATABASE;
  const cityList = cities.map((c: string) => `'${c.replace(/'/g, "''")}'`).join(',');

  dataBuildState.running = true;
  dataBuildState.config = req.body;
  dataBuildState.steps = [
    { step: 'restaurants', status: 'idle' },
    { step: 'addresses', status: 'idle' },
    { step: 'couriers', status: 'idle' },
    { step: 'orders', status: 'idle' },
    { step: 'routes', status: 'idle' },
    { step: 'geometries', status: 'idle' },
    { step: 'locations', status: 'idle' },
  ];

  res.json({ status: 'started' });

  function updateStep(step: string, update: Partial<typeof dataBuildState.steps[0]>) {
    const s = dataBuildState.steps.find((x) => x.step === step);
    if (s) Object.assign(s, update);
  }

  (async () => {
    try {
      // Step 1: Restaurants from Overture Maps
      updateStep('restaurants', { status: 'running', message: 'Loading restaurants from Overture Maps...', started_at: Date.now() });
      try {
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.RESTAURANTS
SELECT ID AS RESTAURANT_ID, GEOMETRY AS LOCATION, NAMES:primary::STRING AS NAME,
  CATEGORIES:primary::STRING AS CUISINE_TYPE, ADDRESSES[0]:freeform::STRING AS ADDRESS,
  ADDRESSES[0]:locality::STRING AS CITY, ADDRESSES[0]:region::STRING AS STATE
FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ADDRESSES[0]:country::STRING = 'US' AND ADDRESSES[0]:region::STRING = 'CA'
  AND NAMES:primary IS NOT NULL
  AND (CATEGORIES:primary::STRING ILIKE '%restaurant%' OR CATEGORIES:primary::STRING ILIKE '%food%'
    OR CATEGORIES:primary::STRING ILIKE '%pizza%' OR CATEGORIES:primary::STRING ILIKE '%burger%'
    OR CATEGORIES:primary::STRING ILIKE '%sushi%' OR CATEGORIES:primary::STRING ILIKE '%taco%'
    OR CATEGORIES:primary::STRING ILIKE '%coffee%' OR CATEGORIES:primary::STRING ILIKE '%bakery%'
    OR CATEGORIES:primary::STRING ILIKE '%cafe%' OR CATEGORIES:primary::STRING ILIKE '%deli%'
    OR CATEGORIES:primary::STRING ILIKE '%asian%' OR CATEGORIES:primary::STRING ILIKE '%chinese%'
    OR CATEGORIES:primary::STRING ILIKE '%thai%' OR CATEGORIES:primary::STRING ILIKE '%indian%'
    OR CATEGORIES:primary::STRING ILIKE '%mexican%' OR CATEGORIES:primary::STRING ILIKE '%italian%'
    OR CATEGORIES:primary::STRING ILIKE '%sandwich%' OR CATEGORIES:primary::STRING ILIKE '%fast_food%')`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.RESTAURANTS`);
        updateStep('restaurants', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[0].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('restaurants', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 2: Customer Addresses from Overture Maps
      updateStep('addresses', { status: 'running', message: 'Loading addresses from Overture Maps...', started_at: Date.now() });
      try {
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.CUSTOMER_ADDRESSES
SELECT ID AS ADDRESS_ID, GEOMETRY AS LOCATION,
  COALESCE(ADDRESS_LEVELS[0]:value::STRING || ' ' || STREET, STREET) AS FULL_ADDRESS,
  STREET, POSTCODE, ADDRESS_LEVELS[0]:value::STRING AS STATE, ADDRESS_LEVELS[1]:value::STRING AS CITY
FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE COUNTRY = 'US' AND ADDRESS_LEVELS[0]:value::STRING = 'CA' AND STREET IS NOT NULL`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.CUSTOMER_ADDRESSES`);
        updateStep('addresses', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[1].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('addresses', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 3: Create Couriers
      const sh = shifts || { breakfast: 5, lunch: 15, afternoon: 8, dinner: 17, late_night: 5 };
      updateStep('couriers', { status: 'running', message: `Creating ${num_couriers} couriers...`, started_at: Date.now() });
      try {
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.COURIERS
WITH shift_patterns AS (
  SELECT 1 AS shift_id, 'Breakfast' AS shift_name, 6 AS shift_start, 11 AS shift_end, ${sh.breakfast} AS courier_count UNION ALL
  SELECT 2, 'Lunch', 10, 15, ${sh.lunch} UNION ALL
  SELECT 3, 'Afternoon', 14, 18, ${sh.afternoon} UNION ALL
  SELECT 4, 'Dinner', 17, 22, ${sh.dinner} UNION ALL
  SELECT 5, 'Late Night', 20, 2, ${sh.late_night}
),
courier_assignments AS (
  SELECT ROW_NUMBER() OVER (ORDER BY sp.shift_id, seq.seq) AS courier_num,
    sp.shift_name AS shift_type, sp.shift_start AS shift_start_hour, sp.shift_end AS shift_end_hour,
    CASE WHEN sp.shift_start > sp.shift_end THEN 'True' ELSE 'False' END AS shift_crosses_midnight
  FROM shift_patterns sp
  CROSS JOIN (SELECT SEQ4() + 1 AS seq FROM TABLE(GENERATOR(ROWCOUNT => 1000))) seq
  WHERE seq.seq <= sp.courier_count
),
home_locations AS (
  SELECT ADDRESS_ID, ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rn
  FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE CITY IN (${cityList}) LIMIT 200
)
SELECT 'C-' || LPAD(ca.courier_num::STRING, 4, '0') AS COURIER_ID,
  hl.ADDRESS_ID AS HOME_ADDRESS_ID, ca.shift_type AS SHIFT_TYPE, ca.shift_start_hour AS SHIFT_START_HOUR,
  ca.shift_end_hour AS SHIFT_END_HOUR, ca.shift_crosses_midnight AS SHIFT_CROSSES_MIDNIGHT,
  CASE WHEN UNIFORM(1,100,RANDOM())<=60 THEN 'bicycle' WHEN UNIFORM(1,100,RANDOM())<=85 THEN 'car' ELSE 'scooter' END AS VEHICLE_TYPE
FROM courier_assignments ca LEFT JOIN home_locations hl ON ca.courier_num = hl.rn`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.COURIERS`);
        updateStep('couriers', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[2].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('couriers', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 4: Numbered tables + Delivery Orders
      updateStep('orders', { status: 'running', message: 'Generating delivery orders...', started_at: Date.now() });
      try {
        await snowSql(`ALTER TABLE IF EXISTS ${DB}.DATA.RESTAURANTS_NUMBERED ADD COLUMN IF NOT EXISTS CITY VARCHAR`);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.RESTAURANTS_NUMBERED
SELECT RESTAURANT_ID, LOCATION, NAME, CUISINE_TYPE, ADDRESS,
  ROW_NUMBER() OVER (ORDER BY HASH(RESTAURANT_ID)) AS RN, CITY
FROM ${DB}.DATA.RESTAURANTS WHERE NAME IS NOT NULL AND LENGTH(NAME) > 2 AND CITY IN (${cityList})`);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.ADDRESSES_NUMBERED
SELECT ADDRESS_ID, LOCATION, FULL_ADDRESS,
  ROW_NUMBER() OVER (ORDER BY HASH(ADDRESS_ID)) AS RN
FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE FULL_ADDRESS IS NOT NULL AND LENGTH(FULL_ADDRESS) > 3 AND CITY IN (${cityList})`);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.DELIVERY_ORDERS
WITH courier_order_counts AS (
  SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR,
    c.SHIFT_CROSSES_MIDNIGHT, c.VEHICLE_TYPE,
    CASE c.SHIFT_TYPE WHEN 'Lunch' THEN UNIFORM(12,18,RANDOM()) WHEN 'Dinner' THEN UNIFORM(14,20,RANDOM())
      WHEN 'Breakfast' THEN UNIFORM(6,10,RANDOM()) WHEN 'Afternoon' THEN UNIFORM(8,12,RANDOM())
      WHEN 'Late Night' THEN UNIFORM(4,8,RANDOM()) END AS NUM_ORDERS
  FROM ${DB}.DATA.COURIERS c
),
order_sequence AS (
  SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR, c.SHIFT_CROSSES_MIDNIGHT,
    c.VEHICLE_TYPE, c.NUM_ORDERS, ROW_NUMBER() OVER (PARTITION BY c.COURIER_ID ORDER BY RANDOM()) AS ORDER_NUMBER
  FROM courier_order_counts c CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 25)) g
  QUALIFY ORDER_NUMBER <= c.NUM_ORDERS
),
orders_with_hours AS (
  SELECT os.*, CASE WHEN os.SHIFT_CROSSES_MIDNIGHT = 'True'
    THEN MOD(os.SHIFT_START_HOUR + FLOOR((os.ORDER_NUMBER-1)*6.0/os.NUM_ORDERS) + UNIFORM(0,1,RANDOM()), 24)
    ELSE os.SHIFT_START_HOUR + FLOOR((os.ORDER_NUMBER-1)*(os.SHIFT_END_HOUR-os.SHIFT_START_HOUR)/os.NUM_ORDERS) + UNIFORM(0,1,RANDOM())
    END AS ORDER_HOUR FROM order_sequence os
),
rest_count AS (SELECT COUNT(*) AS cnt FROM ${DB}.DATA.RESTAURANTS_NUMBERED),
addr_count AS (SELECT COUNT(*) AS cnt FROM ${DB}.DATA.ADDRESSES_NUMBERED)
SELECT MD5(o.COURIER_ID||'-'||o.ORDER_NUMBER||'-'||RANDOM()) AS ORDER_ID, o.COURIER_ID,
  o.ORDER_HOUR::INT AS ORDER_HOUR, o.ORDER_NUMBER::INT AS ORDER_NUMBER, o.SHIFT_TYPE, o.VEHICLE_TYPE,
  MOD(ABS(HASH(o.COURIER_ID||o.ORDER_NUMBER||'R')), rc.cnt)+1 AS RESTAURANT_IDX,
  MOD(ABS(HASH(o.COURIER_ID||o.ORDER_NUMBER||'C')), ac.cnt)+1 AS CUSTOMER_IDX,
  UNIFORM(5,25,RANDOM()) AS PREP_TIME_MINS,
  CASE WHEN UNIFORM(1,100,RANDOM())<=92 THEN 'delivered' WHEN UNIFORM(1,100,RANDOM())<=97 THEN 'in_transit' ELSE 'picked_up' END AS ORDER_STATUS
FROM orders_with_hours o CROSS JOIN rest_count rc CROSS JOIN addr_count ac`);
        await snowSql(`ALTER TABLE IF EXISTS ${DB}.DATA.ORDERS_WITH_LOCATIONS ADD COLUMN IF NOT EXISTS CITY VARCHAR`);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.ORDERS_WITH_LOCATIONS
SELECT o.ORDER_ID, o.COURIER_ID, o.ORDER_HOUR, o.ORDER_NUMBER, o.SHIFT_TYPE, o.VEHICLE_TYPE,
  r.RESTAURANT_ID, r.NAME AS RESTAURANT_NAME, r.CUISINE_TYPE, r.LOCATION AS RESTAURANT_LOCATION,
  r.ADDRESS AS RESTAURANT_ADDRESS, a.ADDRESS_ID AS CUSTOMER_ADDRESS_ID, a.FULL_ADDRESS AS CUSTOMER_ADDRESS,
  a.LOCATION AS CUSTOMER_LOCATION, o.PREP_TIME_MINS, o.ORDER_STATUS, r.CITY
FROM ${DB}.DATA.DELIVERY_ORDERS o
JOIN ${DB}.DATA.RESTAURANTS_NUMBERED r ON o.RESTAURANT_IDX = r.RN
JOIN ${DB}.DATA.ADDRESSES_NUMBERED a ON o.CUSTOMER_IDX = a.RN`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ORDERS`);
        updateStep('orders', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[3].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('orders', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 5: ORS Routes
      updateStep('routes', { status: 'running', message: 'Generating ORS routes (this may take several minutes)...', started_at: Date.now() });
      try {
        const routingFn = `${DB}.ROUTING.DIRECTIONS`;
        await snowSql(`ALTER TABLE IF EXISTS ${DB}.DATA.DELIVERY_ROUTES ADD COLUMN IF NOT EXISTS CITY VARCHAR`);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.DELIVERY_ROUTES
SELECT COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
  RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
  CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
  ${routingFn}(
    CASE VEHICLE_TYPE WHEN 'bicycle' THEN 'cycling-regular' ELSE 'driving-car' END,
    ARRAY_CONSTRUCT(ST_X(RESTAURANT_LOCATION), ST_Y(RESTAURANT_LOCATION)),
    ARRAY_CONSTRUCT(ST_X(CUSTOMER_LOCATION), ST_Y(CUSTOMER_LOCATION))
  ) AS ROUTE_RESPONSE, CITY
FROM ${DB}.DATA.ORDERS_WITH_LOCATIONS`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ROUTES`);
        updateStep('routes', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[4].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('routes', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 6: Parse routes + geometries
      updateStep('geometries', { status: 'running', message: 'Parsing routes and computing geometries...', started_at: Date.now() });
      try {
        await snowSql(`ALTER TABLE IF EXISTS ${DB}.DATA.DELIVERY_ROUTES_PARSED ADD COLUMN IF NOT EXISTS CITY VARCHAR`);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.DELIVERY_ROUTES_PARSED
SELECT COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
  RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
  CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
  TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry) AS ROUTE_GEOMETRY,
  PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:distance::FLOAT AS ROUTE_DISTANCE_METERS,
  PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:duration::FLOAT AS ROUTE_DURATION_SECS, CITY
FROM ${DB}.DATA.DELIVERY_ROUTES WHERE ROUTE_RESPONSE IS NOT NULL`);

        const sd = start_date;
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES
WITH order_timing AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY COURIER_ID ORDER BY ORDER_HOUR, ORDER_NUMBER) AS COURIER_ORDER_SEQ
  FROM ${DB}.DATA.DELIVERY_ROUTES_PARSED WHERE ROUTE_GEOMETRY IS NOT NULL
),
cumulative_timing AS (
  SELECT t.*,
    SUM(COALESCE(ROUTE_DURATION_SECS,0)+(PREP_TIME_MINS*60)+120) OVER (
      PARTITION BY COURIER_ID ORDER BY COURIER_ORDER_SEQ ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS TIME_OFFSET_SECS
  FROM order_timing t
)
SELECT COURIER_ID, ORDER_ID,
  DATEADD('second', COALESCE(TIME_OFFSET_SECS,0), DATEADD('hour', ORDER_HOUR, '${sd}'::TIMESTAMP_NTZ)) AS ORDER_TIME,
  DATEADD('second', COALESCE(TIME_OFFSET_SECS,0)+(PREP_TIME_MINS*60), DATEADD('hour', ORDER_HOUR, '${sd}'::TIMESTAMP_NTZ)) AS PICKUP_TIME,
  DATEADD('second', COALESCE(TIME_OFFSET_SECS,0)+(PREP_TIME_MINS*60)+ROUTE_DURATION_SECS, DATEADD('hour', ORDER_HOUR, '${sd}'::TIMESTAMP_NTZ)) AS DELIVERY_TIME,
  RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
  CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
  ROUTE_DURATION_SECS, ROUTE_DISTANCE_METERS, ROUTE_GEOMETRY AS GEOMETRY, SHIFT_TYPE, VEHICLE_TYPE,
  CITY
FROM cumulative_timing`);

        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES`);
        updateStep('geometries', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[5].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('geometries', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 7: Courier Locations (interpolated)
      updateStep('locations', { status: 'running', message: 'Interpolating courier positions along routes...', started_at: Date.now() });
      try {
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.COURIER_LOCATIONS
WITH route_info AS (
  SELECT COURIER_ID, ORDER_ID, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, GEOMETRY AS ROUTE,
    ROUTE_DURATION_SECS, ROUTE_DISTANCE_METERS, VEHICLE_TYPE, SHIFT_TYPE,
    ST_NPOINTS(GEOMETRY)::NUMBER(10,0) AS NUM_POINTS, PREP_TIME_MINS, CITY
  FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE GEOMETRY IS NOT NULL
),
point_seq AS (SELECT SEQ4()::NUMBER(10,0) AS POINT_INDEX FROM TABLE(GENERATOR(ROWCOUNT => 15))),
expanded AS (
  SELECT r.COURIER_ID, r.ORDER_ID, r.ORDER_TIME, r.PICKUP_TIME, r.DELIVERY_TIME,
    r.RESTAURANT_LOCATION, r.CUSTOMER_LOCATION, r.ROUTE, r.NUM_POINTS,
    r.ROUTE_DURATION_SECS, r.VEHICLE_TYPE, r.CITY, p.POINT_INDEX,
    UNIFORM(1,100,RANDOM()) AS SPEED_ROLL,
    CASE WHEN p.POINT_INDEX=0 THEN 'at_restaurant' WHEN p.POINT_INDEX=1 THEN 'picking_up'
      WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN 'en_route' WHEN p.POINT_INDEX=13 THEN 'arriving'
      WHEN p.POINT_INDEX=14 THEN 'delivered' END AS COURIER_STATE,
    CASE WHEN p.POINT_INDEX=0 THEN r.ORDER_TIME WHEN p.POINT_INDEX=1 THEN r.PICKUP_TIME
      WHEN p.POINT_INDEX BETWEEN 2 AND 12 THEN DATEADD('second', FLOOR(r.ROUTE_DURATION_SECS*(p.POINT_INDEX-2)/10.0)::INT, r.PICKUP_TIME)
      WHEN p.POINT_INDEX=13 THEN DATEADD('second', -30, r.DELIVERY_TIME)
      ELSE r.DELIVERY_TIME END AS CURR_TIME,
    CASE WHEN p.POINT_INDEX IN (0,1) THEN 1::NUMBER(10,0) WHEN p.POINT_INDEX IN (13,14) THEN r.NUM_POINTS
      ELSE GREATEST(1::NUMBER(10,0), LEAST(r.NUM_POINTS, CEIL((p.POINT_INDEX-2)*r.NUM_POINTS/10.0)::NUMBER(10,0)))
      END AS GEOM_IDX
  FROM route_info r CROSS JOIN point_seq p
)
SELECT ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME AS DROPOFF_TIME,
  RESTAURANT_LOCATION, CUSTOMER_LOCATION, ROUTE, ST_POINTN(ROUTE, GEOM_IDX::INT) AS POINT_GEOM,
  CURR_TIME, POINT_INDEX, COURIER_STATE,
  CASE WHEN COURIER_STATE='at_restaurant' THEN 0 WHEN COURIER_STATE='picking_up' THEN 0
    WHEN COURIER_STATE='arriving' THEN UNIFORM(2,8,RANDOM()) WHEN COURIER_STATE='delivered' THEN 0
    WHEN COURIER_STATE='en_route' THEN
      CASE VEHICLE_TYPE WHEN 'bicycle' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(8,15,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(15,22,RANDOM()) ELSE UNIFORM(20,30,RANDOM()) END
      WHEN 'scooter' THEN
        CASE WHEN SPEED_ROLL<=15 THEN UNIFORM(10,20,RANDOM()) WHEN SPEED_ROLL<=50 THEN UNIFORM(20,35,RANDOM()) ELSE UNIFORM(30,45,RANDOM()) END
      ELSE CASE WHEN HOUR(CURR_TIME) BETWEEN 11 AND 13 THEN
          CASE WHEN SPEED_ROLL<=25 THEN UNIFORM(5,15,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(15,30,RANDOM()) ELSE UNIFORM(25,45,RANDOM()) END
        WHEN HOUR(CURR_TIME) BETWEEN 18 AND 20 THEN
          CASE WHEN SPEED_ROLL<=30 THEN UNIFORM(5,15,RANDOM()) WHEN SPEED_ROLL<=65 THEN UNIFORM(15,30,RANDOM()) ELSE UNIFORM(25,40,RANDOM()) END
        ELSE CASE WHEN SPEED_ROLL<=15 THEN UNIFORM(10,20,RANDOM()) WHEN SPEED_ROLL<=45 THEN UNIFORM(20,35,RANDOM()) ELSE UNIFORM(30,55,RANDOM()) END
        END END END AS KMH,
  CITY
FROM expanded`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.COURIER_LOCATIONS`);
        updateStep('locations', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[6].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('locations', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    } catch (err: any) {
      console.error('Data build pipeline error:', err.message);
    } finally {
      dataBuildState.running = false;
    }
  })();
});

if (IS_SPCS) {
  app.get('*', (_req, res) => {
    const indexPath = join(process.cwd(), 'dist', 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Not found');
    }
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Mode: ${IS_SPCS ? 'SPCS (service token)' : 'Local (snow CLI)'}`);
  if (IS_SPCS) {
    console.log(`SNOWFLAKE_HOST: ${SNOWFLAKE_HOST}`);
  } else {
    console.log(`Using connection: ${CONN}, warehouse: ${SF_WAREHOUSE}`);
  }
});
