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

const SF_DATABASE = process.env.SNOWFLAKE_DATABASE || 'FLEET_INTELLIGENCE_APP';
const SF_SCHEMA = process.env.SNOWFLAKE_SCHEMA || 'DATA';
const SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH';
const CONN = process.env.SNOWFLAKE_CONNECTION_NAME || 'FREE_TRIAL';
const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';

const AGENT_SCHEMA = process.env.AGENT_SCHEMA || 'CORE';
const AGENT_NAME = process.env.AGENT_NAME || 'FLEET_INTELLIGENCE_AGENT';

const CITY_ORS_MAP: Record<string, any> = {
  'London': { cityKey: 'LONDON', pbfUrl: 'https://download.bbbike.org/osm/bbbike/London/London.osm.pbf', pbfFilename: 'London.osm.pbf', orsRegion: 'London', country: 'GB', state: '', bbox: { minLat: 51.28, maxLat: 51.69, minLon: -0.51, maxLon: 0.33 }, geohash3: ['gcp', 'u10'] },
  'Paris': { cityKey: 'PARIS', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Paris/Paris.osm.pbf', pbfFilename: 'Paris.osm.pbf', orsRegion: 'Paris', country: 'FR', state: '', bbox: { minLat: 48.81, maxLat: 48.90, minLon: 2.22, maxLon: 2.47 }, geohash3: ['u09'] },
  'Berlin': { cityKey: 'BERLIN', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Berlin/Berlin.osm.pbf', pbfFilename: 'Berlin.osm.pbf', orsRegion: 'Berlin', country: 'DE', state: 'BE', bbox: { minLat: 52.34, maxLat: 52.68, minLon: 13.09, maxLon: 13.76 }, geohash3: ['u33'] },
  'New York': { cityKey: 'NEW_YORK', pbfUrl: 'https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf', pbfFilename: 'NewYork.osm.pbf', orsRegion: 'NewYork', country: 'US', state: 'NY', bbox: { minLat: 40.49, maxLat: 40.92, minLon: -74.26, maxLon: -73.70 }, geohash3: ['dr5', 'dr7'] },
  'Chicago': { cityKey: 'CHICAGO', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Chicago/Chicago.osm.pbf', pbfFilename: 'Chicago.osm.pbf', orsRegion: 'Chicago', country: 'US', state: 'IL', bbox: { minLat: 41.64, maxLat: 42.02, minLon: -87.94, maxLon: -87.52 }, geohash3: ['dp3'] },
  'Los Angeles': { cityKey: 'LOS_ANGELES', pbfUrl: 'https://download.bbbike.org/osm/bbbike/LosAngeles/LosAngeles.osm.pbf', pbfFilename: 'LosAngeles.osm.pbf', orsRegion: 'LosAngeles', country: 'US', state: 'CA', bbox: { minLat: 33.70, maxLat: 34.34, minLon: -118.67, maxLon: -117.65 }, geohash3: ['9mg', '9q5', '9qh'] },
  'San Francisco': { cityKey: 'SAN_FRANCISCO', pbfUrl: 'https://download.bbbike.org/osm/bbbike/SanFrancisco/SanFrancisco.osm.pbf', pbfFilename: 'SanFrancisco.osm.pbf', orsRegion: 'SanFrancisco', country: 'US', state: 'CA', bbox: { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 }, geohash3: ['9q8'] },
  'San Jose': { cityKey: 'SAN_JOSE', pbfUrl: 'https://download.bbbike.org/osm/bbbike/SanJose/SanJose.osm.pbf', pbfFilename: 'SanJose.osm.pbf', orsRegion: 'SanJose', country: 'US', state: 'CA', bbox: { minLat: 37.12, maxLat: 37.47, minLon: -122.05, maxLon: -121.72 }, geohash3: ['9q9'] },
  'Sacramento': { cityKey: 'SACRAMENTO', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Sacramento/Sacramento.osm.pbf', pbfFilename: 'Sacramento.osm.pbf', orsRegion: 'Sacramento', country: 'US', state: 'CA', bbox: { minLat: 38.43, maxLat: 38.70, minLon: -121.56, maxLon: -121.35 }, geohash3: ['9qc'] },
  'Santa Barbara': { cityKey: 'SANTA_BARBARA', pbfUrl: 'https://download.bbbike.org/osm/bbbike/SantaBarbara/SantaBarbara.osm.pbf', pbfFilename: 'SantaBarbara.osm.pbf', orsRegion: 'SantaBarbara', country: 'US', state: 'CA', bbox: { minLat: 34.38, maxLat: 34.46, minLon: -119.78, maxLon: -119.63 }, geohash3: ['9q4'] },
  'Stockton': { cityKey: 'STOCKTON', pbfUrl: 'https://download.bbbike.org/osm/bbbike/Stockton/Stockton.osm.pbf', pbfFilename: 'Stockton.osm.pbf', orsRegion: 'Stockton', country: 'US', state: 'CA', bbox: { minLat: 37.90, maxLat: 38.05, minLon: -121.38, maxLon: -121.20 }, geohash3: ['9q9', '9qc'] },
};

function getOrsRegion(city: string): string {
  return CITY_ORS_MAP[city]?.orsRegion || 'SanFrancisco';
}

function getGeohashFilter(city: string): string {
  const prefixes = CITY_ORS_MAP[city]?.geohash3 || ['9q8'];
  if (prefixes.length === 1) return `ST_GEOHASH(GEOMETRY) LIKE '${prefixes[0]}%'`;
  return '(' + prefixes.map((p: string) => `ST_GEOHASH(GEOMETRY) LIKE '${p}%'`).join(' OR ') + ')';
}

const ORS_PROFILE_MAP: Record<string, string> = {
  'cycling-regular': 'cycling-electric',
  'cycling-mountain': 'cycling-electric',
  'cycling-road': 'cycling-electric',
};
function mapOrsProfile(profile: string): string {
  return ORS_PROFILE_MAP[profile] || profile;
}

const ORS_REGION_CONFIG: Record<string, any> = {};
for (const [city, cfg] of Object.entries(CITY_ORS_MAP)) {
  if (!ORS_REGION_CONFIG[cfg.orsRegion]) {
    ORS_REGION_CONFIG[cfg.orsRegion] = { pbfUrl: cfg.pbfUrl, pbfFilename: cfg.pbfFilename, cities: [] };
  }
  ORS_REGION_CONFIG[cfg.orsRegion].cities.push(city);
}

const cityProvisionStates: Record<string, any> = {};
const activeStatements: Record<string, Set<string>> = {};
const cancelledJobs: Set<string> = new Set();

function trackStatement(jobKey: string, handle: string) {
  if (!activeStatements[jobKey]) activeStatements[jobKey] = new Set();
  activeStatements[jobKey].add(handle);
}

function untrackStatement(jobKey: string, handle: string) {
  activeStatements[jobKey]?.delete(handle);
}

async function cancelActiveStatements(jobKey: string): Promise<number> {
  cancelledJobs.add(jobKey);
  const handles = activeStatements[jobKey];
  if (!handles || handles.size === 0) return 0;
  let cancelled = 0;
  const token = getSpcsToken();
  const host = SNOWFLAKE_HOST;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  for (const handle of handles) {
    try {
      await fetch(`https://${host}/api/v2/statements/${handle}/cancel`, { method: 'POST', headers });
      cancelled++;
    } catch {}
  }
  handles.clear();
  return cancelled;
}

function getSpcsToken(): string {
  return readFileSync('/snowflake/session/token', 'utf-8').trim();
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[\d;]*m/g, '');
}

function cortexCompleteLocal(prompt: string, model: string = 'claude-4-sonnet'): string {
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

function cortexCompleteLocalFile(messages: any[], model: string = 'claude-4-sonnet'): string {
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

function snowSqlLocal(sql: string): any[] {
  const tmpFile = join(tmpdir(), `fleet_query_${Date.now()}.sql`);
  const fullSql = `USE WAREHOUSE ${SF_WAREHOUSE};\nUSE DATABASE ${SF_DATABASE};\nUSE SCHEMA ${SF_SCHEMA};\n${sql};`;
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

async function snowSqlSpcs(sql: string, timeoutSecs: number = 600, jobKey?: string): Promise<any[]> {
  if (jobKey && cancelledJobs.has(jobKey)) throw new Error('Job cancelled');
  const token = getSpcsToken();
  const host = SNOWFLAKE_HOST;
  const statementsUrl = `https://${host}/api/v2/statements`;
  const body = {
    statement: sql,
    timeout: timeoutSecs,
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

  let result: any = await res.json();
  const handle = result.statementHandle;
  if (jobKey && handle) trackStatement(jobKey, handle);

  try {
    if (result.statementStatusUrl && (!result.data || result.code === '333334')) {
      const pollUrl = `https://${host}${result.statementStatusUrl}`;
      const deadline = Date.now() + timeoutSecs * 1000;
      while (Date.now() < deadline) {
        if (jobKey && cancelledJobs.has(jobKey)) throw new Error('Job cancelled');
        await new Promise(r => setTimeout(r, 2000));
        const pollRes = await fetch(pollUrl, { method: 'GET', headers });
        if (!pollRes.ok) {
          const errText = await pollRes.text();
          throw new Error(`Snowflake poll error ${pollRes.status}: ${errText.slice(0, 500)}`);
        }
        result = await pollRes.json();
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
  } finally {
    if (jobKey && handle) untrackStatement(jobKey, handle);
  }
}

async function snowSql(sql: string, timeoutSecs?: number, jobKey?: string): Promise<any[]> {
  if (IS_SPCS) return snowSqlSpcs(sql, timeoutSecs || 600, jobKey);
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
    const dateFilter = req.query.date as string || '';
    const hourFilter = req.query.hour as string || '';
    const filterType = req.query.filter_type as string || '';
    const filterValue = req.query.filter_value as string || '';
    const conditions: string[] = [];
    if (city !== 'All Cities') conditions.push(`CITY = '${city.replace(/'/g, "''")}'`);
    if (statusFilter === 'active') conditions.push(`ORDER_STATUS != 'delivered'`);
    else if (statusFilter && statusFilter !== 'all') conditions.push(`ORDER_STATUS = '${statusFilter.replace(/'/g, "''")}'`);
    if (dateFilter) conditions.push(`TO_VARCHAR(ORDER_TIME::DATE, 'YYYY-MM-DD') = '${dateFilter.replace(/'/g, "''")}'`);
    if (hourFilter !== '' && dateFilter) {
      const hr = parseInt(hourFilter, 10);
      if (!isNaN(hr)) {
        const hrEnd = hr + 1;
        conditions.push(`ORDER_TIME < DATEADD(hour, ${hrEnd}, '${dateFilter}'::TIMESTAMP)`);
        conditions.push(`COALESCE(DELIVERY_TIME, CURRENT_TIMESTAMP()) >= DATEADD(hour, ${hr}, '${dateFilter}'::TIMESTAMP)`);
      }
    }
    const safeVal = filterValue.replace(/'/g, "''");
    if (filterType && filterValue) {
      switch (filterType.toLowerCase()) {
        case 'restaurant':
          conditions.push(`UPPER(RESTAURANT_NAME) LIKE UPPER('%${safeVal}%')`);
          break;
        case 'courier':
          conditions.push(`UPPER(COURIER_ID) LIKE UPPER('%${safeVal}%')`);
          break;
        case 'cuisine':
          conditions.push(`UPPER(CUISINE_TYPE) LIKE UPPER('%${safeVal}%')`);
          break;
        case 'vehicle':
          conditions.push(`UPPER(VEHICLE_TYPE) LIKE UPPER('%${safeVal}%')`);
          break;
        case 'shift':
          conditions.push(`UPPER(SHIFT_TYPE) LIKE UPPER('%${safeVal}%')`);
          break;
        case 'status':
          if (safeVal.toLowerCase() === 'active') conditions.push(`ORDER_STATUS != 'delivered'`);
          else conditions.push(`ORDER_STATUS = '${safeVal}'`);
          break;
      }
    }
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
  CITY,
  DELAY_REASON,
  DELAY_MINUTES,
  FLOOD_AFFECTED
FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY
${whereClause}
LIMIT 500`;

    console.log(`Fetching routes for ${city}...`);
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} routes`);
    res.json(rows);
  } catch (err: any) {
    console.error('Routes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const city = req.query.city as string || 'San Francisco';
    const alerts: any[] = [];
    try {
      const floods = await snowSql(`SELECT FLOOD_ID, FLOOD_NAME, SEVERITY, ST_ASGEOJSON(FLOOD_AREA) AS AREA_JSON,
        ST_Y(CENTROID) AS CENTER_LAT, ST_X(CENTROID) AS CENTER_LON,
        START_TIME, END_TIME, PEAK_TIME, WATER_LEVEL_M, IS_ACTIVE, AFFECTED_ROADS_EST, DESCRIPTION
      FROM ${SF_DATABASE}.DATA.FLOOD_MONITORING
      WHERE CITY = '${city.replace(/'/g, "''")}' AND IS_ACTIVE = TRUE`);
      for (const f of floods) {
        alerts.push({
          type: 'flood',
          id: f.FLOOD_ID,
          title: f.FLOOD_NAME,
          severity: f.SEVERITY,
          area_geojson: f.AREA_JSON ? JSON.parse(f.AREA_JSON) : null,
          center_lat: Number(f.CENTER_LAT),
          center_lon: Number(f.CENTER_LON),
          start_time: f.START_TIME,
          end_time: f.END_TIME,
          peak_time: f.PEAK_TIME,
          water_level_m: Number(f.WATER_LEVEL_M),
          affected_roads: Number(f.AFFECTED_ROADS_EST),
          description: f.DESCRIPTION,
        });
      }
    } catch {}
    try {
      const weather = await snowSql(`SELECT DISTINCT WEATHER_SEVERITY, WEATHER_CONDITION,
        COUNT(*) AS STATION_COUNT
      FROM ${SF_DATABASE}.DATA.WEATHER_OBSERVATIONS
      WHERE CITY = '${city.replace(/'/g, "''")}'
        AND WEATHER_SEVERITY IN ('warning', 'severe')
        AND OBSERVATION_TIME >= DATEADD('hour', -3, (SELECT MAX(OBSERVATION_TIME) FROM ${SF_DATABASE}.DATA.WEATHER_OBSERVATIONS))
      GROUP BY WEATHER_SEVERITY, WEATHER_CONDITION`);
      for (const w of weather) {
        alerts.push({
          type: 'weather',
          severity: w.WEATHER_SEVERITY,
          condition: w.WEATHER_CONDITION,
          station_count: Number(w.STATION_COUNT),
        });
      }
    } catch {}
    try {
      const incidents = await snowSql(`SELECT INCIDENT_TYPE, COUNT(*) AS CNT,
        ROUND(AVG(DELAY_MINUTES), 1) AS AVG_DELAY
      FROM ${SF_DATABASE}.DATA.DELIVERY_INCIDENTS
      WHERE CITY = '${city.replace(/'/g, "''")}'
      GROUP BY INCIDENT_TYPE`);
      const incidentSummary: Record<string, any> = {};
      for (const i of incidents) {
        incidentSummary[i.INCIDENT_TYPE] = { count: Number(i.CNT), avg_delay: Number(i.AVG_DELAY) };
      }
      if (Object.keys(incidentSummary).length > 0) {
        alerts.push({ type: 'incident_summary', incidents: incidentSummary });
      }
    } catch {}
    res.json(alerts);
  } catch (err: any) {
    res.json([]);
  }
});

app.get('/api/routes/dates', async (req, res) => {
  try {
    const city = req.query.city as string || 'San Francisco';
    const conditions: string[] = [];
    if (city !== 'All Cities') conditions.push(`CITY = '${city.replace(/'/g, "''")}'`);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT TO_VARCHAR(ORDER_TIME::DATE, 'YYYY-MM-DD') AS DT, COUNT(*) AS CNT
FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY
${whereClause}
GROUP BY DT ORDER BY DT`;
    const rows = await snowSql(sql);
    res.json(rows.map((r: any) => ({ date: r.DT, count: Number(r.CNT || 0) })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/routes/hours', async (req, res) => {
  try {
    const city = req.query.city as string || 'San Francisco';
    const dateFilter = req.query.date as string || '';
    const conditions: string[] = [];
    if (city !== 'All Cities') conditions.push(`CITY = '${city.replace(/'/g, "''")}'`);
    if (dateFilter) conditions.push(`TO_VARCHAR(CURR_TIME::DATE, 'YYYY-MM-DD') = '${dateFilter.replace(/'/g, "''")}'`);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT HOUR(CURR_TIME) AS HR, COUNT(DISTINCT ORDER_ID) AS ACTIVE_ORDERS
FROM ${SF_DATABASE}.${SF_SCHEMA}.COURIER_LOCATIONS
${whereClause}
AND COURIER_STATE IN ('en_route','picking_up','arriving')
GROUP BY HR ORDER BY HR`;
    const rows = await snowSql(sql);
    res.json(rows.map((r: any) => ({ hour: Number(r.HR), activeOrders: Number(r.ACTIVE_ORDERS || 0) })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/routes/courier-positions', async (req, res) => {
  try {
    const city = req.query.city as string || 'San Francisco';
    const dateFilter = req.query.date as string || '';
    const hourFilter = req.query.hour as string || '';
    const conditions: string[] = [];
    if (city !== 'All Cities') conditions.push(`cl.CITY = '${city.replace(/'/g, "''")}'`);
    if (dateFilter) conditions.push(`TO_VARCHAR(cl.CURR_TIME::DATE, 'YYYY-MM-DD') = '${dateFilter.replace(/'/g, "''")}'`);

    let hourCondition = '';
    if (hourFilter !== '') {
      const hr = parseInt(hourFilter, 10);
      if (dateFilter) {
        hourCondition = `AND cl.CURR_TIME >= '${dateFilter} ${String(hr).padStart(2,'0')}:00:00' AND cl.CURR_TIME < '${dateFilter} ${String(hr).padStart(2,'0')}:59:59'`;
      } else {
        hourCondition = `AND HOUR(cl.CURR_TIME) = ${hr}`;
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')} ${hourCondition}` : (hourCondition ? `WHERE 1=1 ${hourCondition}` : '');

    const sql = `WITH ranked AS (
  SELECT
    cl.COURIER_ID, cl.ORDER_ID, cl.COURIER_STATE, cl.KMH, cl.CURR_TIME, cl.POINT_INDEX,
    ST_Y(cl.POINT_GEOM) AS LAT, ST_X(cl.POINT_GEOM) AS LON,
    ST_Y(cl.CUSTOMER_LOCATION) AS DEST_LAT, ST_X(cl.CUSTOMER_LOCATION) AS DEST_LON,
    cl.DROPOFF_TIME,
    DATEDIFF('second', cl.CURR_TIME, cl.DROPOFF_TIME) AS ETA_SECS,
    ds.RESTAURANT_NAME, ds.CUSTOMER_ADDRESS,
    ROW_NUMBER() OVER (PARTITION BY cl.ORDER_ID ORDER BY cl.POINT_INDEX DESC) AS rn
  FROM ${SF_DATABASE}.${SF_SCHEMA}.COURIER_LOCATIONS cl
  LEFT JOIN ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY ds ON cl.ORDER_ID = ds.ORDER_ID
  ${whereClause}
  AND ds.ORDER_STATUS IN ('in_transit','picked_up')
  AND cl.COURIER_STATE IN ('en_route','picking_up','arriving')
)
SELECT COURIER_ID, ORDER_ID, COURIER_STATE, KMH, CURR_TIME, POINT_INDEX,
  LAT, LON, DEST_LAT, DEST_LON, DROPOFF_TIME,
  GREATEST(ETA_SECS, 0) AS ETA_SECS,
  ROUND(GREATEST(ETA_SECS, 0) / 60.0, 1) AS ETA_MINS,
  RESTAURANT_NAME, CUSTOMER_ADDRESS
FROM ranked WHERE rn = 1
ORDER BY COURIER_ID`;

    console.log(`Fetching courier positions for ${city} date=${dateFilter} hour=${hourFilter}`);
    const rows = await snowSql(sql);
    console.log(`Got ${rows.length} courier positions`);
    res.json(rows.map((r: any) => ({
      courier_id: r.COURIER_ID,
      order_id: r.ORDER_ID,
      state: r.COURIER_STATE,
      kmh: Number(r.KMH || 0),
      lat: Number(r.LAT),
      lon: Number(r.LON),
      dest_lat: Number(r.DEST_LAT),
      dest_lon: Number(r.DEST_LON),
      eta_secs: Number(r.ETA_SECS || 0),
      eta_mins: Number(r.ETA_MINS || 0),
      restaurant_name: r.RESTAURANT_NAME || '',
      customer_address: r.CUSTOMER_ADDRESS || '',
      time: r.CURR_TIME,
      point_index: Number(r.POINT_INDEX || 0),
    })));
  } catch (err: any) {
    console.error('Courier positions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/restaurants', async (req, res) => {
  try {
    const city = req.query.city as string || '';
    const conditions: string[] = [];
    if (city && city !== 'All Cities') conditions.push(`r.CITY = '${city.replace(/'/g, "''")}'`);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT
  r.NAME, r.CUISINE_TYPE AS CUISINE, r.CITY,
  ST_Y(r.LOCATION) AS LAT, ST_X(r.LOCATION) AS LON,
  COUNT(d.ORDER_ID) AS ORDERS
FROM ${SF_DATABASE}.${SF_SCHEMA}.RESTAURANTS r
LEFT JOIN ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_ROUTE_GEOMETRIES d
  ON r.RESTAURANT_ID = d.RESTAURANT_ID AND r.CITY = d.CITY
${whereClause}
GROUP BY r.NAME, r.CUISINE_TYPE, r.CITY, r.LOCATION
ORDER BY ORDERS DESC
LIMIT 2000`;
    const rows = await snowSql(sql);
    res.json(rows);
  } catch (err: any) {
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

    if (IS_SPCS) {
      send({ type: 'status', message: 'Connecting to Yum Drop agent...' });
      const { host, token } = getSpcsConfig();
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      };

      let threadId = '';
      try {
        const threadRes = await fetch(`https://${host}/api/v2/cortex/threads`, {
          method: 'POST', headers, body: JSON.stringify({})
        });
        if (threadRes.ok) {
          const threadData: any = await threadRes.json();
          threadId = threadData.thread_id || '';
        }
      } catch (threadErr: any) {
        console.error('Thread creation error:', threadErr.message);
      }

      const agentUrl = `https://${host}/api/v2/databases/${SF_DATABASE}/schemas/${AGENT_SCHEMA}/agents/${AGENT_NAME}:run`;
      const agentBody: any = {
        messages: [{ role: 'user', content: [{ type: 'text', text: userQuestion }] }]
      };
      if (threadId) {
        agentBody.thread_id = threadId;
        agentBody.parent_message_id = '0';
      }

      console.log('Calling Agent API:', agentUrl);
      const agentRes = await fetch(agentUrl, {
        method: 'POST',
        headers: { ...headers, 'Accept': 'text/event-stream' },
        body: JSON.stringify(agentBody),
      });

      if (!agentRes.ok) {
        const errText = await agentRes.text();
        console.error('Agent API error:', agentRes.status, errText.slice(0, 500));
        send({ type: 'error', message: `Agent API error ${agentRes.status}: ${errText.slice(0, 200)}` });
        send({ type: 'done' });
        res.end();
        return;
      }

      let accSql = '';
      let accExplanation = '';
      const reader = (agentRes.body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = '';
      let currentData = '';

      const processEvent = (evtType: string, evtData: string) => {
        let data: any;
        try { data = JSON.parse(evtData); } catch { return; }
        console.log('SSE event:', evtType, evtData.slice(0, 500));

        switch (evtType) {
          case 'response.status':
            send({ type: 'status', message: data.status || data.text || 'Processing...' });
            break;
          case 'response.thinking.delta':
            send({ type: 'thinking_delta', text: data.text || '' });
            break;
          case 'response.thinking':
            break;
          case 'response.tool_use':
            send({ type: 'tool_use', tool_name: data.name || 'fleet_data', tool_type: data.type || 'generic' });
            if (data.name === 'fleet_map_control' && data.input) {
              send({
                type: 'map_filter',
                filter_type: data.input.filter_type || 'all',
                filter_value: data.input.filter_value || '',
              });
            }
            send({ type: 'status', message: data.name === 'fleet_map_control' ? 'Updating map display...' : 'Querying Yum Drop data...' });
            break;
          case 'response.tool_result.status':
            send({ type: 'status', message: data.status || 'Running query...' });
            break;
          case 'response.tool_result.analyst.delta':
            if (data.delta?.sql) accSql += data.delta.sql;
            if (data.delta?.sql_explanation) accExplanation += data.delta.sql_explanation;
            if (data.delta?.think) send({ type: 'thinking_delta', text: data.delta.think });
            break;
          case 'response.tool_result.analyst.suggestion.delta':
            break;
          case 'response.tool_result': {
            if (data.name === 'fleet_map_control') {
              break;
            }
            const toolResult: any = {
              type: 'tool_result',
              tool_name: data.name || 'fleet_data',
              status: data.status === 'error' ? 'error' : 'complete',
              sql: accSql,
              sql_explanation: accExplanation,
              has_results: true,
            };
            if (data.content && Array.isArray(data.content)) {
              for (const c of data.content) {
                let rawText = '';
                if (c.type === 'text' && c.text) {
                  rawText = c.text;
                } else if (c.type === 'json' && c.json?.result) {
                  rawText = typeof c.json.result === 'string' ? c.json.result : JSON.stringify(c.json.result);
                  if (rawText.startsWith('"') && rawText.endsWith('"')) {
                    try { rawText = JSON.parse(rawText); } catch {}
                  }
                }
                if (rawText) {
                  try {
                    const parsed = JSON.parse(rawText);
                    if (parsed.sql) toolResult.sql = parsed.sql;
                    if (parsed.data && Array.isArray(parsed.data)) {
                      toolResult.row_count = parsed.row_count || parsed.data.length;
                      toolResult.results = parsed.data;
                    }
                    if (parsed.error) {
                      toolResult.status = 'error';
                      toolResult.error = parsed.error;
                    }
                    if (Array.isArray(parsed)) toolResult.row_count = parsed.length;
                  } catch {}
                }
              }
            }
            send(toolResult);
            accSql = '';
            accExplanation = '';
            break;
          }
          case 'response.text.delta':
            send({ type: 'text_delta', text: data.text || '' });
            break;
          case 'response.text':
            break;
          case 'response.text.annotation':
            break;
          case 'response.table':
            break;
          case 'response.chart':
            if (data.chart_spec) {
              try {
                const vegaSpec = typeof data.chart_spec === 'string' ? JSON.parse(data.chart_spec) : data.chart_spec;
                const chartData = vegaSpec?.data?.values || [];
                const encoding = vegaSpec?.encoding || {};
                const xField = encoding.x?.field || '';
                const yField = encoding.y?.field || '';
                if (xField && yField && chartData.length > 0) {
                  const chartBlock = JSON.stringify({
                    type: vegaSpec.mark === 'bar' ? 'bar' : 'line',
                    title: vegaSpec.title || '',
                    xKey: xField,
                    yKeys: [{ key: yField, label: yField.replace(/_/g, ' ') }],
                    data: chartData.slice(0, 30),
                  });
                  send({ type: 'text_delta', text: '\n```chart\n' + chartBlock + '\n```\n' });
                }
              } catch {}
            }
            break;
          case 'response': {
            if (data.content && Array.isArray(data.content)) {
              for (const item of data.content) {
                if (item.type === 'text' && item.text?.text) {
                  send({ type: 'text_delta', text: item.text.text });
                }
              }
            }
            break;
          }
          case 'metadata':
            break;
          case 'error':
            send({ type: 'error', message: data.message || data.error || 'Agent error' });
            break;
          default:
            break;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.substring(0, nlIdx).replace(/\r$/, '');
          buffer = buffer.substring(nlIdx + 1);

          if (line.startsWith('event:')) {
            currentEvent = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            const dataStr = line.substring(5).trim();
            currentData = currentData ? currentData + '\n' + dataStr : dataStr;
          } else if (line === '') {
            if (currentEvent && currentData) {
              processEvent(currentEvent, currentData);
            }
            currentEvent = '';
            currentData = '';
          }
        }
      }

      if (currentEvent && currentData) {
        processEvent(currentEvent, currentData);
      }

      send({ type: 'done' });
      res.end();
    } else {
      send({ type: 'status', message: 'Analyzing your question...' });
      send({ type: 'thinking_delta', text: 'Interpreting your question and generating a data query...\n' });
      send({ type: 'tool_use', tool_name: 'fleet_data', tool_type: 'cortex_analyst_text_to_sql' });
      send({ type: 'status', message: 'Querying Yum Drop data...' });

      const systemPrompt = `You are a fleet intelligence analyst for Yum Drop, a food delivery company operating across multiple cities including San Francisco, London, and Paris. Generate a SQL query for the user's question.

Available tables in ${SF_DATABASE}.${SF_SCHEMA}:
- DELIVERY_SUMMARY: ORDER_ID, COURIER_ID, RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_ADDRESS, RESTAURANT_LOCATION (GEOGRAPHY), CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION (GEOGRAPHY), CITY, ORDER_TIME (TIMESTAMP), PICKUP_TIME (TIMESTAMP), DELIVERY_TIME (TIMESTAMP), ORDER_STATUS (values: 'delivered', 'in_transit', 'picked_up'), ROUTE_DISTANCE_METERS (FLOAT), ROUTE_DURATION_SECS (FLOAT), PREP_TIME_MINS, SHIFT_TYPE (Lunch/Dinner/Afternoon), VEHICLE_TYPE (car/scooter/bicycle), AVERAGE_KMH, MAX_KMH, GEOMETRY (GEOGRAPHY)
- COURIER_LOCATIONS: ORDER_ID, COURIER_ID, ORDER_TIME (TIMESTAMP), PICKUP_TIME (TIMESTAMP), DROPOFF_TIME (TIMESTAMP), RESTAURANT_LOCATION (GEOGRAPHY), CUSTOMER_LOCATION (GEOGRAPHY), ROUTE (GEOGRAPHY), POINT_GEOM (GEOGRAPHY), CURR_TIME (TIMESTAMP), POINT_INDEX, COURIER_STATE (values: 'at_restaurant', 'picking_up', 'en_route', 'arriving', 'delivered'), KMH, CITY
- ORDERS_ASSIGNED_TO_COURIERS: COURIER_ID, ORDER_ID, RESTAURANT_ID, RESTAURANT_NAME, RESTAURANT_ADDRESS, CUSTOMER_ADDRESS, RESTAURANT_LOCATION (GEOGRAPHY), CUSTOMER_LOCATION (GEOGRAPHY), GEOMETRY (GEOGRAPHY), ORDER_TIME (TIMESTAMP), PICKUP_TIME (TIMESTAMP), DELIVERY_TIME (TIMESTAMP), ORDER_STATUS, CITY

IMPORTANT: ORDER_STATUS can be 'delivered', 'in_transit', or 'picked_up'. Active orders are those NOT 'delivered'.
For courier position queries, use COURIER_LOCATIONS table. Each delivery has 15 position snapshots (POINT_INDEX 0-14).
Return ONLY a JSON object: {"sql": "SELECT ...", "explanation": "..."}
Keep queries efficient. Use fully qualified table names. Limit detail queries to 20 rows.`;

      let sqlStatement = '';
      let sqlExplanation = '';

      const result = cortexCompleteLocalFile([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuestion },
      ], 'claude-4-sonnet');
      try {
        const jsonMatch = result.match(/\{[\s\S]*"sql"[\s\S]*\}/);
        if (jsonMatch) {
          const sanitized = jsonMatch[0].replace(/(?<=":[\s]*"[^"]*)\n/g, ' ').replace(/[\x00-\x1f]/g, (c: string) => c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '\\r' : '');
          let parsed: any;
          try {
            parsed = JSON.parse(sanitized);
          } catch {
            const sqlDirect = result.match(/"sql"\s*:\s*"([\s\S]*?)(?:"\s*[,}])/);
            const explDirect = result.match(/"explanation"\s*:\s*"([\s\S]*?)(?:"\s*[,}])/);
            if (sqlDirect) {
              parsed = { sql: sqlDirect[1].replace(/\\n/g, ' ').replace(/\n/g, ' '), explanation: explDirect?.[1] || '' };
            }
          }
          if (parsed) {
            sqlStatement = parsed.sql || '';
            sqlExplanation = parsed.explanation || '';
          }
        }
      } catch {}

      let queryResults: any[] = [];
      let queryError = '';

      if (sqlStatement) {
        send({ type: 'thinking_delta', text: `Generated SQL query. Executing...\n` });
        const toolResult: any = { type: 'tool_result', tool_name: 'fleet_data', status: 'complete', sql: sqlStatement };
        if (sqlExplanation) toolResult.sql_explanation = sqlExplanation;
        try {
          queryResults = await snowSql(sqlStatement);
          toolResult.has_results = true;
          toolResult.row_count = queryResults.length;
          toolResult.results = queryResults.slice(0, 50);
        } catch (sqlErr: any) {
          queryError = sqlErr.message;
          toolResult.status = 'error';
        }
        send(toolResult);
      } else {
        send({ type: 'tool_result', tool_name: 'fleet_data', status: 'error' });
      }

      send({ type: 'status', message: 'Generating response...' });

      const responsePrompt = `You are a fleet intelligence analyst for Yum Drop food delivery. Present data clearly with context.
Use markdown formatting with proper GFM tables when showing tabular data. Provide specific numbers and percentages when available.
If the data query returned no results (0 rows), say clearly that no data was found. Do NOT make up or hallucinate data.

When the query results contain time-series or comparative data, include a chart block:
\`\`\`chart
{"type": "line", "title": "Chart Title", "xKey": "col", "yKeys": [{"key": "col", "label": "Label"}], "data": [...]}
\`\`\`
Use type "line" for trends, "bar" for comparisons. Keep data to 30 rows max.`;

      let dataContext = '';
      if (queryResults.length > 0) {
        const maxRows = queryResults.slice(0, 50);
        dataContext = `\n\nQuery results (${queryResults.length} rows):\n${JSON.stringify(maxRows, null, 2)}`;
        if (sqlStatement) dataContext = `\nSQL executed: ${sqlStatement}` + dataContext;
      } else if (queryError) {
        dataContext = `\n\nThe data query failed: ${queryError}`;
      } else if (sqlStatement) {
        dataContext = `\nSQL executed: ${sqlStatement}\n\nThe query returned 0 rows.`;
      }

      const respResult = cortexCompleteLocalFile([
        { role: 'system', content: responsePrompt },
        { role: 'user', content: `${userQuestion}${dataContext}` },
      ], 'claude-4-sonnet');
      if (respResult) {
        send({ type: 'text_delta', text: respResult });
      } else {
        send({ type: 'text_delta', text: sqlExplanation || 'I was unable to generate a response.' });
      }

      send({ type: 'done' });
      res.end();
    }
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

const matrixBuildJobs: Record<string, { region: string; resolutions: number[]; started: number; statuses: Record<number, any> }> = {};

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

    for (const [region, cfg] of Object.entries(ORS_REGION_CONFIG)) {
      const svcName = `ORS_SERVICE_${region.toUpperCase()}`;
      const matrixFnName = `MATRIX_${region.toUpperCase()}`;
      const dirFnName = `DIRECTIONS_${region.toUpperCase()}`;

      const svcRow = services.find((r: any) => (r.name || r.NAME) === svcName);
      const serviceExists = !!svcRow;
      const serviceStatus = svcRow ? (svcRow.status || svcRow.STATUS || 'UNKNOWN') : 'NOT_FOUND';

      const matrixFunctionExists = functions.some((r: any) => {
        const name = (r.arguments || r.ARGUMENTS || '');
        return name.startsWith(matrixFnName + '(');
      });
      const directionsFunctionExists = functions.some((r: any) => {
        const name = (r.arguments || r.ARGUMENTS || '');
        return name.startsWith(dirFnName + '(');
      });

      const provisioned = serviceExists || matrixFunctionExists;
      const ready = serviceExists && matrixFunctionExists && (serviceStatus === 'RUNNING' || serviceStatus === 'SUSPENDED');

      const cityEntry = Object.entries(CITY_ORS_MAP).find(([, c]) => c.orsRegion === region);
      const bounds = cityEntry ? cityEntry[1].bbox : { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };

      regions.push({
        region,
        label: region.replace(/([A-Z])/g, ' $1').trim(),
        bounds,
        serviceStatus,
        serviceExists,
        matrixFunctionExists,
        directionsFunctionExists,
        ready,
        provisioned,
        matrixFn: `${SF_DATABASE}.ROUTING.${matrixFnName}`,
        cities: (cfg as any).cities || [],
      });
    }

    res.json({ regions });
  } catch (err: any) {
    res.json({ regions: [] });
  }
});

app.get('/api/matrix/existing', async (_req, res) => {
  try {
    const counts: Record<string, number> = {};
    const details: Array<{ table: string; region: string; vehicle_type: string; count: number }> = [];
    try {
      const rows = await snowSql(
        `SELECT TABLE_NAME, ROW_COUNT FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'DATA' AND TABLE_NAME IN ('CA_TRAVEL_TIME_RES7', 'CA_TRAVEL_TIME_RES8', 'CA_TRAVEL_TIME_RES9', 'CA_TRAVEL_TIME_RES10')`
      );
      for (const row of rows) {
        counts[row.TABLE_NAME] = Number(row.ROW_COUNT || 0);
      }
    } catch {
      for (const tbl of ['CA_TRAVEL_TIME_RES7', 'CA_TRAVEL_TIME_RES8', 'CA_TRAVEL_TIME_RES9', 'CA_TRAVEL_TIME_RES10']) {
        counts[tbl] = 0;
      }
    }
    try {
      for (const res_level of [7, 8, 9, 10]) {
        const tbl = `CA_TRAVEL_TIME_RES${res_level}`;
        if ((counts[tbl] || 0) > 0) {
          const breakdown = await snowSql(
            `SELECT REGION, COALESCE(VEHICLE_TYPE, 'driving-car') AS VEHICLE_TYPE, COUNT(*) AS CNT FROM ${SF_DATABASE}.DATA.${tbl} GROUP BY REGION, VEHICLE_TYPE`
          );
          for (const r of breakdown) {
            details.push({ table: tbl, region: r.REGION || 'unknown', vehicle_type: r.VEHICLE_TYPE || 'driving-car', count: Number(r.CNT || 0) });
          }
        }
      }
    } catch {}
    res.json({ counts, details });
  } catch (err: any) {
    res.json({ counts: {}, details: [] });
  }
});

app.get('/api/matrix/travel-times', async (req, res) => {
  try {
    const resolution = req.query.resolution || '8';
    const city = req.query.city as string || '';
    const region = city ? getOrsRegion(city) : '';
    const vehicle_type = req.query.vehicle_type as string || '';
    const tableName = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${resolution}`;
    const conditions: string[] = [];
    if (region) conditions.push(`REGION = '${region.replace(/'/g, "''")}' `);
    if (vehicle_type) conditions.push(`VEHICLE_TYPE = '${vehicle_type.replace(/'/g, "''")}' `);
    const regionFilter = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT
        ORIGIN_H3 AS HEX_ID,
        ST_Y(H3_CELL_TO_POINT(ORIGIN_H3)) AS LAT,
        ST_X(H3_CELL_TO_POINT(ORIGIN_H3)) AS LON,
        COUNT(DISTINCT DEST_H3) AS DEST_COUNT,
        ROUND(AVG(TRAVEL_TIME_SECONDS), 1) AS AVG_TRAVEL_TIME_SECS,
        ROUND(MIN(TRAVEL_TIME_SECONDS), 1) AS MIN_TRAVEL_TIME_SECS,
        ROUND(MAX(TRAVEL_TIME_SECONDS), 1) AS MAX_TRAVEL_TIME_SECS,
        ROUND(AVG(TRAVEL_DISTANCE_METERS), 1) AS AVG_DISTANCE_METERS,
        ROUND(MAX(TRAVEL_DISTANCE_METERS), 1) AS MAX_DISTANCE_METERS
      FROM ${tableName}
      ${regionFilter}
      GROUP BY ORIGIN_H3
      ORDER BY DEST_COUNT DESC
      LIMIT 5000`;
    const rows = await snowSql(sql);
    const totalRows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${tableName} ${regionFilter}`);
    res.json({ hexagons: rows, total_pairs: Number(totalRows[0]?.CNT || 0) });
  } catch (err: any) {
    res.json({ hexagons: [], total_pairs: 0 });
  }
});

app.get('/api/matrix/reachability', async (req, res) => {
  try {
    const origin = req.query.origin as string;
    const resolution = req.query.resolution || '8';
    const city = req.query.city as string || '';
    const region = city ? getOrsRegion(city) : '';
    const vehicle_type = req.query.vehicle_type as string || '';
    if (!origin) return res.status(400).json({ error: 'origin required' });
    const tableName = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${resolution}`;
    let regionFilter = region ? ` AND REGION = '${region.replace(/'/g, "''")}'` : '';
    if (vehicle_type) regionFilter += ` AND VEHICLE_TYPE = '${vehicle_type.replace(/'/g, "''")}'`;
    const sql = `
      SELECT
        DEST_H3 AS HEX_ID,
        ST_Y(H3_CELL_TO_POINT(DEST_H3)) AS LAT,
        ST_X(H3_CELL_TO_POINT(DEST_H3)) AS LON,
        TRAVEL_TIME_SECONDS AS TRAVEL_TIME_SECS,
        TRAVEL_DISTANCE_METERS AS DISTANCE_METERS
      FROM ${tableName}
      WHERE ORIGIN_H3 = '${origin.replace(/'/g, "''")}'${regionFilter}
      ORDER BY TRAVEL_TIME_SECONDS`;
    const rows = await snowSql(sql);
    const originLatLon = await snowSql(`SELECT ST_Y(H3_CELL_TO_POINT('${origin.replace(/'/g, "''")}')) AS LAT, ST_X(H3_CELL_TO_POINT('${origin.replace(/'/g, "''")}')) AS LON`);
    res.json({
      destinations: rows,
      origin_lat: originLatLon[0]?.LAT || 0,
      origin_lon: originLatLon[0]?.LON || 0,
    });
  } catch (err: any) {
    res.json({ destinations: [], origin_lat: 0, origin_lon: 0 });
  }
});

app.get('/api/matrix/catchment', async (req, res) => {
  try {
    const origin = req.query.origin as string;
    const resolution = req.query.resolution || '8';
    const maxMinutes = Number(req.query.max_minutes || 30);
    const city = req.query.city as string || '';
    const region = city ? getOrsRegion(city) : '';
    if (!origin) return res.status(400).json({ error: 'origin required' });
    const tableName = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${resolution}`;
    const regionFilter = region ? ` AND REGION = '${region.replace(/'/g, "''")}'` : '';
    const reachSql = `
      SELECT DEST_H3
      FROM ${tableName}
      WHERE ORIGIN_H3 = '${origin.replace(/'/g, "''")}'
        AND TRAVEL_TIME_SECONDS <= ${maxMinutes * 60}${regionFilter}`;
    const reachRows = await snowSql(reachSql);
    const reachHexes = reachRows.map((r: any) => r.DEST_H3);

    const travelTimeMap: Record<string, number> = {};
    if (reachHexes.length > 0) {
      const ttSql = `
        SELECT DEST_H3, TRAVEL_TIME_SECONDS
        FROM ${tableName}
        WHERE ORIGIN_H3 = '${origin.replace(/'/g, "''")}'
          AND TRAVEL_TIME_SECONDS <= ${maxMinutes * 60}${regionFilter}`;
      const ttRows = await snowSql(ttSql);
      for (const r of ttRows) {
        travelTimeMap[r.DEST_H3] = Number(r.TRAVEL_TIME_SECONDS);
      }
    }

    let restaurants: any[] = [];
    let customers: any[] = [];
    if (reachHexes.length > 0) {
      const hexList = reachHexes.map((h: string) => `'${h}'`).join(',');
      try {
        const restSql = `
          SELECT
            RESTAURANT_NAME,
            CUISINE_TYPE,
            CITY,
            ST_Y(TO_GEOGRAPHY(RESTAURANT_LOCATION)) AS LAT,
            ST_X(TO_GEOGRAPHY(RESTAURANT_LOCATION)) AS LON,
            H3_LATLNG_TO_CELL_STRING(ST_Y(TO_GEOGRAPHY(RESTAURANT_LOCATION)), ST_X(TO_GEOGRAPHY(RESTAURANT_LOCATION)), ${resolution}) AS HEX_ID,
            COUNT(*) AS ORDER_COUNT,
            SUM(CASE WHEN ORDER_STATUS != 'delivered' THEN 1 ELSE 0 END) AS ACTIVE_COUNT
          FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY
          WHERE H3_LATLNG_TO_CELL_STRING(ST_Y(TO_GEOGRAPHY(RESTAURANT_LOCATION)), ST_X(TO_GEOGRAPHY(RESTAURANT_LOCATION)), ${resolution}) IN (${hexList})
          GROUP BY RESTAURANT_NAME, CUISINE_TYPE, CITY, LAT, LON, HEX_ID
          ORDER BY ORDER_COUNT DESC
          LIMIT 200`;
        const rawRest = await snowSql(restSql);
        restaurants = rawRest.map((r: any) => {
          const hexId = r.HEX_ID;
          const travelSecs = travelTimeMap[hexId] || 0;
          return {
            name: r.RESTAURANT_NAME || '',
            cuisine: r.CUISINE_TYPE || '',
            city: r.CITY || '',
            lat: Number(r.LAT) || 0,
            lon: Number(r.LON) || 0,
            drive_mins: Math.round(travelSecs / 60),
            orders: Number(r.ORDER_COUNT) || 0,
            active: Number(r.ACTIVE_COUNT) || 0,
          };
        });
      } catch (e: any) { console.error('catchment restaurants error:', e.message); }
      try {
        const custSql = `
          SELECT
            ST_Y(TO_GEOGRAPHY(CUSTOMER_LOCATION)) AS LAT,
            ST_X(TO_GEOGRAPHY(CUSTOMER_LOCATION)) AS LON,
            ORDER_STATUS,
            RESTAURANT_NAME,
            H3_LATLNG_TO_CELL_STRING(ST_Y(TO_GEOGRAPHY(CUSTOMER_LOCATION)), ST_X(TO_GEOGRAPHY(CUSTOMER_LOCATION)), ${resolution}) AS HEX_ID,
            ROUTE_DURATION_SECS
          FROM ${SF_DATABASE}.${SF_SCHEMA}.DELIVERY_SUMMARY
          WHERE H3_LATLNG_TO_CELL_STRING(ST_Y(TO_GEOGRAPHY(CUSTOMER_LOCATION)), ST_X(TO_GEOGRAPHY(CUSTOMER_LOCATION)), ${resolution}) IN (${hexList})
          ORDER BY ORDER_TIME DESC
          LIMIT 500`;
        const rawCust = await snowSql(custSql);
        customers = rawCust.map((r: any) => ({
          lat: Number(r.LAT) || 0,
          lon: Number(r.LON) || 0,
          status: r.ORDER_STATUS || '',
          restaurant: r.RESTAURANT_NAME || '',
          drive_mins: Math.round(Number(r.ROUTE_DURATION_SECS || 0) / 60),
        }));
      } catch (e: any) { console.error('catchment customers error:', e.message); }
    }
    const totalDeliveries = customers.length;
    res.json({
      origin,
      resolution: Number(resolution),
      max_minutes: maxMinutes,
      total_deliveries: totalDeliveries,
      reachable_hexagons: reachHexes.length,
      restaurants,
      customers,
    });
  } catch (err: any) {
    res.json({ origin: req.query.origin, restaurants: [], customers: [], reachable_hexagons: 0 });
  }
});

app.post('/api/matrix/build', async (req, res) => {
  try {
    const { region, resolutions, vehicle_type = 'cycling-electric' } = req.body;
    if (!region || !resolutions?.length) {
      return res.status(400).json({ error: 'region and resolutions required' });
    }

    const cityEntry = Object.entries(CITY_ORS_MAP).find(([, c]) => c.orsRegion === region);
    if (!cityEntry) {
      return res.status(400).json({ error: `Unknown region: ${region}` });
    }
    const bounds = cityEntry[1].bbox;
    const matrixFnName = `MATRIX_${region.toUpperCase()}`;
    const matrixFn = `${SF_DATABASE}.ROUTING.${matrixFnName}`;
    const vehicleProfile = mapOrsProfile(vehicle_type || 'cycling-electric');

    const jobId = `${region}_${vehicleProfile}_${Date.now()}`;
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
    const matrixJobKey = `matrix_${region}`;
    cancelledJobs.delete(matrixJobKey);

    try {
      await snowSql(`ALTER SERVICE IF EXISTS ${SF_DATABASE}.ROUTING.ROUTING_GATEWAY_SERVICE RESUME`);
    } catch {}
    if (region === 'SanFrancisco') {
      try { await snowSql(`ALTER SERVICE IF EXISTS ${SF_DATABASE}.ROUTING.ORS_SERVICE RESUME`); } catch {}
    } else {
      try { await snowSql(`ALTER SERVICE IF EXISTS ${SF_DATABASE}.ROUTING.ORS_SERVICE_${region.toUpperCase()} RESUME`); } catch {}
    }

    try {
      await snowSql(`CALL ${SF_DATABASE}.DATA.SCALE_MATRIX_INFRASTRUCTURE('${region}', TRUE)`);
      console.log(`[matrix] Scaled UP infrastructure for ${region}`);
    } catch (e: any) {
      console.log(`[matrix] Scale up warning: ${e.message}`);
    }

    const WORKERS_BY_RES: Record<number, number> = { 7: 4, 8: 4, 9: 2, 10: 1 };

    for (const r of resolutions) {
      const resLabel = `RES${r}`;
      const numWorkers = WORKERS_BY_RES[r] || 2;

      (async () => {
        try {
          statuses[r].stage = 'BUILDING_HEXAGONS';
          await snowSql(`CALL ${SF_DATABASE}.DATA.BUILD_HEXAGONS('${resLabel}', ${bounds.minLat}, ${bounds.maxLat}, ${bounds.minLon}, ${bounds.maxLon})`);

          statuses[r].stage = 'BUILDING_WORK_QUEUE';
          await snowSql(`CALL ${SF_DATABASE}.DATA.BUILD_WORK_QUEUE('${resLabel}')`);

          const qRows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.DATA.CA_WORK_QUEUE_${resLabel}`);
          const queueCount = Number(qRows[0]?.CNT || 0);
          statuses[r].work_queue = queueCount;
          statuses[r].total_origins = queueCount;

          await snowSql(`DELETE FROM ${SF_DATABASE}.DATA.CA_MATRIX_RAW_${resLabel}`);

          statuses[r].stage = 'COMPUTING_MATRIX';
          const chunkSize = Math.ceil(queueCount / numWorkers);
          const workerPromises: Promise<any>[] = [];
          for (let w = 0; w < numWorkers; w++) {
            const startSeq = w * chunkSize + 1;
            const endSeq = Math.min((w + 1) * chunkSize, queueCount);
            if (startSeq > queueCount) break;
            workerPromises.push(
              snowSql(
                `CALL ${SF_DATABASE}.DATA.BUILD_TRAVEL_TIME_RANGE_REGION('${resLabel}', ${startSeq}, ${endSeq}, '${matrixFn}', '${vehicleProfile}')`,
                7200,
                matrixJobKey
              ).catch((err: any) => {
                console.error(`[matrix] Worker ${w} (${startSeq}-${endSeq}) error: ${err.message}`);
                throw err;
              })
            );
          }
          console.log(`[matrix] ${resLabel}: launched ${workerPromises.length} parallel workers for ${queueCount} origins`);
          await Promise.all(workerPromises);

          statuses[r].stage = 'FLATTENING';
          await snowSql(
            `CALL ${SF_DATABASE}.DATA.FLATTEN_MATRIX_RAW('${resLabel}', '${region}', '${vehicleProfile}')`,
            3600
          );

          const travelRows = await snowSql(
            `SELECT COUNT(*) as CNT FROM ${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${r} WHERE REGION = '${region}' AND VEHICLE_TYPE = '${vehicleProfile}'`
          );
          const totalPairs = Number(travelRows[0]?.CNT || 0);

          statuses[r].status = 'complete';
          statuses[r].stage = 'COMPLETE';
          statuses[r].built_pairs = totalPairs;
          statuses[r].total_pairs = totalPairs;
          statuses[r].flattened = totalPairs;
          statuses[r].percent_complete = 100;
        } catch (err: any) {
          statuses[r].status = 'error';
          statuses[r].error = err.message?.slice(0, 200);
        }
      })();
    }

    (async () => {
      const checkInterval = setInterval(async () => {
        const allDone = Object.values(statuses).every(s => s.status !== 'building');
        if (allDone) {
          clearInterval(checkInterval);
          try {
            await snowSql(`CALL ${SF_DATABASE}.DATA.SCALE_MATRIX_INFRASTRUCTURE('${region}', FALSE)`);
            console.log(`[matrix] Scaled DOWN infrastructure for ${region}`);
          } catch (e: any) {
            console.log(`[matrix] Scale down warning: ${e.message}`);
          }
        }
      }, 30000);
    })();

    res.json({ status: 'started', jobId, region, vehicle_type: vehicleProfile });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matrix/cancel', async (req, res) => {
  try {
    const { region } = req.body || {};
    if (!region) return res.status(400).json({ error: 'region required' });
    const jobKey = `matrix_${region}`;
    const cancelled = await cancelActiveStatements(jobKey);
    const job = matrixBuildJobs[region];
    if (job) {
      for (const r of job.resolutions) {
        if (job.statuses[r].status === 'building') {
          job.statuses[r].status = 'error';
          job.statuses[r].error = 'Cancelled by user';
          job.statuses[r].stage = 'CANCELLED';
        }
      }
    }
    try {
      await snowSql(`CALL ${SF_DATABASE}.DATA.SCALE_MATRIX_INFRASTRUCTURE('${region}', FALSE)`);
    } catch {}
    console.log(`[cancel] Matrix build cancelled for ${region}: ${cancelled} statements`);
    res.json({ status: 'cancelled', region, statements_cancelled: cancelled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matrix/status', async (req, res) => {
  try {
    const region = req.query.region as string;
    const job = matrixBuildJobs[region];
    if (!job) {
      return res.json({ region, resolutions: [] });
    }

    for (const r of job.resolutions) {
      if (job.statuses[r].status === 'building') {
        try {
          const elapsed = (Date.now() - job.started) / 1000;
          job.statuses[r].elapsed_seconds = elapsed;

          let hexCount = 0;
          try {
            const hRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${SF_DATABASE}.DATA.CA_H3_RES${r}`);
            hexCount = Number(hRows[0]?.CNT || 0);
          } catch {}
          job.statuses[r].hexagons = hexCount;

          let queueCount = 0;
          try {
            const qRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${SF_DATABASE}.DATA.CA_WORK_QUEUE_RES${r}`);
            queueCount = Number(qRows[0]?.CNT || 0);
          } catch {}
          job.statuses[r].work_queue = queueCount;
          job.statuses[r].total_origins = queueCount;

          let rawCount = 0;
          try {
            const rRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${SF_DATABASE}.DATA.CA_MATRIX_RAW_RES${r}`);
            rawCount = Number(rRows[0]?.CNT || 0);
          } catch {}
          job.statuses[r].raw_ingested = rawCount;

          let travelCount = 0;
          try {
            const tRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${r} WHERE REGION = '${region}'`);
            travelCount = Number(tRows[0]?.CNT || 0);
          } catch {}
          job.statuses[r].flattened = travelCount;
          job.statuses[r].built_pairs = travelCount;
          job.statuses[r].total_pairs = queueCount > 0 ? queueCount : hexCount;
          job.statuses[r].processed_origins = rawCount;

          if (hexCount > 0 && queueCount === 0) {
            job.statuses[r].stage = 'HEXAGONS_READY';
          } else if (queueCount > 0 && travelCount === 0) {
            job.statuses[r].stage = rawCount > 0 ? 'BUILDING' : 'QUEUED';
          } else if (travelCount > 0 && rawCount < queueCount) {
            job.statuses[r].stage = 'BUILDING';
          } else if (travelCount > 0) {
            job.statuses[r].stage = 'COMPLETE';
          }

          if (queueCount > 0) {
            job.statuses[r].percent_complete = Math.min(99, (rawCount / queueCount) * 100);
          }
        } catch {}
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

app.post('/api/query', async (req, res) => {
  try {
    let query = '';
    if (req.body.data && Array.isArray(req.body.data)) {
      query = req.body.data[0]?.[1] || '';
    } else {
      query = req.body.query || '';
    }
    if (!query) return res.json({ data: [[0, JSON.stringify({ error: 'query parameter required' })]] });

    const schemaInfo = `Table: ${SF_DATABASE}.DATA.DELIVERY_SUMMARY
Columns:
  ORDER_ID VARCHAR - Unique delivery order identifier
  COURIER_ID VARCHAR - Courier assigned (e.g. SAN-0029, LON-0015)
  RESTAURANT_ID VARCHAR - Restaurant identifier
  RESTAURANT_NAME VARCHAR - Name of the restaurant
  RESTAURANT_ADDRESS VARCHAR - Restaurant street address
  CUSTOMER_ADDRESS VARCHAR - Customer delivery address
  CUSTOMER_ADDRESS_ID VARCHAR - Customer address identifier
  CITY VARCHAR - City (San Francisco, London, Paris, etc.)
  ORDER_STATUS VARCHAR - Status: delivered, in_transit, or picked_up
  ORDER_TIME TIMESTAMP - When the order was placed
  PICKUP_TIME TIMESTAMP - When courier picked up order
  DELIVERY_TIME TIMESTAMP - When the order was delivered
  SHIFT_TYPE VARCHAR - Shift: Lunch, Dinner, or Afternoon
  VEHICLE_TYPE VARCHAR - Vehicle: car, scooter, or bicycle
  CUISINE_TYPE VARCHAR - Type of cuisine
  PREP_TIME_MINS NUMBER - Restaurant food prep time in minutes
  ROUTE_DISTANCE_METERS FLOAT - Delivery route distance in meters
  ROUTE_DURATION_SECS FLOAT - Delivery route duration in seconds
  AVERAGE_KMH NUMBER(38,6) - Average courier speed in kmh
  MAX_KMH NUMBER - Maximum courier speed in kmh
  DELAY_REASON VARCHAR - Reason for delay: traffic, flooding, weather, or none
  DELAY_MINUTES FLOAT - Total delay in minutes due to incidents
  FLOOD_AFFECTED BOOLEAN - Whether delivery was affected by flooding
  DELAY_WEATHER_CONDITION VARCHAR - Weather condition that caused the delay

Table: ${SF_DATABASE}.DATA.WEATHER_OBSERVATIONS
Columns:
  OBSERVATION_ID VARCHAR - Unique observation identifier
  OBSERVATION_TIME TIMESTAMP - Time of weather observation (hourly intervals)
  STATION_NAME VARCHAR - Weather station name
  TEMPERATURE_C FLOAT - Temperature in celsius
  FEELS_LIKE_C FLOAT - Feels-like temperature in celsius
  WIND_SPEED_MPH FLOAT - Wind speed in mph
  WIND_GUST_MPH FLOAT - Wind gust speed in mph
  WIND_DIRECTION VARCHAR - Wind direction (N, NE, E, SE, S, SW, W, NW)
  HUMIDITY_PCT FLOAT - Humidity percentage
  PRESSURE_HPA FLOAT - Atmospheric pressure in hPa
  VISIBILITY_KM FLOAT - Visibility in km
  PRECIPITATION_MM FLOAT - Precipitation in mm
  WEATHER_CONDITION VARCHAR - Condition: Clear, Cloudy, Light Rain, Heavy Rain, Thunderstorm, Fog, Snow
  WEATHER_SEVERITY VARCHAR - Severity: normal, advisory, warning, severe
  UV_INDEX INTEGER - UV index
  CITY VARCHAR - City name

Table: ${SF_DATABASE}.DATA.WEATHER_FORECASTS
Columns:
  FORECAST_ID VARCHAR - Unique forecast identifier
  ISSUED_AT TIMESTAMP - When the forecast was issued
  FORECAST_TIME TIMESTAMP - Future time the forecast is for
  STATION_NAME VARCHAR - Weather station name
  TEMPERATURE_C FLOAT - Forecast temperature in celsius
  FEELS_LIKE_C FLOAT - Forecast feels-like temperature
  WIND_SPEED_MPH FLOAT - Forecast wind speed in mph
  WIND_GUST_MPH FLOAT - Forecast wind gust speed
  PRECIPITATION_PROB_PCT FLOAT - Probability of precipitation (0-100)
  PRECIPITATION_MM FLOAT - Forecast precipitation in mm
  WEATHER_CONDITION VARCHAR - Forecast condition: Clear, Cloudy, Light Rain, Heavy Rain, Thunderstorm
  WEATHER_SEVERITY VARCHAR - Forecast severity: normal, advisory, warning, severe
  CITY VARCHAR - City name

Table: ${SF_DATABASE}.DATA.FLOOD_MONITORING
Columns:
  FLOOD_ID VARCHAR - Unique flood event identifier
  FLOOD_NAME VARCHAR - Name of the flood event
  SEVERITY VARCHAR - Flood severity: minor, moderate, severe
  START_TIME TIMESTAMP - When the flood started
  END_TIME TIMESTAMP - When the flood ended or expected to end
  PEAK_TIME TIMESTAMP - When the flood peaked
  WATER_LEVEL_M FLOAT - Water level in meters
  IS_ACTIVE BOOLEAN - Whether the flood is currently active
  AFFECTED_ROADS_EST INTEGER - Estimated number of affected roads
  DESCRIPTION VARCHAR - Flood description
  CITY VARCHAR - City name

Table: ${SF_DATABASE}.DATA.DELIVERY_INCIDENTS
Columns:
  INCIDENT_ID VARCHAR - Unique incident identifier
  ORDER_ID VARCHAR - Related delivery order ID (joins to DELIVERY_SUMMARY.ORDER_ID)
  COURIER_ID VARCHAR - Courier involved
  INCIDENT_TYPE VARCHAR - Type: traffic, flooding, weather
  INCIDENT_TIME TIMESTAMP - When the incident occurred
  DELAY_MINUTES FLOAT - Delay caused in minutes
  DESCRIPTION VARCHAR - Incident description
  RELATED_FLOOD_ID VARCHAR - Related flood ID if flooding type (joins to FLOOD_MONITORING.FLOOD_ID)
  WEATHER_CONDITION VARCHAR - Weather during incident
  RESOLVED_TIME TIMESTAMP - When incident was resolved
  CITY VARCHAR - City name

Table: ${SF_DATABASE}.DATA.CUSTOMER_CALLS
Columns:
  CALL_ID VARCHAR - Unique call identifier
  ORDER_ID VARCHAR - Related delivery order ID (joins to DELIVERY_SUMMARY.ORDER_ID)
  CALL_TIME TIMESTAMP - Time of customer call
  CUSTOMER_NAME VARCHAR - Customer name
  CALL_DURATION_SECS INTEGER - Call duration in seconds
  CALL_TYPE VARCHAR - Type: complaint, enquiry, cancellation
  SENTIMENT VARCHAR - Customer sentiment: angry, frustrated, neutral, understanding
  ISSUE_CATEGORY VARCHAR - Issue: late delivery, weather delay, flood delay, missing items, wrong order
  CALL_NOTES VARCHAR - Verbatim customer comments
  RESOLUTION VARCHAR - How the call was resolved
  RELATED_INCIDENT_ID VARCHAR - Related incident ID
  CITY VARCHAR - City name

RELATIONSHIPS:
  DELIVERY_INCIDENTS.ORDER_ID -> DELIVERY_SUMMARY.ORDER_ID
  CUSTOMER_CALLS.ORDER_ID -> DELIVERY_SUMMARY.ORDER_ID
  DELIVERY_INCIDENTS.RELATED_FLOOD_ID -> FLOOD_MONITORING.FLOOD_ID`;

    const prompt = `You are a SQL expert for a food delivery fleet analytics system. Generate a single Snowflake SQL query to answer the user question. Return ONLY the SQL query, no explanation, no markdown, no backticks. Use efficient aggregation queries. For weather summaries, aggregate across all stations in a single query rather than querying per-station. For forecasts, query WEATHER_FORECASTS table directly by FORECAST_TIME.\n\nSchema:\n${schemaInfo}\n\nQuestion: ${query}`;
    const escapedPrompt = prompt.replace(/'/g, "''").replace(/\\/g, '\\\\');

    const cortexResult = await snowSql(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-4-sonnet', '${escapedPrompt}') AS RESULT`);
    let generatedSql = (cortexResult[0]?.RESULT || '').trim();
    if (generatedSql.startsWith('```')) {
      generatedSql = generatedSql.split('\n').slice(1).join('\n').replace(/```\s*$/, '').trim();
    }

    if (!generatedSql || generatedSql.length < 5) {
      const result = JSON.stringify({ error: 'Failed to generate SQL', sql: generatedSql });
      return res.json({ data: [[0, result]] });
    }

    const rows = await snowSql(generatedSql);
    const data = rows.slice(0, 50);
    const result = JSON.stringify({ sql: generatedSql, row_count: rows.length, data });
    res.json({ data: [[0, result]] });
  } catch (err: any) {
    console.error('Query endpoint error:', err.message);
    const result = JSON.stringify({ error: err.message?.slice(0, 500) });
    res.json({ data: [[0, result]] });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: IS_SPCS ? 'spcs' : 'local' });
});

app.delete('/api/matrix/remove', async (req, res) => {
  try {
    const resolutions = (req.query.resolutions as string || '7,8,9,10').split(',').map(Number);
    const region = req.query.region as string || '';
    const vehicle_type = req.query.vehicle_type as string || '';
    const results: Record<number, { table: string; rows_before: number; rows_removed: number; status: string }> = {};

    for (const r of resolutions) {
      const tableName = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${r}`;
      try {
        if (region || vehicle_type) {
          const conditions: string[] = [];
          if (region) conditions.push(`REGION = '${region.replace(/'/g, "''")}'`);
          if (vehicle_type) conditions.push(`VEHICLE_TYPE = '${vehicle_type.replace(/'/g, "''")}'`);
          const whereClause = conditions.join(' AND ');
          const countRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${tableName} WHERE ${whereClause}`);
          const rowsBefore = Number(countRows[0]?.CNT || 0);
          await snowSql(`DELETE FROM ${tableName} WHERE ${whereClause}`);
          results[r] = { table: tableName, rows_before: rowsBefore, rows_removed: rowsBefore, status: 'removed' };
        } else {
          const countRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${tableName}`);
          const rowsBefore = Number(countRows[0]?.CNT || 0);
          await snowSql(`TRUNCATE TABLE ${tableName}`);
          results[r] = { table: tableName, rows_before: rowsBefore, rows_removed: rowsBefore, status: 'removed' };
        }
      } catch (err: any) {
        results[r] = { table: tableName, rows_before: 0, rows_removed: 0, status: 'error' };
      }
    }

    res.json({ status: 'removed', resolutions: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matrix/restore', async (req, res) => {
  try {
    const { resolutions = [7, 8, 9, 10], offset_minutes = 5 } = req.body;
    const results: Record<number, { table: string; rows_restored: number; status: string; sql: string }> = {};

    for (const r of resolutions) {
      const tableName = `${SF_DATABASE}.DATA.CA_TRAVEL_TIME_RES${r}`;
      try {
        const restoreSql = `INSERT INTO ${tableName} SELECT * FROM ${tableName} AT(OFFSET => -${offset_minutes * 60})`;
        await snowSql(restoreSql);
        const countRows = await snowSql(`SELECT COUNT(*) as CNT FROM ${tableName}`);
        const rowsRestored = Number(countRows[0]?.CNT || 0);
        results[r] = { table: tableName, rows_restored: rowsRestored, status: 'restored', sql: restoreSql };
      } catch (err: any) {
        results[r] = { table: tableName, rows_restored: 0, status: 'error', sql: err.message?.slice(0, 200) };
      }
    }

    res.json({ status: 'restored', resolutions: results });
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
      'DELIVERY_ROUTE_GEOMETRIES', 'COURIER_LOCATIONS',
      'WEATHER_OBSERVATIONS', 'WEATHER_FORECASTS', 'FLOOD_MONITORING',
      'DELIVERY_INCIDENTS', 'CUSTOMER_CALLS'];
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
    const tables = ['CUSTOMER_CALLS', 'DELIVERY_INCIDENTS', 'FLOOD_MONITORING',
      'WEATHER_FORECASTS', 'WEATHER_OBSERVATIONS',
      'COURIER_LOCATIONS', 'DELIVERY_ROUTE_GEOMETRIES', 'DELIVERY_ROUTES_PARSED',
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

  const { cities = ['San Francisco'], num_couriers = 50, num_days = 1, start_date = '2025-01-15', shifts, vehicle_type = 'cycling-electric' } = req.body;
  const DB = SF_DATABASE;
  const cityList = cities.map((c: string) => `'${c.replace(/'/g, "''")}'`).join(',');
  const vehicleType = mapOrsProfile(vehicle_type || 'cycling-electric');

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
    { step: 'weather', status: 'idle' },
    { step: 'floods', status: 'idle' },
    { step: 'incidents', status: 'idle' },
    { step: 'calls', status: 'idle' },
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
WHERE ST_GEOHASH(GEOMETRY) LIKE '9q8%' AND COUNTRY = 'US' AND ADDRESS_LEVELS[0]:value::STRING = 'CA' AND STREET IS NOT NULL`);
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
  '${vehicleType.replace(/'/g, "''")}' AS VEHICLE_TYPE
FROM courier_assignments ca LEFT JOIN home_locations hl ON ca.courier_num = hl.rn`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.COURIERS`);
        updateStep('couriers', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[2].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('couriers', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 4: Numbered tables + Delivery Orders
      updateStep('orders', { status: 'running', message: 'Generating delivery orders...', started_at: Date.now() });
      try {
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.RESTAURANTS_NUMBERED
SELECT RESTAURANT_ID, LOCATION, NAME, CUISINE_TYPE, ADDRESS,
  ROW_NUMBER() OVER (ORDER BY HASH(RESTAURANT_ID)) AS RN
FROM ${DB}.DATA.RESTAURANTS WHERE NAME IS NOT NULL AND LENGTH(NAME) > 2 AND CITY IN (${cityList})`);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.ADDRESSES_NUMBERED
SELECT ADDRESS_ID, LOCATION, FULL_ADDRESS,
  ROW_NUMBER() OVER (ORDER BY HASH(ADDRESS_ID)) AS RN
FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE FULL_ADDRESS IS NOT NULL AND LENGTH(FULL_ADDRESS) > 3 AND CITY IN (${cityList})`);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.DELIVERY_ORDERS
WITH courier_order_counts AS (
  SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR,
    c.SHIFT_CROSSES_MIDNIGHT, c.VEHICLE_TYPE,
    CASE c.SHIFT_TYPE WHEN 'Lunch' THEN UNIFORM(25,35,RANDOM()) WHEN 'Dinner' THEN UNIFORM(25,35,RANDOM())
      WHEN 'Breakfast' THEN UNIFORM(15,25,RANDOM()) WHEN 'Afternoon' THEN UNIFORM(18,28,RANDOM())
      WHEN 'Late Night' THEN UNIFORM(10,18,RANDOM()) END AS NUM_ORDERS
  FROM ${DB}.DATA.COURIERS c
),
order_sequence AS (
  SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR, c.SHIFT_CROSSES_MIDNIGHT,
    c.VEHICLE_TYPE, c.NUM_ORDERS, ROW_NUMBER() OVER (PARTITION BY c.COURIER_ID ORDER BY RANDOM()) AS ORDER_NUMBER
  FROM courier_order_counts c CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 40)) g
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
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.ORDERS_WITH_LOCATIONS
SELECT o.ORDER_ID, o.COURIER_ID, o.ORDER_HOUR, o.ORDER_NUMBER, o.SHIFT_TYPE, o.VEHICLE_TYPE,
  r.RESTAURANT_ID, r.NAME AS RESTAURANT_NAME, r.CUISINE_TYPE, r.LOCATION AS RESTAURANT_LOCATION,
  r.ADDRESS AS RESTAURANT_ADDRESS, a.ADDRESS_ID AS CUSTOMER_ADDRESS_ID, a.FULL_ADDRESS AS CUSTOMER_ADDRESS,
  a.LOCATION AS CUSTOMER_LOCATION, o.PREP_TIME_MINS, o.ORDER_STATUS
FROM ${DB}.DATA.DELIVERY_ORDERS o
JOIN ${DB}.DATA.RESTAURANTS_NUMBERED r ON o.RESTAURANT_IDX = r.RN
JOIN ${DB}.DATA.ADDRESSES_NUMBERED a ON o.CUSTOMER_IDX = a.RN`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ORDERS`);
        updateStep('orders', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[3].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('orders', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 5: ORS Routes — check service is running first
      updateStep('routes', { status: 'running', message: 'Checking ORS service status...', started_at: Date.now() });
      try {
        const buildRegion = getOrsRegion(cities[0]);
        const buildSvcName = `ORS_SERVICE_${buildRegion.toUpperCase()}`;
        const regionCheck = await checkOrsRegionReady(buildRegion);
        if (regionCheck.serviceExists && regionCheck.serviceStatus === 'SUSPENDED') {
          updateStep('routes', { status: 'running', message: `Resuming ${buildSvcName}...` });
          await snowSql(`ALTER SERVICE ${SF_DATABASE}.ROUTING.${buildSvcName} RESUME`);
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const recheck = await checkOrsRegionReady(buildRegion);
            if (recheck.serviceStatus === 'READY') break;
            updateStep('routes', { status: 'running', message: `Waiting for ${buildSvcName} to be READY (${i * 5}s)...` });
          }
        }
        updateStep('routes', { status: 'running', message: 'Generating ORS routes (this may take several minutes)...' });
        const routingFn = getDirectionsFn(cities[0]);
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.DELIVERY_ROUTES
SELECT COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
  RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
  CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
  ${routingFn}(
    '${vehicleType.replace(/'/g, "''")}',
    ARRAY_CONSTRUCT(ST_X(RESTAURANT_LOCATION), ST_Y(RESTAURANT_LOCATION)),
    ARRAY_CONSTRUCT(ST_X(CUSTOMER_LOCATION), ST_Y(CUSTOMER_LOCATION))
  ) AS ROUTE_RESPONSE
FROM ${DB}.DATA.ORDERS_WITH_LOCATIONS`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ROUTES`);
        updateStep('routes', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[4].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('routes', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 6: Parse routes + geometries
      updateStep('geometries', { status: 'running', message: 'Parsing routes and computing geometries...', started_at: Date.now() });
      try {
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.DELIVERY_ROUTES_PARSED
SELECT COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
  RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
  CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
  TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry) AS ROUTE_GEOMETRY,
  PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:distance::FLOAT AS ROUTE_DISTANCE_METERS,
  PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:duration::FLOAT AS ROUTE_DURATION_SECS
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
  NULL AS CITY
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
    ST_NPOINTS(GEOMETRY)::NUMBER(10,0) AS NUM_POINTS, PREP_TIME_MINS
  FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE GEOMETRY IS NOT NULL
),
point_seq AS (SELECT SEQ4()::NUMBER(10,0) AS POINT_INDEX FROM TABLE(GENERATOR(ROWCOUNT => 15))),
expanded AS (
  SELECT r.COURIER_ID, r.ORDER_ID, r.ORDER_TIME, r.PICKUP_TIME, r.DELIVERY_TIME,
    r.RESTAURANT_LOCATION, r.CUSTOMER_LOCATION, r.ROUTE, r.NUM_POINTS,
    r.ROUTE_DURATION_SECS, r.VEHICLE_TYPE, p.POINT_INDEX,
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
      CASE '${vehicleType.replace(/'/g, "''")}'
      WHEN 'cycling-regular' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(8,15,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(15,22,RANDOM()) ELSE UNIFORM(20,30,RANDOM()) END
      WHEN 'cycling-road' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(12,18,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(18,28,RANDOM()) ELSE UNIFORM(25,35,RANDOM()) END
      WHEN 'cycling-electric' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(15,22,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(22,30,RANDOM()) ELSE UNIFORM(28,40,RANDOM()) END
      WHEN 'cycling-mountain' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(6,12,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(12,18,RANDOM()) ELSE UNIFORM(16,25,RANDOM()) END
      WHEN 'foot-walking' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(3,5,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(4,6,RANDOM()) ELSE UNIFORM(5,7,RANDOM()) END
      WHEN 'foot-hiking' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(3,5,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(4,6,RANDOM()) ELSE UNIFORM(5,8,RANDOM()) END
      WHEN 'wheelchair' THEN
        CASE WHEN SPEED_ROLL<=20 THEN UNIFORM(2,4,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(3,5,RANDOM()) ELSE UNIFORM(4,6,RANDOM()) END
      WHEN 'driving-hgv' THEN
        CASE WHEN HOUR(CURR_TIME) BETWEEN 11 AND 13 THEN
          CASE WHEN SPEED_ROLL<=25 THEN UNIFORM(5,12,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(12,25,RANDOM()) ELSE UNIFORM(20,40,RANDOM()) END
        WHEN HOUR(CURR_TIME) BETWEEN 18 AND 20 THEN
          CASE WHEN SPEED_ROLL<=30 THEN UNIFORM(5,12,RANDOM()) WHEN SPEED_ROLL<=65 THEN UNIFORM(12,25,RANDOM()) ELSE UNIFORM(20,35,RANDOM()) END
        ELSE CASE WHEN SPEED_ROLL<=15 THEN UNIFORM(8,18,RANDOM()) WHEN SPEED_ROLL<=45 THEN UNIFORM(18,30,RANDOM()) ELSE UNIFORM(25,45,RANDOM()) END
        END
      ELSE CASE WHEN HOUR(CURR_TIME) BETWEEN 11 AND 13 THEN
          CASE WHEN SPEED_ROLL<=25 THEN UNIFORM(5,15,RANDOM()) WHEN SPEED_ROLL<=60 THEN UNIFORM(15,30,RANDOM()) ELSE UNIFORM(25,45,RANDOM()) END
        WHEN HOUR(CURR_TIME) BETWEEN 18 AND 20 THEN
          CASE WHEN SPEED_ROLL<=30 THEN UNIFORM(5,15,RANDOM()) WHEN SPEED_ROLL<=65 THEN UNIFORM(15,30,RANDOM()) ELSE UNIFORM(25,40,RANDOM()) END
        ELSE CASE WHEN SPEED_ROLL<=15 THEN UNIFORM(10,20,RANDOM()) WHEN SPEED_ROLL<=45 THEN UNIFORM(20,35,RANDOM()) ELSE UNIFORM(30,55,RANDOM()) END
        END END AS KMH,
  NULL AS CITY
FROM expanded`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.COURIER_LOCATIONS`);
        updateStep('locations', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[6].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('locations', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 8: Weather Observations (Met Office style)
      updateStep('weather', { status: 'running', message: 'Generating Met Office weather observations...', started_at: Date.now() });
      try {
        const weatherStations: Record<string, { name: string; lat: number; lon: number }[]> = {
          'San Francisco': [
            { name: 'SF Downtown', lat: 37.7749, lon: -122.4194 },
            { name: 'SF Mission District', lat: 37.7599, lon: -122.4148 },
            { name: 'SF Marina', lat: 37.8015, lon: -122.4368 },
            { name: 'SF Sunset', lat: 37.7525, lon: -122.4949 },
            { name: 'SF SoMa', lat: 37.7785, lon: -122.3950 },
            { name: 'SF Richmond', lat: 37.7799, lon: -122.4644 },
            { name: 'SF Bayview', lat: 37.7296, lon: -122.3876 },
            { name: 'SF North Beach', lat: 37.8061, lon: -122.4103 },
          ],
          'London': [
            { name: 'London City', lat: 51.5074, lon: -0.1278 },
            { name: 'London Heathrow', lat: 51.4700, lon: -0.4543 },
            { name: 'London Greenwich', lat: 51.4769, lon: -0.0005 },
            { name: 'London Kensington', lat: 51.4988, lon: -0.1749 },
            { name: 'London Camden', lat: 51.5390, lon: -0.1426 },
            { name: 'London Canary Wharf', lat: 51.5054, lon: -0.0235 },
          ],
          'Paris': [
            { name: 'Paris Centre', lat: 48.8566, lon: 2.3522 },
            { name: 'Paris Orly', lat: 48.7262, lon: 2.3652 },
            { name: 'Paris Montmartre', lat: 48.8867, lon: 2.3431 },
            { name: 'Paris La Defense', lat: 48.8924, lon: 2.2360 },
          ],
        };

        const stationsForCity = weatherStations[cities[0]] || weatherStations['San Francisco'];
        const stationUnions = stationsForCity.map(s =>
          `SELECT '${s.name.replace(/'/g, "''")}' AS station_name, ST_MAKEPOINT(${s.lon}, ${s.lat}) AS station_location`
        ).join(' UNION ALL\n  ');

        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.WEATHER_OBSERVATIONS
WITH date_range AS (
  SELECT DATEADD('day', -SEQ4(), '${start_date}'::DATE) AS obs_date
  FROM TABLE(GENERATOR(ROWCOUNT => ${num_days}))
),
hours AS (
  SELECT SEQ4() AS obs_hour FROM TABLE(GENERATOR(ROWCOUNT => 24))
),
stations AS (
  ${stationUnions}
),
base_weather AS (
  SELECT
    d.obs_date, h.obs_hour, s.station_name, s.station_location,
    d.obs_date = (SELECT MAX(obs_date) FROM date_range) AS is_last_day,
    UNIFORM(1, 100, RANDOM()) AS weather_roll,
    UNIFORM(1, 100, RANDOM()) AS severity_roll
  FROM date_range d CROSS JOIN hours h CROSS JOIN stations s
)
SELECT
  MD5(station_name || obs_date || obs_hour || RANDOM()) AS OBSERVATION_ID,
  DATEADD('hour', obs_hour, obs_date::TIMESTAMP_NTZ) AS OBSERVATION_TIME,
  station_name AS STATION_NAME,
  station_location AS STATION_LOCATION,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN ROUND(UNIFORM(8, 14, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
    WHEN obs_hour BETWEEN 0 AND 6 THEN ROUND(UNIFORM(5, 10, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
    WHEN obs_hour BETWEEN 7 AND 11 THEN ROUND(UNIFORM(10, 16, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
    WHEN obs_hour BETWEEN 12 AND 17 THEN ROUND(UNIFORM(14, 22, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
    ELSE ROUND(UNIFORM(8, 15, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
  END AS TEMPERATURE_C,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN ROUND(UNIFORM(4, 10, RANDOM())::FLOAT, 1)
    ELSE ROUND(UNIFORM(6, 18, RANDOM())::FLOAT, 1)
  END AS FEELS_LIKE_C,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 11 AND 15 THEN ROUND(UNIFORM(25, 45, RANDOM())::FLOAT, 1)
    ELSE ROUND(UNIFORM(3, 20, RANDOM())::FLOAT, 1)
  END AS WIND_SPEED_MPH,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 11 AND 15 THEN ROUND(UNIFORM(35, 60, RANDOM())::FLOAT, 1)
    ELSE ROUND(UNIFORM(5, 30, RANDOM())::FLOAT, 1)
  END AS WIND_GUST_MPH,
  CASE UNIFORM(1,8,RANDOM()) WHEN 1 THEN 'N' WHEN 2 THEN 'NE' WHEN 3 THEN 'E' WHEN 4 THEN 'SE' WHEN 5 THEN 'S' WHEN 6 THEN 'SW' WHEN 7 THEN 'W' ELSE 'NW' END AS WIND_DIRECTION,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN ROUND(UNIFORM(85, 98, RANDOM())::FLOAT, 1)
    ELSE ROUND(UNIFORM(40, 80, RANDOM())::FLOAT, 1)
  END AS HUMIDITY_PCT,
  ROUND(UNIFORM(1005, 1025, RANDOM())::FLOAT - CASE WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN 20 ELSE 0 END, 1) AS PRESSURE_HPA,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 11 AND 15 THEN ROUND(UNIFORM(0.5, 3, RANDOM())::FLOAT, 1)
    ELSE ROUND(UNIFORM(5, 30, RANDOM())::FLOAT, 1)
  END AS VISIBILITY_KM,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 11 AND 15 THEN ROUND(UNIFORM(8, 25, RANDOM())::FLOAT, 1)
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN ROUND(UNIFORM(3, 12, RANDOM())::FLOAT, 1)
    WHEN weather_roll <= 30 THEN ROUND(UNIFORM(0.1, 2, RANDOM())::FLOAT, 1)
    ELSE 0
  END AS PRECIPITATION_MM,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 12 AND 14 THEN 'Thunderstorm'
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN 'Heavy Rain'
    WHEN is_last_day AND obs_hour IN (9, 17) THEN 'Light Rain'
    WHEN weather_roll <= 15 THEN 'Heavy Rain'
    WHEN weather_roll <= 35 THEN 'Light Rain'
    WHEN weather_roll <= 50 THEN 'Overcast'
    WHEN weather_roll <= 70 THEN 'Cloudy'
    WHEN weather_roll <= 85 THEN 'Partly Cloudy'
    ELSE 'Clear'
  END AS WEATHER_CONDITION,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 12 AND 14 THEN 'severe'
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN 'warning'
    WHEN is_last_day AND obs_hour IN (9, 17) THEN 'advisory'
    WHEN weather_roll <= 15 THEN 'advisory'
    ELSE 'normal'
  END AS WEATHER_SEVERITY,
  CASE WHEN obs_hour BETWEEN 10 AND 16 THEN UNIFORM(1, 6, RANDOM()) ELSE 0 END AS UV_INDEX,
  '${cities[0].replace(/'/g, "''")}' AS CITY
FROM base_weather`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.WEATHER_OBSERVATIONS`);
        updateStep('weather', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[7].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('weather', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 8b: Weather Forecasts (future 3 days)
      try {
        const lastDate = `'${start_date}'::DATE`;
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.WEATHER_FORECASTS
WITH forecast_days AS (
  SELECT DATEADD('day', SEQ4() + 1, ${lastDate}) AS forecast_date
  FROM TABLE(GENERATOR(ROWCOUNT => 3))
),
hours AS (
  SELECT SEQ4() * 3 AS fc_hour FROM TABLE(GENERATOR(ROWCOUNT => 8))
),
stations AS (
  SELECT DISTINCT STATION_NAME, STATION_LOCATION FROM ${DB}.DATA.WEATHER_OBSERVATIONS LIMIT 8
)
SELECT
  MD5(s.STATION_NAME || d.forecast_date || h.fc_hour || RANDOM()) AS FORECAST_ID,
  ${lastDate}::TIMESTAMP_NTZ AS ISSUED_AT,
  DATEADD('hour', h.fc_hour, d.forecast_date::TIMESTAMP_NTZ) AS FORECAST_TIME,
  s.STATION_NAME, s.STATION_LOCATION,
  ROUND(UNIFORM(10, 20, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1) AS TEMPERATURE_C,
  ROUND(UNIFORM(8, 17, RANDOM())::FLOAT, 1) AS FEELS_LIKE_C,
  ROUND(UNIFORM(5, 18, RANDOM())::FLOAT, 1) AS WIND_SPEED_MPH,
  ROUND(UNIFORM(10, 25, RANDOM())::FLOAT, 1) AS WIND_GUST_MPH,
  ROUND(UNIFORM(10, 60, RANDOM())::FLOAT, 0) AS PRECIPITATION_PROB_PCT,
  ROUND(UNIFORM(0, 3, RANDOM())::FLOAT, 1) AS PRECIPITATION_MM,
  CASE UNIFORM(1,5,RANDOM()) WHEN 1 THEN 'Light Rain' WHEN 2 THEN 'Cloudy' WHEN 3 THEN 'Partly Cloudy' WHEN 4 THEN 'Overcast' ELSE 'Clear' END AS WEATHER_CONDITION,
  'normal' AS WEATHER_SEVERITY,
  '${cities[0].replace(/'/g, "''")}' AS CITY
FROM forecast_days d CROSS JOIN hours h CROSS JOIN stations s`);
      } catch (err: any) { console.error('Weather forecast generation error:', err.message); }

      // Step 9: Flood Monitoring (flash flood on most recent day only)
      updateStep('floods', { status: 'running', message: 'Generating flood monitoring data...', started_at: Date.now() });
      try {
        const floodZones: Record<string, { name: string; polygon: string; desc: string }> = {
          'San Francisco': {
            name: 'Mission Creek Flash Flood',
            polygon: 'POLYGON((-122.4010 37.7705, -122.3985 37.7695, -122.3960 37.7692, -122.3935 37.7698, -122.3912 37.7708, -122.3898 37.7725, -122.3892 37.7748, -122.3900 37.7770, -122.3915 37.7790, -122.3935 37.7805, -122.3955 37.7812, -122.3975 37.7808, -122.3992 37.7795, -122.4005 37.7775, -122.4012 37.7750, -122.4015 37.7730, -122.4010 37.7705))',
            desc: 'Flash flooding reported in the Mission Creek and SoMa area. Surface water flooding affecting roads and low-lying areas. Multiple road closures in effect. Drainage systems overwhelmed by sudden heavy rainfall.'
          },
          'London': {
            name: 'Thames Barrier Flash Flood',
            polygon: 'POLYGON((-0.0590 51.4908, -0.0520 51.4895, -0.0440 51.4892, -0.0360 51.4900, -0.0280 51.4915, -0.0220 51.4938, -0.0210 51.4970, -0.0225 51.5005, -0.0260 51.5035, -0.0310 51.5058, -0.0380 51.5075, -0.0450 51.5072, -0.0520 51.5055, -0.0570 51.5030, -0.0598 51.4995, -0.0605 51.4955, -0.0590 51.4908))',
            desc: 'Flash flooding in the Greenwich and Isle of Dogs area. Surface water flooding affecting major roads. Thames Barrier activated. Multiple road closures.'
          },
          'Paris': {
            name: 'Seine Overflow Flash Flood',
            polygon: 'POLYGON((2.3215 48.8458, 2.3290 48.8448, 2.3370 48.8445, 2.3450 48.8452, 2.3530 48.8465, 2.3585 48.8490, 2.3598 48.8525, 2.3580 48.8558, 2.3545 48.8585, 2.3490 48.8605, 2.3420 48.8618, 2.3350 48.8612, 2.3285 48.8595, 2.3235 48.8568, 2.3210 48.8535, 2.3200 48.8498, 2.3215 48.8458))',
            desc: 'Flash flooding near the Seine river in the 5th and 13th arrondissements. Surface water affecting roads and metro stations.'
          },
        };
        const zone = floodZones[cities[0]] || floodZones['San Francisco'];
        const lastDay = `'${start_date}'::DATE`;

        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.FLOOD_MONITORING
SELECT
  'FLOOD-001' AS FLOOD_ID,
  '${zone.name.replace(/'/g, "''")}' AS FLOOD_NAME,
  'severe' AS SEVERITY,
  TRY_TO_GEOGRAPHY('${zone.polygon}') AS FLOOD_AREA,
  ST_CENTROID(TRY_TO_GEOGRAPHY('${zone.polygon}')) AS CENTROID,
  DATEADD('hour', 11, ${lastDay}::TIMESTAMP_NTZ) AS START_TIME,
  DATEADD('hour', 17, ${lastDay}::TIMESTAMP_NTZ) AS END_TIME,
  DATEADD('hour', 13, ${lastDay}::TIMESTAMP_NTZ) AS PEAK_TIME,
  1.8 AS WATER_LEVEL_M,
  TRUE AS IS_ACTIVE,
  12 AS AFFECTED_ROADS_EST,
  '${zone.desc.replace(/'/g, "''")}' AS DESCRIPTION,
  '${cities[0].replace(/'/g, "''")}' AS CITY
UNION ALL
SELECT
  'FLOOD-002', '${(cities[0] === 'London' ? 'Wandsworth Surface Water' : cities[0] === 'Paris' ? 'Marais District Drainage' : 'Bayview Basin Overflow').replace(/'/g, "''")}',
  'moderate',
  TRY_TO_GEOGRAPHY('${
    cities[0] === 'San Francisco' ? 'POLYGON((-122.3955 37.7258, -122.3930 37.7248, -122.3900 37.7245, -122.3870 37.7250, -122.3842 37.7262, -122.3820 37.7282, -122.3812 37.7305, -122.3825 37.7328, -122.3848 37.7348, -122.3878 37.7365, -122.3910 37.7372, -122.3938 37.7365, -122.3958 37.7345, -122.3965 37.7318, -122.3962 37.7290, -122.3955 37.7258))'
    : cities[0] === 'London' ? 'POLYGON((-0.1990 51.4558, -0.1930 51.4548, -0.1865 51.4545, -0.1800 51.4555, -0.1745 51.4572, -0.1718 51.4600, -0.1712 51.4635, -0.1730 51.4665, -0.1770 51.4688, -0.1825 51.4702, -0.1890 51.4708, -0.1948 51.4698, -0.1985 51.4675, -0.2002 51.4645, -0.2005 51.4610, -0.1990 51.4558))'
    : 'POLYGON((2.3510 48.8558, 2.3548 48.8548, 2.3585 48.8550, 2.3618 48.8562, 2.3640 48.8582, 2.3645 48.8608, 2.3632 48.8635, 2.3608 48.8655, 2.3575 48.8668, 2.3540 48.8672, 2.3508 48.8662, 2.3488 48.8642, 2.3482 48.8615, 2.3490 48.8588, 2.3510 48.8558))'
  }'),
  ST_CENTROID(TRY_TO_GEOGRAPHY('${
    cities[0] === 'San Francisco' ? 'POLYGON((-122.3955 37.7258, -122.3930 37.7248, -122.3900 37.7245, -122.3870 37.7250, -122.3842 37.7262, -122.3820 37.7282, -122.3812 37.7305, -122.3825 37.7328, -122.3848 37.7348, -122.3878 37.7365, -122.3910 37.7372, -122.3938 37.7365, -122.3958 37.7345, -122.3965 37.7318, -122.3962 37.7290, -122.3955 37.7258))'
    : cities[0] === 'London' ? 'POLYGON((-0.1990 51.4558, -0.1930 51.4548, -0.1865 51.4545, -0.1800 51.4555, -0.1745 51.4572, -0.1718 51.4600, -0.1712 51.4635, -0.1730 51.4665, -0.1770 51.4688, -0.1825 51.4702, -0.1890 51.4708, -0.1948 51.4698, -0.1985 51.4675, -0.2002 51.4645, -0.2005 51.4610, -0.1990 51.4558))'
    : 'POLYGON((2.3510 48.8558, 2.3548 48.8548, 2.3585 48.8550, 2.3618 48.8562, 2.3640 48.8582, 2.3645 48.8608, 2.3632 48.8635, 2.3608 48.8655, 2.3575 48.8668, 2.3540 48.8672, 2.3508 48.8662, 2.3488 48.8642, 2.3482 48.8615, 2.3490 48.8588, 2.3510 48.8558))'
  }')),
  DATEADD('hour', 12, ${lastDay}::TIMESTAMP_NTZ),
  DATEADD('hour', 16, ${lastDay}::TIMESTAMP_NTZ),
  DATEADD('hour', 14, ${lastDay}::TIMESTAMP_NTZ),
  0.9, TRUE, 6,
  'Moderate surface water flooding affecting local roads. Drains overwhelmed. Caution advised for drivers and cyclists.',
  '${cities[0].replace(/'/g, "''")}' AS CITY`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.FLOOD_MONITORING`);
        updateStep('floods', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[8].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('floods', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 10: Delivery Incidents (traffic delays + flood delays + weather delays)
      updateStep('incidents', { status: 'running', message: 'Generating delivery incidents and delays...', started_at: Date.now() });
      try {
        const lastDay = `'${start_date}'::DATE`;

        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.DELIVERY_INCIDENTS
WITH all_deliveries AS (
  SELECT ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, GEOMETRY, CITY,
    DATE_TRUNC('day', ORDER_TIME) AS ORDER_DATE,
    DATE_TRUNC('day', ORDER_TIME) = ${lastDay}::DATE AS is_last_day,
    HOUR(ORDER_TIME) AS order_hour
  FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES
  WHERE GEOMETRY IS NOT NULL
),
flood_zones AS (
  SELECT FLOOD_ID, FLOOD_AREA, START_TIME, END_TIME
  FROM ${DB}.DATA.FLOOD_MONITORING
),
weather_at_time AS (
  SELECT DISTINCT DATE_TRUNC('hour', OBSERVATION_TIME) AS obs_hour, WEATHER_CONDITION, WEATHER_SEVERITY
  FROM ${DB}.DATA.WEATHER_OBSERVATIONS
  WHERE WEATHER_SEVERITY IN ('warning', 'severe')
),
flood_affected AS (
  SELECT d.ORDER_ID, d.COURIER_ID, d.ORDER_TIME, d.CUSTOMER_LOCATION, d.CITY,
    f.FLOOD_ID, 'flooding' AS INCIDENT_TYPE,
    UNIFORM(15, 45, RANDOM()) AS DELAY_MINUTES,
    CASE UNIFORM(1,3,RANDOM())
      WHEN 1 THEN 'Route blocked by flash flooding. Courier diverted via alternative route.'
      WHEN 2 THEN 'Delivery delayed due to road closure from flooding. Area impassable.'
      ELSE 'Surface water on route caused significant slowdown. Courier proceeded with caution.'
    END AS DESCRIPTION
  FROM all_deliveries d
  JOIN flood_zones f ON d.is_last_day
    AND d.ORDER_TIME BETWEEN f.START_TIME AND f.END_TIME
    AND ST_DWITHIN(d.CUSTOMER_LOCATION, f.FLOOD_AREA, 800)
),
weather_affected AS (
  SELECT d.ORDER_ID, d.COURIER_ID, d.ORDER_TIME, d.CUSTOMER_LOCATION, d.CITY,
    NULL AS FLOOD_ID, 'weather' AS INCIDENT_TYPE,
    UNIFORM(5, 20, RANDOM()) AS DELAY_MINUTES,
    CASE w.WEATHER_CONDITION
      WHEN 'Heavy Rain' THEN 'Heavy rain reducing visibility and road grip. Courier speed reduced for safety.'
      WHEN 'Thunderstorm' THEN 'Thunderstorm conditions. Courier sheltered temporarily before continuing.'
      ELSE 'Adverse weather conditions causing delivery slowdown.'
    END AS DESCRIPTION
  FROM all_deliveries d
  JOIN weather_at_time w ON DATE_TRUNC('hour', d.ORDER_TIME) = w.obs_hour
  WHERE d.ORDER_ID NOT IN (SELECT ORDER_ID FROM flood_affected)
    AND UNIFORM(1, 100, RANDOM()) <= 40
),
traffic_affected AS (
  SELECT d.ORDER_ID, d.COURIER_ID, d.ORDER_TIME, d.CUSTOMER_LOCATION, d.CITY,
    NULL AS FLOOD_ID, 'traffic' AS INCIDENT_TYPE,
    UNIFORM(5, 15, RANDOM()) AS DELAY_MINUTES,
    CASE UNIFORM(1,5,RANDOM())
      WHEN 1 THEN 'Heavy traffic congestion on main route. Courier stuck at intersection.'
      WHEN 2 THEN 'Road works causing detour and delay.'
      WHEN 3 THEN 'Accident on route causing traffic backup.'
      WHEN 4 THEN 'Rush hour congestion significantly slowing courier progress.'
      ELSE 'Unexpected traffic delay on delivery route.'
    END AS DESCRIPTION
  FROM all_deliveries d
  WHERE d.ORDER_ID NOT IN (SELECT ORDER_ID FROM flood_affected)
    AND d.ORDER_ID NOT IN (SELECT ORDER_ID FROM weather_affected)
    AND d.order_hour BETWEEN 11 AND 20
    AND UNIFORM(1, 100, RANDOM()) <= 12
)
SELECT
  MD5(ORDER_ID || INCIDENT_TYPE || RANDOM()) AS INCIDENT_ID,
  ORDER_ID, COURIER_ID, INCIDENT_TYPE,
  DATEADD('minute', UNIFORM(5, 30, RANDOM()), ORDER_TIME) AS INCIDENT_TIME,
  DELAY_MINUTES, CUSTOMER_LOCATION AS INCIDENT_LOCATION,
  DESCRIPTION, FLOOD_ID AS RELATED_FLOOD_ID,
  CASE INCIDENT_TYPE
    WHEN 'flooding' THEN 'Heavy Rain'
    WHEN 'weather' THEN 'Heavy Rain'
    ELSE NULL
  END AS WEATHER_CONDITION,
  DATEADD('minute', DELAY_MINUTES, DATEADD('minute', UNIFORM(5, 30, RANDOM()), ORDER_TIME)) AS RESOLVED_TIME,
  CITY
FROM (
  SELECT * FROM flood_affected
  UNION ALL SELECT * FROM weather_affected
  UNION ALL SELECT * FROM traffic_affected
)`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_INCIDENTS`);
        updateStep('incidents', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[9].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('incidents', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

      // Step 11: Customer Calls (complaints about delays)
      updateStep('calls', { status: 'running', message: 'Generating customer calls...', started_at: Date.now() });
      try {
        await snowSql(`INSERT OVERWRITE INTO ${DB}.DATA.CUSTOMER_CALLS
WITH incident_orders AS (
  SELECT i.INCIDENT_ID, i.ORDER_ID, i.COURIER_ID, i.INCIDENT_TYPE, i.INCIDENT_TIME,
    i.DELAY_MINUTES, i.DESCRIPTION AS INC_DESC, i.RELATED_FLOOD_ID, i.CITY,
    d.RESTAURANT_NAME, d.CUSTOMER_ADDRESS
  FROM ${DB}.DATA.DELIVERY_INCIDENTS i
  JOIN ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES d ON i.ORDER_ID = d.ORDER_ID
),
first_names AS (
  SELECT column1 AS fname, ROW_NUMBER() OVER (ORDER BY column1) - 1 AS fn_idx FROM VALUES
  ('Emma'),('James'),('Sarah'),('Michael'),('Lisa'),('David'),('Anna'),('Robert'),
  ('Kate'),('John'),('Maria'),('Tom'),('Sophie'),('Chris'),('Rachel'),('Alex'),
  ('Olivia'),('Daniel'),('Jessica'),('Ben'),('Lucy'),('Sam'),('Claire'),('Mark'),
  ('Amy'),('Paul'),('Nina'),('Harry'),('Zoe'),('Jack')
),
last_names AS (
  SELECT column1 AS lname, ROW_NUMBER() OVER (ORDER BY column1) - 1 AS ln_idx FROM VALUES
  ('Smith'),('Johnson'),('Williams'),('Brown'),('Jones'),('Garcia'),('Miller'),
  ('Davis'),('Rodriguez'),('Martinez'),('Anderson'),('Thomas'),('Jackson'),('White'),
  ('Harris'),('Martin'),('Thompson'),('Moore'),('Allen'),('Young')
),
call_templates AS (
  SELECT io.*,
    UNIFORM(1, 100, RANDOM()) AS call_roll,
    MOD(ABS(HASH(io.ORDER_ID || 'fn')), 30) AS fname_idx,
    MOD(ABS(HASH(io.ORDER_ID || 'ln')), 20) AS lname_idx
  FROM incident_orders io
  WHERE UNIFORM(1, 100, RANDOM()) <= 70
)
SELECT
  MD5(ct.ORDER_ID || 'CALL' || RANDOM()) AS CALL_ID,
  ct.ORDER_ID,
  DATEADD('minute', UNIFORM(5, 60, RANDOM())::INT, ct.INCIDENT_TIME) AS CALL_TIME,
  fn.fname || ' ' || ln.lname AS CUSTOMER_NAME,
  CASE
    WHEN ct.INCIDENT_TYPE = 'flooding' THEN UNIFORM(120, 360, RANDOM())
    WHEN ct.INCIDENT_TYPE = 'weather' THEN UNIFORM(90, 240, RANDOM())
    ELSE UNIFORM(60, 180, RANDOM())
  END AS CALL_DURATION_SECS,
  CASE
    WHEN ct.call_roll <= 75 THEN 'complaint'
    WHEN ct.call_roll <= 90 THEN 'enquiry'
    ELSE 'cancellation'
  END AS CALL_TYPE,
  CASE
    WHEN ct.INCIDENT_TYPE = 'flooding' AND ct.call_roll <= 30 THEN 'angry'
    WHEN ct.INCIDENT_TYPE = 'flooding' THEN 'frustrated'
    WHEN ct.INCIDENT_TYPE = 'weather' AND ct.call_roll <= 20 THEN 'angry'
    WHEN ct.INCIDENT_TYPE = 'weather' THEN 'frustrated'
    WHEN ct.call_roll <= 15 THEN 'angry'
    WHEN ct.call_roll <= 50 THEN 'frustrated'
    WHEN ct.call_roll <= 80 THEN 'neutral'
    ELSE 'understanding'
  END AS SENTIMENT,
  CASE ct.INCIDENT_TYPE
    WHEN 'flooding' THEN 'flood delay'
    WHEN 'weather' THEN 'weather delay'
    ELSE 'late delivery'
  END AS ISSUE_CATEGORY,
  CASE ct.INCIDENT_TYPE
    WHEN 'flooding' THEN
      CASE UNIFORM(1,4,RANDOM())
        WHEN 1 THEN 'My order from ' || ct.RESTAURANT_NAME || ' is very late. The driver says the road is flooded and they cannot get through.'
        WHEN 2 THEN 'I have been waiting over an hour. Apparently there is flooding near my area. When will my food arrive?'
        WHEN 3 THEN 'The courier called to say they are stuck due to flooding. This is unacceptable. I want a refund.'
        ELSE 'My delivery is delayed because of flooding. Can you give me an update on when it will arrive?'
      END
    WHEN 'weather' THEN
      CASE UNIFORM(1,4,RANDOM())
        WHEN 1 THEN 'My order is late. I understand the weather is bad but I placed this order an hour ago.'
        WHEN 2 THEN 'The delivery is taking much longer than expected. Is it because of the rain?'
        WHEN 3 THEN 'Hi, just checking on my order from ' || ct.RESTAURANT_NAME || '. The app says it is delayed due to weather.'
        ELSE 'My food is going to be cold by the time it arrives. The rain has caused major delays apparently.'
      END
    ELSE
      CASE UNIFORM(1,4,RANDOM())
        WHEN 1 THEN 'My order from ' || ct.RESTAURANT_NAME || ' was supposed to arrive 20 minutes ago. Where is my courier?'
        WHEN 2 THEN 'The delivery is running late. The app showed 15 minutes but it has been 30 already.'
        WHEN 3 THEN 'Can I get an update on my order? It seems to be stuck in traffic somewhere.'
        ELSE 'Hi, my delivery is delayed. The tracker shows the courier has not moved in a while.'
      END
  END AS CALL_NOTES,
  CASE
    WHEN ct.call_roll <= 10 THEN 'refund issued'
    WHEN ct.call_roll <= 30 THEN 'discount offered'
    WHEN ct.call_roll <= 60 THEN 'apology and ETA provided'
    WHEN ct.call_roll <= 85 THEN 'customer informed of situation'
    ELSE 'order cancelled and refunded'
  END AS RESOLUTION,
  ct.INCIDENT_ID AS RELATED_INCIDENT_ID,
  ct.CITY
FROM call_templates ct
JOIN first_names fn ON ct.fname_idx = fn.fn_idx
JOIN last_names ln ON ct.lname_idx = ln.ln_idx`);
        const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.CUSTOMER_CALLS`);
        updateStep('calls', { status: 'complete', rows: Number(rc[0]?.CNT || 0), elapsed_seconds: (Date.now() - (dataBuildState.steps[10].started_at || Date.now())) / 1000 });
      } catch (err: any) { updateStep('calls', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    } catch (err: any) {
      console.error('Data build pipeline error:', err.message);
    } finally {
      dataBuildState.running = false;
    }
  })();
});

const DATA_BUILD_STEPS = [
  { id: 'restaurants', label: 'Load Restaurants' },
  { id: 'addresses', label: 'Load Addresses' },
  { id: 'couriers', label: 'Create Couriers' },
  { id: 'orders', label: 'Generate Orders' },
  { id: 'routes', label: 'Generate ORS Routes' },
  { id: 'geometries', label: 'Parse Routes & Geometries' },
  { id: 'locations', label: 'Interpolate Courier Locations' },
  { id: 'weather', label: 'Generate Weather Data' },
  { id: 'floods', label: 'Generate Flood Events' },
  { id: 'incidents', label: 'Generate Delivery Incidents' },
  { id: 'calls', label: 'Generate Customer Calls' },
];

function getCityProvisionState(city: string) {
  if (!cityProvisionStates[city]) {
    cityProvisionStates[city] = { status: 'idle', orsRegion: getOrsRegion(city) };
  }
  return cityProvisionStates[city];
}

function updateCityState(city: string, update: any) {
  if (!cityProvisionStates[city]) {
    cityProvisionStates[city] = { status: 'idle', orsRegion: getOrsRegion(city) };
  }
  Object.assign(cityProvisionStates[city], update);
}

function updateCityDataStep(city: string, step: string, update: any) {
  const state = getCityProvisionState(city);
  if (!state.dataSteps) return;
  const s = state.dataSteps.find((x: any) => x.step === step);
  if (s) Object.assign(s, update);
}

async function checkOrsRegionReady(region: string) {
  const svcName = `ORS_SERVICE_${region.toUpperCase()}`;
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
    const fnName = `DIRECTIONS_${region.toUpperCase()}`;
    const rows = await snowSql(`SHOW FUNCTIONS LIKE '${fnName}' IN SCHEMA ${SF_DATABASE}.ROUTING`);
    functionExists = rows.length > 0;
  } catch {}
  return { serviceExists, serviceStatus, pbfExists, functionExists };
}

async function putFileToStageSpcs(fileContent: string, stagePath: string, fileName: string): Promise<void> {
  const escapedContent = fileContent.replace(/'/g, "''").replace(/\\/g, '\\\\');
  await snowSql(`COPY INTO ${stagePath}/${fileName} FROM (SELECT '${escapedContent}') FILE_FORMAT=(TYPE='CSV' COMPRESSION=NONE FIELD_OPTIONALLY_ENCLOSED_BY=NONE FIELD_DELIMITER=NONE RECORD_DELIMITER=NONE) OVERWRITE=TRUE SINGLE=TRUE HEADER=FALSE`);
}

async function putFileToStageLocal(filePath: string, stagePath: string): Promise<void> {
  await execAsync(`snow sql -c ${CONN} -q "PUT 'file://${filePath}' ${stagePath} AUTO_COMPRESS=FALSE OVERWRITE=TRUE" 2>/dev/null`);
}

async function uploadToStage(fileContent: string, stagePath: string, fileName: string): Promise<void> {
  if (IS_SPCS) {
    await putFileToStageSpcs(fileContent, stagePath, fileName);
  } else {
    const tmpDir = join(tmpdir(), `stage_upload_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, fileName);
    writeFileSync(tmpFile, fileContent);
    try {
      await putFileToStageLocal(tmpFile, stagePath);
    } finally {
      try { unlinkSync(tmpFile); rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
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
    if (provisionState.status === 'complete' && !hasData) {
      provisionState.status = 'idle';
      provisionState.message = undefined;
      provisionState.dataSteps = undefined;
    }
    let downloaderReady = false;
    try {
      const rows = await snowSql(`SHOW FUNCTIONS LIKE 'DOWNLOAD_PBF' IN SCHEMA ${SF_DATABASE}.ROUTING`);
      downloaderReady = rows.length > 0;
    } catch {}
    res.json({
      city, region,
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
  const svcName = `ORS_SERVICE_${region.toUpperCase()}`;
  const stageDir = region;
  const existing = await checkOrsRegionReady(region);
  if (existing.serviceStatus === 'RUNNING' && existing.functionExists) return;

  if (!existing.pbfExists) {
    const pbfUrl = regionCfg.pbfUrl;
    const targetName = `${region}.osm.pbf`;
    try { await snowSql(`CALL ${DB}.ROUTING.CREATE_STAGES()`); } catch (e: any) {
      console.log('create_stages call info:', e.message?.slice(0, 200));
    }
    let downloaderReady = false;
    try {
      const rows = await snowSql(`SHOW FUNCTIONS LIKE 'DOWNLOAD_PBF' IN SCHEMA ${DB}.ROUTING`);
      downloaderReady = rows.length > 0;
    } catch {}
    if (!downloaderReady) {
      try {
        await snowSql(`CALL ${DB}.ROUTING.CREATE_ROUTING_POOL()`);
      } catch (e: any) {
        console.log('create_routing_pool info:', e.message?.slice(0, 200));
      }
      for (let p = 0; p < 30; p++) {
        try {
          const pools = await snowSql(`DESCRIBE COMPUTE POOL ${DB}_ROUTING_POOL`);
          const pool = pools[0];
          const st = pool?.state || pool?.STATE || '';
          if (st === 'ACTIVE' || st === 'IDLE') break;
        } catch {}
        await new Promise((r) => setTimeout(r, 10000));
      }
      try {
        await snowSql(`CALL ${DB}.ROUTING.START_DOWNLOADER()`);
        for (let d = 0; d < 30; d++) {
          try {
            const rows = await snowSql(`SHOW FUNCTIONS LIKE 'DOWNLOAD_PBF' IN SCHEMA ${DB}.ROUTING`);
            if (rows.length > 0) { downloaderReady = true; break; }
          } catch {}
          await new Promise((r) => setTimeout(r, 10000));
        }
      } catch (e: any) {
        console.log('start_downloader failed (EAI may not be granted):', e.message?.slice(0, 200));
      }
    }
    if (downloaderReady) {
      try {
        await snowSql(`SELECT ${DB}.ROUTING.DOWNLOAD_PBF('ors_spcs_stage/${stageDir}', '${targetName}', '${pbfUrl}')`);
      } catch (e: any) {
        console.log('DOWNLOAD_PBF failed, trying local download+PUT fallback:', e.message?.slice(0, 200));
        if (!IS_SPCS) {
          await downloadPbfLocally(pbfUrl, targetName, stageDir, DB);
        } else {
          throw new Error(`PBF download failed in SPCS and no local fallback available: ${e.message?.slice(0, 200)}`);
        }
      }
    } else {
      if (!IS_SPCS) {
        await downloadPbfLocally(pbfUrl, targetName, stageDir, DB);
      } else {
        throw new Error('Cannot download PBF: DOWNLOAD_PBF function not available and no local fallback in SPCS');
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
      cycling-electric:
        enabled: true
  endpoints:
    matrix:
      maximum_visited_nodes: 100000000
      maximum_routes: 250000`;

    await uploadToStage(orsConfigYaml, `@${DB}.ROUTING.ORS_SPCS_STAGE/${stageDir}`, 'ors-config.yml');
  }

  if (!existing.serviceExists || existing.serviceStatus === 'SUSPENDED') {
    await snowSql(`CALL ${DB}.ROUTING.CREATE_CITY_ORS_SERVICE('${region}')`);
    try {
      await snowSql(`CALL ${DB}.ROUTING.CREATE_SERVICES()`);
    } catch (e: any) {
      console.log('create_services for shared gateway info:', e.message?.slice(0, 200));
    }
  }

  const servicesToWait = [svcName, 'ROUTING_GATEWAY_SERVICE'];
  for (const waitSvc of servicesToWait) {
    for (let i = 0; i < 60; i++) {
      try {
        const rows = await snowSql(`SHOW SERVICES LIKE '${waitSvc}' IN SCHEMA ${DB}.ROUTING`);
        const row = rows.find((r: any) => (r.name || r.NAME) === waitSvc);
        if (row && (row.status || row.STATUS) === 'RUNNING') break;
      } catch {}
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  if (!existing.functionExists) {
    await snowSql(`CALL ${DB}.ROUTING.CREATE_CITY_FUNCTIONS('${region}')`);
  }

  await waitForOrsGraphReady(region);
}

async function waitForOrsGraphReady(region: string, maxAttempts = 60, intervalMs = 15000): Promise<void> {
  const DB = SF_DATABASE;
  const fnName = `${DB}.ROUTING.DIRECTIONS_${region.toUpperCase()}`;
  const regionCfg = ORS_REGION_CONFIG[region];
  const cities = regionCfg?.cities || [];
  const cityConfig = cities.length > 0 ? CITY_ORS_MAP[cities[0]] : null;
  const testLat = cityConfig ? (cityConfig.bbox.minLat + cityConfig.bbox.maxLat) / 2 : 37.76;
  const testLon = cityConfig ? (cityConfig.bbox.minLon + cityConfig.bbox.maxLon) / 2 : -122.44;
  const offsetLat = testLat + 0.005;
  const offsetLon = testLon + 0.005;

  console.log(`Waiting for ORS graph to be ready for ${region} (testing ${fnName})...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const rows = await snowSql(
        `SELECT ${fnName}('cycling-electric', ARRAY_CONSTRUCT(${testLon}, ${testLat}), ARRAY_CONSTRUCT(${offsetLon}, ${offsetLat})) AS RESULT`
      );
      const result = rows[0]?.RESULT;
      if (result && !JSON.stringify(result).includes('"error"')) {
        console.log(`ORS graph ready for ${region} after ${attempt} attempt(s)`);
        return;
      }
      const errMsg = typeof result === 'string' ? result : JSON.stringify(result);
      console.log(`ORS graph not ready for ${region} (attempt ${attempt}/${maxAttempts}): ${errMsg?.slice(0, 200)}`);
    } catch (e: any) {
      console.log(`ORS graph check failed for ${region} (attempt ${attempt}/${maxAttempts}): ${e.message?.slice(0, 200)}`);
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`ORS graph for ${region} did not become ready after ${maxAttempts} attempts (${Math.round(maxAttempts * intervalMs / 60000)} minutes)`);
}

async function downloadPbfLocally(pbfUrl: string, targetName: string, stageDir: string, db: string): Promise<void> {
  if (IS_SPCS) {
    throw new Error(`Cannot download PBF locally in SPCS. Use DOWNLOAD_PBF function or ensure downloader service is running.`);
  }
  const tmpPbfDir = join(tmpdir(), `pbf_stage_${Date.now()}`);
  mkdirSync(tmpPbfDir, { recursive: true });
  const tmpPbf = join(tmpPbfDir, targetName);
  try {
    console.log(`Downloading PBF locally: ${pbfUrl}`);
    await execAsync(`curl -L -o "${tmpPbf}" "${pbfUrl}"`, { timeout: 600000 });
    console.log(`Uploading PBF to stage: @${db}.ROUTING.ORS_SPCS_STAGE/${stageDir}/`);
    await putFileToStageLocal(tmpPbf, `@${db}.ROUTING.ORS_SPCS_STAGE/${stageDir}/`);
    console.log('PBF uploaded successfully');
  } catch (e: any) {
    throw new Error(`Failed to download/upload PBF for ${stageDir}: ${e.message?.slice(0, 300)}`);
  } finally {
    try { unlinkSync(tmpPbf); rmSync(tmpPbfDir, { recursive: true, force: true }); } catch {}
  }
}

function getDirectionsFn(city: string): string {
  const region = getOrsRegion(city);
  return `${SF_DATABASE}.ROUTING.DIRECTIONS_${region.toUpperCase()}`;
}

app.post('/api/city/:city/provision', async (req, res) => {
  const city = decodeURIComponent(req.params.city);
  const config = CITY_ORS_MAP[city];
  if (!config) return res.status(404).json({ error: `Unknown city: ${city}` });
  const today = new Date().toISOString().slice(0, 10);
  const { num_couriers = 50, num_days = 1, start_date = today, shifts, vehicle_type = 'cycling-electric' } = req.body || {};
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
      } else {
        orsPromise = provisionOrsForRegion(region).catch((e: any) => {
          throw new Error(`ORS provisioning failed: ${e.message?.slice(0, 400)}`);
        });
      }
      await runCityDataBuild(city, { num_couriers, num_days, start_date, shifts, vehicle_type, orsPromise });
      updateCityState(city, { status: 'complete', message: `Data build complete for ${city}` });
    } catch (err: any) {
      updateCityState(city, { status: 'error', error: err.message?.slice(0, 500), message: 'Build failed' });
    }
  })();
});

async function runCityDataBuild(city: string, opts: { num_couriers: number; num_days: number; start_date: string; shifts?: any; vehicle_type?: string; orsPromise?: Promise<void> | null }) {
  const jobKey = `city_${city}`;
  cancelledJobs.delete(jobKey);
  const DB = SF_DATABASE;
  const { num_couriers, num_days, start_date } = opts;
  const vehicleType = mapOrsProfile(opts.vehicle_type || 'cycling-electric');
  const cityList = `'${city.replace(/'/g, "''")}'`;
  const routingFn = getDirectionsFn(city);
  const cityConfig = CITY_ORS_MAP[city];
  const cityCountry = cityConfig?.country || 'US';
  const cityBbox = cityConfig?.bbox || { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 };
  const shifts = opts.shifts || {
    breakfast: Math.round(num_couriers * 0.1),
    lunch: Math.round(num_couriers * 0.3),
    afternoon: Math.round(num_couriers * 0.16),
    dinner: Math.round(num_couriers * 0.34),
    late_night: Math.round(num_couriers * 0.1),
  };
  const steps = DATA_BUILD_STEPS.map((s) => ({ step: s.id, status: 'idle' }));
  updateCityState(city, { status: 'building_data', dataSteps: steps });
  function updateStep(step: string, update: any) { updateCityDataStep(city, step, update); }
  function checkCancelled() { if (cancelledJobs.has(jobKey)) throw new Error('Build cancelled by user'); }

  try {
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
      updateStep('restaurants', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('restaurants', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    checkCancelled();
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
FROM (SELECT * FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
WHERE ST_Y(GEOMETRY) BETWEEN ${cityBbox.minLat} AND ${cityBbox.maxLat}
  AND ST_X(GEOMETRY) BETWEEN ${cityBbox.minLon} AND ${cityBbox.maxLon}
  AND NAMES:primary IS NOT NULL) SAMPLE (50000 ROWS)`);
      } else {
        await snowSql(`INSERT INTO ${DB}.DATA.CUSTOMER_ADDRESSES
SELECT ID AS ADDRESS_ID, GEOMETRY AS LOCATION,
  COALESCE(ADDRESS_LEVELS[0]:value::STRING || ' ' || STREET, STREET) AS FULL_ADDRESS,
  STREET, POSTCODE,
  ADDRESS_LEVELS[0]:value::STRING AS STATE,
  '${city.replace(/'/g, "''")}' AS CITY
FROM (SELECT * FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS
WHERE ${getGeohashFilter(city)}
  AND ST_Y(GEOMETRY) BETWEEN ${cityBbox.minLat} AND ${cityBbox.maxLat}
  AND ST_X(GEOMETRY) BETWEEN ${cityBbox.minLon} AND ${cityBbox.maxLon}
  AND STREET IS NOT NULL) SAMPLE (50000 ROWS)`);
      }
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE CITY IN (${cityList})`);
      updateStep('addresses', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('addresses', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    checkCancelled();
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
  'cycling-electric' AS VEHICLE_TYPE
FROM courier_assignments ca LEFT JOIN home_locations hl ON ca.courier_num = hl.rn`);
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.COURIERS WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      updateStep('couriers', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('couriers', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    checkCancelled();
    updateStep('orders', { status: 'running', message: 'Generating delivery orders...', started_at: Date.now() });
    try {
      const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
      await snowSql(`DELETE FROM ${DB}.DATA.RESTAURANTS_NUMBERED WHERE 1=1`);
      await snowSql(`INSERT INTO ${DB}.DATA.RESTAURANTS_NUMBERED
SELECT RESTAURANT_ID, LOCATION, NAME, CUISINE_TYPE, ADDRESS,
  ROW_NUMBER() OVER (ORDER BY HASH(RESTAURANT_ID)) AS RN
FROM ${DB}.DATA.RESTAURANTS WHERE NAME IS NOT NULL AND LENGTH(NAME) > 2 AND CITY IN (${cityList})`);
      await snowSql(`DELETE FROM ${DB}.DATA.ADDRESSES_NUMBERED WHERE 1=1`);
      await snowSql(`INSERT INTO ${DB}.DATA.ADDRESSES_NUMBERED
SELECT ADDRESS_ID, LOCATION, FULL_ADDRESS,
  ROW_NUMBER() OVER (ORDER BY HASH(ADDRESS_ID)) AS RN
FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE FULL_ADDRESS IS NOT NULL AND LENGTH(FULL_ADDRESS) > 3 AND CITY IN (${cityList})`);
      await snowSql(`DELETE FROM ${DB}.DATA.DELIVERY_ORDERS WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      await snowSql(`INSERT INTO ${DB}.DATA.DELIVERY_ORDERS
WITH courier_order_counts AS (
  SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR,
    c.SHIFT_CROSSES_MIDNIGHT, c.VEHICLE_TYPE,
    CASE c.SHIFT_TYPE WHEN 'Lunch' THEN UNIFORM(25,35,RANDOM()) WHEN 'Dinner' THEN UNIFORM(25,35,RANDOM())
      WHEN 'Breakfast' THEN UNIFORM(15,25,RANDOM()) WHEN 'Afternoon' THEN UNIFORM(18,28,RANDOM())
      WHEN 'Late Night' THEN UNIFORM(10,18,RANDOM()) END AS NUM_ORDERS
  FROM ${DB}.DATA.COURIERS c WHERE c.COURIER_ID LIKE '${cityPrefix}-%'
),
order_sequence AS (
  SELECT c.COURIER_ID, c.SHIFT_TYPE, c.SHIFT_START_HOUR, c.SHIFT_END_HOUR, c.SHIFT_CROSSES_MIDNIGHT,
    c.VEHICLE_TYPE, c.NUM_ORDERS, ROW_NUMBER() OVER (PARTITION BY c.COURIER_ID ORDER BY RANDOM()) AS ORDER_NUMBER
  FROM courier_order_counts c CROSS JOIN TABLE(GENERATOR(ROWCOUNT => 40)) g
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
  UNIFORM(3,15,RANDOM()) AS PREP_TIME_MINS,
  CASE WHEN UNIFORM(1,100,RANDOM())<=70 THEN 'delivered' WHEN UNIFORM(1,100,RANDOM())<=85 THEN 'in_transit' ELSE 'picked_up' END AS ORDER_STATUS
FROM orders_with_hours o CROSS JOIN rest_count rc CROSS JOIN addr_count ac`);
      await snowSql(`DELETE FROM ${DB}.DATA.ORDERS_WITH_LOCATIONS WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      await snowSql(`INSERT INTO ${DB}.DATA.ORDERS_WITH_LOCATIONS
SELECT o.ORDER_ID, o.COURIER_ID, o.ORDER_HOUR, o.ORDER_NUMBER, o.SHIFT_TYPE, o.VEHICLE_TYPE,
  r.RESTAURANT_ID, r.NAME AS RESTAURANT_NAME, r.CUISINE_TYPE, r.LOCATION AS RESTAURANT_LOCATION,
  r.ADDRESS AS RESTAURANT_ADDRESS, a.ADDRESS_ID AS CUSTOMER_ADDRESS_ID, a.FULL_ADDRESS AS CUSTOMER_ADDRESS,
  a.LOCATION AS CUSTOMER_LOCATION, o.PREP_TIME_MINS, o.ORDER_STATUS
FROM ${DB}.DATA.DELIVERY_ORDERS o
JOIN ${DB}.DATA.RESTAURANTS_NUMBERED r ON o.RESTAURANT_IDX = r.RN
JOIN ${DB}.DATA.ADDRESSES_NUMBERED a ON o.CUSTOMER_IDX = a.RN
WHERE o.COURIER_ID LIKE '${cityPrefix}-%'`);
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ORDERS WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      updateStep('orders', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('orders', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    if (opts.orsPromise) {
    checkCancelled();
      updateStep('routes', { status: 'waiting_for_ors', message: 'Waiting for ORS routing service to be ready...', started_at: Date.now() });
      await opts.orsPromise;
    }

    updateStep('routes', { status: 'waiting_for_graph', message: 'Verifying ORS routing graph is loaded...', started_at: Date.now() });
    const region = getOrsRegion(city);
    await waitForOrsGraphReady(region);

    updateStep('routes', { status: 'running', message: 'Generating routes via OpenRouteService (this may take several minutes)...', started_at: Date.now() });
    try {
      const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
      await snowSql(`DELETE FROM ${DB}.DATA.DELIVERY_ROUTES WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      await snowSql(`INSERT INTO ${DB}.DATA.DELIVERY_ROUTES
SELECT COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
  RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
  CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
  ${routingFn}(
    '${vehicleType.replace(/'/g, "''")}',
    ARRAY_CONSTRUCT(ST_X(RESTAURANT_LOCATION), ST_Y(RESTAURANT_LOCATION)),
    ARRAY_CONSTRUCT(ST_X(CUSTOMER_LOCATION), ST_Y(CUSTOMER_LOCATION))
  ) AS ROUTE_RESPONSE
FROM ${DB}.DATA.ORDERS_WITH_LOCATIONS
WHERE COURIER_ID LIKE '${cityPrefix}-%'`, 1800, jobKey);
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ROUTES WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      updateStep('routes', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('routes', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    checkCancelled();
    updateStep('geometries', { status: 'running', message: 'Parsing routes and computing geometries...', started_at: Date.now() });
    try {
      const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
      const sd = start_date;
      await snowSql(`DELETE FROM ${DB}.DATA.DELIVERY_ROUTES_PARSED WHERE COURIER_ID LIKE '${cityPrefix}-%'`);
      await snowSql(`INSERT INTO ${DB}.DATA.DELIVERY_ROUTES_PARSED
SELECT COURIER_ID, ORDER_ID, ORDER_HOUR, ORDER_NUMBER, SHIFT_TYPE, VEHICLE_TYPE,
  RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, RESTAURANT_LOCATION, RESTAURANT_ADDRESS,
  CUSTOMER_ADDRESS_ID, CUSTOMER_ADDRESS, CUSTOMER_LOCATION, PREP_TIME_MINS, ORDER_STATUS,
  TRY_TO_GEOGRAPHY(PARSE_JSON(ROUTE_RESPONSE):features[0]:geometry) AS ROUTE_GEOMETRY,
  PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:distance::FLOAT AS ROUTE_DISTANCE_METERS,
  PARSE_JSON(ROUTE_RESPONSE):features[0]:properties:summary:duration::FLOAT AS ROUTE_DURATION_SECS
FROM ${DB}.DATA.DELIVERY_ROUTES
WHERE ROUTE_RESPONSE IS NOT NULL AND COURIER_ID LIKE '${cityPrefix}-%'`);

      await snowSql(`DELETE FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE CITY IN (${cityList})`);
      await snowSql(`INSERT INTO ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES
WITH order_timing AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY COURIER_ID ORDER BY ORDER_HOUR, ORDER_NUMBER) AS COURIER_ORDER_SEQ
  FROM ${DB}.DATA.DELIVERY_ROUTES_PARSED
  WHERE ROUTE_GEOMETRY IS NOT NULL AND COURIER_ID LIKE '${cityPrefix}-%'
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
  '${city.replace(/'/g, "''")}' AS CITY
FROM cumulative_timing`);
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE CITY IN (${cityList})`);
      updateStep('geometries', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('geometries', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    checkCancelled();
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
FROM expanded`, 1200);
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.COURIER_LOCATIONS WHERE CITY IN (${cityList})`);
      updateStep('locations', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('locations', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    // Step 8: Weather Observations
    checkCancelled();
    updateStep('weather', { status: 'running', message: 'Generating weather observations...', started_at: Date.now() });
    try {
      const weatherStations: Record<string, { name: string; lat: number; lon: number }[]> = {
        'San Francisco': [
          { name: 'SF Downtown', lat: 37.7749, lon: -122.4194 },
          { name: 'SF Mission District', lat: 37.7599, lon: -122.4148 },
          { name: 'SF Marina', lat: 37.8015, lon: -122.4368 },
          { name: 'SF Sunset', lat: 37.7525, lon: -122.4949 },
          { name: 'SF SoMa', lat: 37.7785, lon: -122.3950 },
          { name: 'SF Richmond', lat: 37.7799, lon: -122.4644 },
          { name: 'SF Bayview', lat: 37.7296, lon: -122.3876 },
          { name: 'SF North Beach', lat: 37.8061, lon: -122.4103 },
        ],
        'London': [
          { name: 'London City', lat: 51.5074, lon: -0.1278 },
          { name: 'London Heathrow', lat: 51.4700, lon: -0.4543 },
          { name: 'London Greenwich', lat: 51.4769, lon: -0.0005 },
          { name: 'London Kensington', lat: 51.4988, lon: -0.1749 },
          { name: 'London Camden', lat: 51.5390, lon: -0.1426 },
          { name: 'London Canary Wharf', lat: 51.5054, lon: -0.0235 },
        ],
        'Paris': [
          { name: 'Paris Centre', lat: 48.8566, lon: 2.3522 },
          { name: 'Paris Orly', lat: 48.7262, lon: 2.3652 },
          { name: 'Paris Montmartre', lat: 48.8867, lon: 2.3431 },
          { name: 'Paris La Defense', lat: 48.8924, lon: 2.2360 },
        ],
      };
      const stationsForCity = weatherStations[city] || weatherStations['San Francisco'];
      const stationUnions = stationsForCity.map(s =>
        `SELECT '${s.name.replace(/'/g, "''")}' AS station_name, ST_MAKEPOINT(${s.lon}, ${s.lat}) AS station_location`
      ).join(' UNION ALL\n  ');
      const safeCity = city.replace(/'/g, "''");

      await snowSql(`DELETE FROM ${DB}.DATA.WEATHER_OBSERVATIONS WHERE CITY IN (${cityList})`);
      await snowSql(`DELETE FROM ${DB}.DATA.WEATHER_FORECASTS WHERE CITY IN (${cityList})`);
      await snowSql(`INSERT INTO ${DB}.DATA.WEATHER_OBSERVATIONS
WITH date_range AS (
  SELECT DATEADD('day', -SEQ4(), '${start_date}'::DATE) AS obs_date
  FROM TABLE(GENERATOR(ROWCOUNT => ${num_days}))
),
hours AS (
  SELECT SEQ4() AS obs_hour FROM TABLE(GENERATOR(ROWCOUNT => 24))
),
stations AS (
  ${stationUnions}
),
base_weather AS (
  SELECT
    d.obs_date, h.obs_hour, s.station_name, s.station_location,
    d.obs_date = (SELECT MAX(obs_date) FROM date_range) AS is_last_day,
    UNIFORM(1, 100, RANDOM()) AS weather_roll,
    UNIFORM(1, 100, RANDOM()) AS severity_roll
  FROM date_range d CROSS JOIN hours h CROSS JOIN stations s
)
SELECT
  MD5(station_name || obs_date || obs_hour || RANDOM()) AS OBSERVATION_ID,
  DATEADD('hour', obs_hour, obs_date::TIMESTAMP_NTZ) AS OBSERVATION_TIME,
  station_name AS STATION_NAME, station_location AS STATION_LOCATION,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN ROUND(UNIFORM(8, 14, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
    WHEN obs_hour BETWEEN 0 AND 6 THEN ROUND(UNIFORM(5, 10, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
    WHEN obs_hour BETWEEN 7 AND 11 THEN ROUND(UNIFORM(10, 16, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
    WHEN obs_hour BETWEEN 12 AND 17 THEN ROUND(UNIFORM(14, 22, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
    ELSE ROUND(UNIFORM(8, 15, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1)
  END AS TEMPERATURE_C,
  CASE WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN ROUND(UNIFORM(4, 10, RANDOM())::FLOAT, 1) ELSE ROUND(UNIFORM(6, 18, RANDOM())::FLOAT, 1) END AS FEELS_LIKE_C,
  CASE WHEN is_last_day AND obs_hour BETWEEN 11 AND 15 THEN ROUND(UNIFORM(25, 45, RANDOM())::FLOAT, 1) ELSE ROUND(UNIFORM(3, 20, RANDOM())::FLOAT, 1) END AS WIND_SPEED_MPH,
  CASE WHEN is_last_day AND obs_hour BETWEEN 11 AND 15 THEN ROUND(UNIFORM(35, 60, RANDOM())::FLOAT, 1) ELSE ROUND(UNIFORM(5, 30, RANDOM())::FLOAT, 1) END AS WIND_GUST_MPH,
  CASE UNIFORM(1,8,RANDOM()) WHEN 1 THEN 'N' WHEN 2 THEN 'NE' WHEN 3 THEN 'E' WHEN 4 THEN 'SE' WHEN 5 THEN 'S' WHEN 6 THEN 'SW' WHEN 7 THEN 'W' ELSE 'NW' END AS WIND_DIRECTION,
  CASE WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN ROUND(UNIFORM(85, 98, RANDOM())::FLOAT, 1) ELSE ROUND(UNIFORM(40, 80, RANDOM())::FLOAT, 1) END AS HUMIDITY_PCT,
  ROUND(UNIFORM(1005, 1025, RANDOM())::FLOAT - CASE WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN 20 ELSE 0 END, 1) AS PRESSURE_HPA,
  CASE WHEN is_last_day AND obs_hour BETWEEN 11 AND 15 THEN ROUND(UNIFORM(0.5, 3, RANDOM())::FLOAT, 1) ELSE ROUND(UNIFORM(5, 30, RANDOM())::FLOAT, 1) END AS VISIBILITY_KM,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 11 AND 15 THEN ROUND(UNIFORM(8, 25, RANDOM())::FLOAT, 1)
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN ROUND(UNIFORM(3, 12, RANDOM())::FLOAT, 1)
    WHEN weather_roll <= 30 THEN ROUND(UNIFORM(0.1, 2, RANDOM())::FLOAT, 1)
    ELSE 0
  END AS PRECIPITATION_MM,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 12 AND 14 THEN 'Thunderstorm'
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN 'Heavy Rain'
    WHEN is_last_day AND obs_hour IN (9, 17) THEN 'Light Rain'
    WHEN weather_roll <= 15 THEN 'Heavy Rain'
    WHEN weather_roll <= 35 THEN 'Light Rain'
    WHEN weather_roll <= 50 THEN 'Overcast'
    WHEN weather_roll <= 70 THEN 'Cloudy'
    WHEN weather_roll <= 85 THEN 'Partly Cloudy'
    ELSE 'Clear'
  END AS WEATHER_CONDITION,
  CASE
    WHEN is_last_day AND obs_hour BETWEEN 12 AND 14 THEN 'severe'
    WHEN is_last_day AND obs_hour BETWEEN 10 AND 16 THEN 'warning'
    WHEN is_last_day AND obs_hour IN (9, 17) THEN 'advisory'
    WHEN weather_roll <= 15 THEN 'advisory'
    ELSE 'normal'
  END AS WEATHER_SEVERITY,
  CASE WHEN obs_hour BETWEEN 10 AND 16 THEN UNIFORM(1, 6, RANDOM()) ELSE 0 END AS UV_INDEX,
  '${safeCity}' AS CITY
FROM base_weather`);

      try {
        const lastDate = `'${start_date}'::DATE`;
        await snowSql(`INSERT INTO ${DB}.DATA.WEATHER_FORECASTS
WITH forecast_days AS (
  SELECT DATEADD('day', SEQ4() + 1, ${lastDate}) AS forecast_date
  FROM TABLE(GENERATOR(ROWCOUNT => 3))
),
hours AS (SELECT SEQ4() * 3 AS fc_hour FROM TABLE(GENERATOR(ROWCOUNT => 8))),
stations AS (
  SELECT DISTINCT STATION_NAME, STATION_LOCATION FROM ${DB}.DATA.WEATHER_OBSERVATIONS WHERE CITY IN (${cityList}) LIMIT 8
)
SELECT
  MD5(s.STATION_NAME || d.forecast_date || h.fc_hour || RANDOM()) AS FORECAST_ID,
  ${lastDate}::TIMESTAMP_NTZ AS ISSUED_AT,
  DATEADD('hour', h.fc_hour, d.forecast_date::TIMESTAMP_NTZ) AS FORECAST_TIME,
  s.STATION_NAME, s.STATION_LOCATION,
  ROUND(UNIFORM(10, 20, RANDOM())::FLOAT + UNIFORM(0,9,RANDOM())/10.0, 1) AS TEMPERATURE_C,
  ROUND(UNIFORM(8, 17, RANDOM())::FLOAT, 1) AS FEELS_LIKE_C,
  ROUND(UNIFORM(5, 18, RANDOM())::FLOAT, 1) AS WIND_SPEED_MPH,
  ROUND(UNIFORM(10, 25, RANDOM())::FLOAT, 1) AS WIND_GUST_MPH,
  ROUND(UNIFORM(10, 60, RANDOM())::FLOAT, 0) AS PRECIPITATION_PROB_PCT,
  ROUND(UNIFORM(0, 3, RANDOM())::FLOAT, 1) AS PRECIPITATION_MM,
  CASE UNIFORM(1,5,RANDOM()) WHEN 1 THEN 'Light Rain' WHEN 2 THEN 'Cloudy' WHEN 3 THEN 'Partly Cloudy' WHEN 4 THEN 'Overcast' ELSE 'Clear' END AS WEATHER_CONDITION,
  'normal' AS WEATHER_SEVERITY,
  '${safeCity}' AS CITY
FROM forecast_days d CROSS JOIN hours h CROSS JOIN stations s`);
      } catch (err: any) { console.error('Weather forecast generation error:', err.message); }

      const wrc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.WEATHER_OBSERVATIONS WHERE CITY IN (${cityList})`);
      updateStep('weather', { status: 'complete', rows: Number(wrc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('weather', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    // Step 9: Flood Monitoring
    checkCancelled();
    updateStep('floods', { status: 'running', message: 'Generating flood monitoring data...', started_at: Date.now() });
    try {
      const safeCity = city.replace(/'/g, "''");
      const floodZones: Record<string, { name: string; polygon: string; desc: string }> = {
        'San Francisco': {
          name: 'Mission Creek Flash Flood',
          polygon: 'POLYGON((-122.4010 37.7705, -122.3985 37.7695, -122.3960 37.7692, -122.3935 37.7698, -122.3912 37.7708, -122.3898 37.7725, -122.3892 37.7748, -122.3900 37.7770, -122.3915 37.7790, -122.3935 37.7805, -122.3955 37.7812, -122.3975 37.7808, -122.3992 37.7795, -122.4005 37.7775, -122.4012 37.7750, -122.4015 37.7730, -122.4010 37.7705))',
          desc: 'Flash flooding reported in the Mission Creek and SoMa area. Surface water flooding affecting roads and low-lying areas. Multiple road closures in effect.'
        },
        'London': {
          name: 'Thames Barrier Flash Flood',
          polygon: 'POLYGON((-0.0590 51.4908, -0.0520 51.4895, -0.0440 51.4892, -0.0360 51.4900, -0.0280 51.4915, -0.0220 51.4938, -0.0210 51.4970, -0.0225 51.5005, -0.0260 51.5035, -0.0310 51.5058, -0.0380 51.5075, -0.0450 51.5072, -0.0520 51.5055, -0.0570 51.5030, -0.0598 51.4995, -0.0605 51.4955, -0.0590 51.4908))',
          desc: 'Flash flooding in the Greenwich and Isle of Dogs area. Surface water flooding affecting major roads. Thames Barrier activated.'
        },
        'Paris': {
          name: 'Seine Overflow Flash Flood',
          polygon: 'POLYGON((2.3215 48.8458, 2.3290 48.8448, 2.3370 48.8445, 2.3450 48.8452, 2.3530 48.8465, 2.3585 48.8490, 2.3598 48.8525, 2.3580 48.8558, 2.3545 48.8585, 2.3490 48.8605, 2.3420 48.8618, 2.3350 48.8612, 2.3285 48.8595, 2.3235 48.8568, 2.3210 48.8535, 2.3200 48.8498, 2.3215 48.8458))',
          desc: 'Flash flooding near the Seine river in the 5th and 13th arrondissements. Surface water affecting roads and metro stations.'
        },
      };
      const zone = floodZones[city] || floodZones['San Francisco'];
      const zone2Name = city === 'London' ? 'Wandsworth Surface Water' : city === 'Paris' ? 'Marais District Drainage' : 'Bayview Basin Overflow';
      const zone2Poly = city === 'San Francisco'
        ? 'POLYGON((-122.3955 37.7258, -122.3930 37.7248, -122.3900 37.7245, -122.3870 37.7250, -122.3842 37.7262, -122.3820 37.7282, -122.3812 37.7305, -122.3825 37.7328, -122.3848 37.7348, -122.3878 37.7365, -122.3910 37.7372, -122.3938 37.7365, -122.3958 37.7345, -122.3965 37.7318, -122.3962 37.7290, -122.3955 37.7258))'
        : city === 'London'
        ? 'POLYGON((-0.1990 51.4558, -0.1930 51.4548, -0.1865 51.4545, -0.1800 51.4555, -0.1745 51.4572, -0.1718 51.4600, -0.1712 51.4635, -0.1730 51.4665, -0.1770 51.4688, -0.1825 51.4702, -0.1890 51.4708, -0.1948 51.4698, -0.1985 51.4675, -0.2002 51.4645, -0.2005 51.4610, -0.1990 51.4558))'
        : 'POLYGON((2.3510 48.8558, 2.3548 48.8548, 2.3585 48.8550, 2.3618 48.8562, 2.3640 48.8582, 2.3645 48.8608, 2.3632 48.8635, 2.3608 48.8655, 2.3575 48.8668, 2.3540 48.8672, 2.3508 48.8662, 2.3488 48.8642, 2.3482 48.8615, 2.3490 48.8588, 2.3510 48.8558))';
      const lastDay = `'${start_date}'::DATE`;

      await snowSql(`DELETE FROM ${DB}.DATA.FLOOD_MONITORING WHERE CITY IN (${cityList})`);
      await snowSql(`INSERT INTO ${DB}.DATA.FLOOD_MONITORING
SELECT 'FLOOD-001' AS FLOOD_ID, '${zone.name.replace(/'/g, "''")}' AS FLOOD_NAME, 'severe' AS SEVERITY,
  TRY_TO_GEOGRAPHY('${zone.polygon}') AS FLOOD_AREA,
  ST_CENTROID(TRY_TO_GEOGRAPHY('${zone.polygon}')) AS CENTROID,
  DATEADD('hour', 11, ${lastDay}::TIMESTAMP_NTZ) AS START_TIME,
  DATEADD('hour', 17, ${lastDay}::TIMESTAMP_NTZ) AS END_TIME,
  DATEADD('hour', 13, ${lastDay}::TIMESTAMP_NTZ) AS PEAK_TIME,
  1.8 AS WATER_LEVEL_M, TRUE AS IS_ACTIVE, 12 AS AFFECTED_ROADS_EST,
  '${zone.desc.replace(/'/g, "''")}' AS DESCRIPTION, '${safeCity}' AS CITY
UNION ALL
SELECT 'FLOOD-002', '${zone2Name.replace(/'/g, "''")}', 'moderate',
  TRY_TO_GEOGRAPHY('${zone2Poly}'),
  ST_CENTROID(TRY_TO_GEOGRAPHY('${zone2Poly}')),
  DATEADD('hour', 12, ${lastDay}::TIMESTAMP_NTZ),
  DATEADD('hour', 16, ${lastDay}::TIMESTAMP_NTZ),
  DATEADD('hour', 14, ${lastDay}::TIMESTAMP_NTZ),
  0.9, TRUE, 6,
  'Moderate surface water flooding affecting local roads. Drains overwhelmed. Caution advised.',
  '${safeCity}'`);
      const frc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.FLOOD_MONITORING WHERE CITY IN (${cityList})`);
      updateStep('floods', { status: 'complete', rows: Number(frc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('floods', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    // Step 10: Delivery Incidents
    checkCancelled();
    updateStep('incidents', { status: 'running', message: 'Generating delivery incidents...', started_at: Date.now() });
    try {
      const lastDay = `'${start_date}'::DATE`;
      await snowSql(`DELETE FROM ${DB}.DATA.DELIVERY_INCIDENTS WHERE CITY IN (${cityList})`);
      await snowSql(`INSERT INTO ${DB}.DATA.DELIVERY_INCIDENTS
WITH all_deliveries AS (
  SELECT ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DELIVERY_TIME,
    RESTAURANT_LOCATION, CUSTOMER_LOCATION, GEOMETRY, CITY,
    DATE_TRUNC('day', ORDER_TIME) = ${lastDay}::DATE AS is_last_day,
    HOUR(ORDER_TIME) AS order_hour
  FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES
  WHERE GEOMETRY IS NOT NULL AND CITY IN (${cityList})
),
flood_zones AS (
  SELECT FLOOD_ID, FLOOD_AREA, START_TIME, END_TIME
  FROM ${DB}.DATA.FLOOD_MONITORING WHERE CITY IN (${cityList})
),
weather_at_time AS (
  SELECT DISTINCT DATE_TRUNC('hour', OBSERVATION_TIME) AS obs_hour, WEATHER_CONDITION, WEATHER_SEVERITY
  FROM ${DB}.DATA.WEATHER_OBSERVATIONS
  WHERE CITY IN (${cityList}) AND WEATHER_SEVERITY IN ('warning', 'severe')
),
flood_affected AS (
  SELECT d.ORDER_ID, d.COURIER_ID, d.ORDER_TIME, d.CUSTOMER_LOCATION, d.CITY,
    f.FLOOD_ID, 'flooding' AS INCIDENT_TYPE,
    UNIFORM(15, 45, RANDOM()) AS DELAY_MINUTES,
    CASE UNIFORM(1,3,RANDOM())
      WHEN 1 THEN 'Route blocked by flash flooding. Courier diverted via alternative route.'
      WHEN 2 THEN 'Delivery delayed due to road closure from flooding. Area impassable.'
      ELSE 'Surface water on route caused significant slowdown. Courier proceeded with caution.'
    END AS DESCRIPTION
  FROM all_deliveries d
  JOIN flood_zones f ON d.is_last_day
    AND d.ORDER_TIME BETWEEN f.START_TIME AND f.END_TIME
    AND ST_DWITHIN(d.CUSTOMER_LOCATION, f.FLOOD_AREA, 800)
),
weather_affected AS (
  SELECT d.ORDER_ID, d.COURIER_ID, d.ORDER_TIME, d.CUSTOMER_LOCATION, d.CITY,
    NULL AS FLOOD_ID, 'weather' AS INCIDENT_TYPE,
    UNIFORM(5, 20, RANDOM()) AS DELAY_MINUTES,
    CASE w.WEATHER_CONDITION
      WHEN 'Heavy Rain' THEN 'Heavy rain reducing visibility and road grip. Courier speed reduced for safety.'
      WHEN 'Thunderstorm' THEN 'Thunderstorm conditions. Courier sheltered temporarily before continuing.'
      ELSE 'Adverse weather conditions causing delivery slowdown.'
    END AS DESCRIPTION
  FROM all_deliveries d
  JOIN weather_at_time w ON DATE_TRUNC('hour', d.ORDER_TIME) = w.obs_hour
  WHERE d.ORDER_ID NOT IN (SELECT ORDER_ID FROM flood_affected)
    AND UNIFORM(1, 100, RANDOM()) <= 40
),
traffic_affected AS (
  SELECT d.ORDER_ID, d.COURIER_ID, d.ORDER_TIME, d.CUSTOMER_LOCATION, d.CITY,
    NULL AS FLOOD_ID, 'traffic' AS INCIDENT_TYPE,
    UNIFORM(5, 15, RANDOM()) AS DELAY_MINUTES,
    CASE UNIFORM(1,5,RANDOM())
      WHEN 1 THEN 'Heavy traffic congestion on main route.'
      WHEN 2 THEN 'Road works causing detour and delay.'
      WHEN 3 THEN 'Accident on route causing traffic backup.'
      WHEN 4 THEN 'Rush hour congestion significantly slowing courier progress.'
      ELSE 'Unexpected traffic delay on delivery route.'
    END AS DESCRIPTION
  FROM all_deliveries d
  WHERE d.ORDER_ID NOT IN (SELECT ORDER_ID FROM flood_affected)
    AND d.ORDER_ID NOT IN (SELECT ORDER_ID FROM weather_affected)
    AND d.order_hour BETWEEN 11 AND 20
    AND UNIFORM(1, 100, RANDOM()) <= 12
)
SELECT
  MD5(ORDER_ID || INCIDENT_TYPE || RANDOM()) AS INCIDENT_ID,
  ORDER_ID, COURIER_ID, INCIDENT_TYPE,
  DATEADD('minute', UNIFORM(5, 30, RANDOM()), ORDER_TIME) AS INCIDENT_TIME,
  DELAY_MINUTES, CUSTOMER_LOCATION AS INCIDENT_LOCATION, DESCRIPTION,
  FLOOD_ID AS RELATED_FLOOD_ID,
  CASE INCIDENT_TYPE WHEN 'flooding' THEN 'Heavy Rain' WHEN 'weather' THEN 'Heavy Rain' ELSE NULL END AS WEATHER_CONDITION,
  DATEADD('minute', DELAY_MINUTES, DATEADD('minute', UNIFORM(5, 30, RANDOM()), ORDER_TIME)) AS RESOLVED_TIME,
  CITY
FROM (
  SELECT * FROM flood_affected
  UNION ALL SELECT * FROM weather_affected
  UNION ALL SELECT * FROM traffic_affected
)`);
      const irc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_INCIDENTS WHERE CITY IN (${cityList})`);
      updateStep('incidents', { status: 'complete', rows: Number(irc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('incidents', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    // Step 11: Customer Calls
    checkCancelled();
    updateStep('calls', { status: 'running', message: 'Generating customer calls...', started_at: Date.now() });
    try {
      await snowSql(`DELETE FROM ${DB}.DATA.CUSTOMER_CALLS WHERE CITY IN (${cityList})`);
      await snowSql(`INSERT INTO ${DB}.DATA.CUSTOMER_CALLS
WITH incident_orders AS (
  SELECT i.INCIDENT_ID, i.ORDER_ID, i.COURIER_ID, i.INCIDENT_TYPE, i.INCIDENT_TIME,
    i.DELAY_MINUTES, i.DESCRIPTION AS INC_DESC, i.RELATED_FLOOD_ID, i.CITY,
    d.RESTAURANT_NAME, d.CUSTOMER_ADDRESS
  FROM ${DB}.DATA.DELIVERY_INCIDENTS i
  JOIN ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES d ON i.ORDER_ID = d.ORDER_ID
  WHERE i.CITY IN (${cityList})
),
first_names AS (
  SELECT column1 AS fname, ROW_NUMBER() OVER (ORDER BY column1) - 1 AS fn_idx FROM VALUES
  ('Emma'),('James'),('Sarah'),('Michael'),('Lisa'),('David'),('Anna'),('Robert'),
  ('Kate'),('John'),('Maria'),('Tom'),('Sophie'),('Chris'),('Rachel'),('Alex'),
  ('Olivia'),('Daniel'),('Jessica'),('Ben'),('Lucy'),('Sam'),('Claire'),('Mark'),
  ('Amy'),('Paul'),('Nina'),('Harry'),('Zoe'),('Jack')
),
last_names AS (
  SELECT column1 AS lname, ROW_NUMBER() OVER (ORDER BY column1) - 1 AS ln_idx FROM VALUES
  ('Smith'),('Johnson'),('Williams'),('Brown'),('Jones'),('Garcia'),('Miller'),
  ('Davis'),('Rodriguez'),('Martinez'),('Anderson'),('Thomas'),('Jackson'),('White'),
  ('Harris'),('Martin'),('Thompson'),('Moore'),('Allen'),('Young')
),
call_templates AS (
  SELECT io.*,
    UNIFORM(1, 100, RANDOM()) AS call_roll,
    MOD(ABS(HASH(io.ORDER_ID || 'fn')), 30) AS fname_idx,
    MOD(ABS(HASH(io.ORDER_ID || 'ln')), 20) AS lname_idx
  FROM incident_orders io
  WHERE UNIFORM(1, 100, RANDOM()) <= 70
)
SELECT
  MD5(ct.ORDER_ID || 'CALL' || RANDOM()) AS CALL_ID, ct.ORDER_ID,
  DATEADD('minute', UNIFORM(5, 60, RANDOM())::INT, ct.INCIDENT_TIME) AS CALL_TIME,
  fn.fname || ' ' || ln.lname AS CUSTOMER_NAME,
  CASE WHEN ct.INCIDENT_TYPE = 'flooding' THEN UNIFORM(120, 360, RANDOM()) WHEN ct.INCIDENT_TYPE = 'weather' THEN UNIFORM(90, 240, RANDOM()) ELSE UNIFORM(60, 180, RANDOM()) END AS CALL_DURATION_SECS,
  CASE WHEN ct.call_roll <= 75 THEN 'complaint' WHEN ct.call_roll <= 90 THEN 'enquiry' ELSE 'cancellation' END AS CALL_TYPE,
  CASE
    WHEN ct.INCIDENT_TYPE = 'flooding' AND ct.call_roll <= 30 THEN 'angry'
    WHEN ct.INCIDENT_TYPE = 'flooding' THEN 'frustrated'
    WHEN ct.INCIDENT_TYPE = 'weather' AND ct.call_roll <= 20 THEN 'angry'
    WHEN ct.INCIDENT_TYPE = 'weather' THEN 'frustrated'
    WHEN ct.call_roll <= 15 THEN 'angry'
    WHEN ct.call_roll <= 50 THEN 'frustrated'
    WHEN ct.call_roll <= 80 THEN 'neutral'
    ELSE 'understanding'
  END AS SENTIMENT,
  CASE ct.INCIDENT_TYPE WHEN 'flooding' THEN 'flood delay' WHEN 'weather' THEN 'weather delay' ELSE 'late delivery' END AS ISSUE_CATEGORY,
  CASE ct.INCIDENT_TYPE
    WHEN 'flooding' THEN CASE UNIFORM(1,4,RANDOM())
      WHEN 1 THEN 'My order from ' || ct.RESTAURANT_NAME || ' is very late. The driver says the road is flooded and they cannot get through.'
      WHEN 2 THEN 'I have been waiting over an hour. Apparently there is flooding near my area. When will my food arrive?'
      WHEN 3 THEN 'The courier called to say they are stuck due to flooding. This is unacceptable. I want a refund.'
      ELSE 'My delivery is delayed because of flooding. Can you give me an update on when it will arrive?' END
    WHEN 'weather' THEN CASE UNIFORM(1,4,RANDOM())
      WHEN 1 THEN 'My order is late. I understand the weather is bad but I placed this order an hour ago.'
      WHEN 2 THEN 'The delivery is taking much longer than expected. Is it because of the rain?'
      WHEN 3 THEN 'Hi, just checking on my order from ' || ct.RESTAURANT_NAME || '. The app says it is delayed due to weather.'
      ELSE 'My food is going to be cold by the time it arrives. The rain has caused major delays apparently.' END
    ELSE CASE UNIFORM(1,4,RANDOM())
      WHEN 1 THEN 'My order from ' || ct.RESTAURANT_NAME || ' was supposed to arrive 20 minutes ago. Where is my courier?'
      WHEN 2 THEN 'The delivery is running late. The app showed 15 minutes but it has been 30 already.'
      WHEN 3 THEN 'Can I get an update on my order? It seems to be stuck in traffic somewhere.'
      ELSE 'Hi, my delivery is delayed. The tracker shows the courier has not moved in a while.' END
  END AS CALL_NOTES,
  CASE WHEN ct.call_roll <= 10 THEN 'refund issued' WHEN ct.call_roll <= 30 THEN 'discount offered' WHEN ct.call_roll <= 60 THEN 'apology and ETA provided' WHEN ct.call_roll <= 85 THEN 'customer informed of situation' ELSE 'order cancelled and refunded' END AS RESOLUTION,
  ct.INCIDENT_ID AS RELATED_INCIDENT_ID, ct.CITY
FROM call_templates ct
JOIN first_names fn ON ct.fname_idx = fn.fn_idx
JOIN last_names ln ON ct.lname_idx = ln.ln_idx`);
      const crc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.CUSTOMER_CALLS WHERE CITY IN (${cityList})`);
      updateStep('calls', { status: 'complete', rows: Number(crc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('calls', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

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

app.post('/api/city/:city/cancel', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const jobKey = `city_${city}`;
    const cancelled = await cancelActiveStatements(jobKey);
    updateCityState(city, { status: 'idle', message: `Build cancelled (${cancelled} queries stopped)`, error: undefined, dataSteps: undefined });
    console.log(`[cancel] City build cancelled for ${city}: ${cancelled} statements`);
    res.json({ status: 'cancelled', city, statements_cancelled: cancelled });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const CITY_DATA_TABLES = ['CUSTOMER_CALLS', 'DELIVERY_INCIDENTS', 'FLOOD_MONITORING', 'WEATHER_FORECASTS', 'WEATHER_OBSERVATIONS', 'COURIER_LOCATIONS', 'DELIVERY_ROUTE_GEOMETRIES', 'COURIERS'];

app.delete('/api/city/:city/data', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const cityList = `'${city.replace(/'/g, "''")}'`;
    const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
    const DB = SF_DATABASE;
    const results: any = {};
    for (const table of CITY_DATA_TABLES) {
      try {
        const fqn = `${DB}.DATA.${table}`;
        const cityCol = table === 'COURIERS' ? `COURIER_ID LIKE '${cityPrefix}-%'` : `CITY IN (${cityList})`;
        const countRows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${fqn} WHERE ${cityCol}`);
        const rowsBefore = Number(countRows[0]?.CNT || 0);
        await snowSql(`DELETE FROM ${fqn} WHERE ${cityCol}`);
        results[table] = { rows_before: rowsBefore, status: 'removed' };
      } catch { results[table] = { rows_before: 0, status: 'error' }; }
    }
    try { await snowSql(`DELETE FROM ${DB}.DATA.RESTAURANTS WHERE CITY IN (${cityList})`); results['RESTAURANTS'] = { status: 'removed' }; } catch { results['RESTAURANTS'] = { status: 'error' }; }
    try { await snowSql(`DELETE FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE CITY IN (${cityList})`); results['CUSTOMER_ADDRESSES'] = { status: 'removed' }; } catch { results['CUSTOMER_ADDRESSES'] = { status: 'error' }; }
    if (cityProvisionStates[city]) { cityProvisionStates[city] = { status: 'idle', orsRegion: getOrsRegion(city) }; }
    res.json({ status: 'removed', city, tables: results });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/city/:city/restore', async (req, res) => {
  try {
    const city = decodeURIComponent(req.params.city);
    const { offset_minutes = 5 } = req.body || {};
    const cityList = `'${city.replace(/'/g, "''")}'`;
    const cityPrefix = city.replace(/\s/g, '').slice(0, 3).toUpperCase();
    const DB = SF_DATABASE;
    const results: any = {};
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
      const pkCol = table === 'COURIERS' ? 'COURIER_ID' : table === 'RESTAURANTS' ? 'RESTAURANT_ID' : table === 'CUSTOMER_ADDRESSES' ? 'ADDRESS_ID' : 'ORDER_ID';
      try {
        await snowSql(`INSERT INTO ${fqn} SELECT * FROM ${fqn} AT(OFFSET => -${offsetSecs}) WHERE ${filter} AND NOT EXISTS (SELECT 1 FROM ${fqn} curr WHERE curr.${pkCol} = ${fqn}.${pkCol})`);
        const countRows = await snowSql(`SELECT COUNT(*) AS CNT FROM ${fqn} WHERE ${filter}`);
        results[table] = { rows_restored: Number(countRows[0]?.CNT || 0), status: 'restored' };
      } catch { results[table] = { rows_restored: 0, status: 'error' }; }
    }
    res.json({ status: 'restored', city, tables: results });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/matrix/directions', async (req, res) => {
  try {
    const startLon = Number(req.query.start_lon);
    const startLat = Number(req.query.start_lat);
    const endLon = Number(req.query.end_lon);
    const endLat = Number(req.query.end_lat);
    const city = (req.query.city as string) || 'San Francisco';
    const profile = mapOrsProfile((req.query.profile as string) || 'cycling-electric');
    if (!startLon || !startLat || !endLon || !endLat) {
      return res.status(400).json({ error: 'start_lon, start_lat, end_lon, end_lat required' });
    }
    const region = getOrsRegion(city);
    let regionStatus = await checkOrsRegionReady(region);
    if (regionStatus.serviceStatus === 'SUSPENDED' || regionStatus.serviceStatus === 'NOT_FOUND') {
      const svcName = `ORS_SERVICE_${region.toUpperCase()}`;
      console.log(`ORS service ${svcName} is ${regionStatus.serviceStatus}, attempting resume...`);
      try {
        await snowSql(`ALTER SERVICE ${SF_DATABASE}.ROUTING.${svcName} RESUME`);
        await snowSql(`ALTER SERVICE IF EXISTS ${SF_DATABASE}.ROUTING.ROUTING_GATEWAY_SERVICE RESUME`);
      } catch (e: any) {
        console.log('ORS resume attempt:', e.message?.slice(0, 200));
      }
      for (let i = 0; i < 60; i++) {
        regionStatus = await checkOrsRegionReady(region);
        if (regionStatus.serviceStatus === 'RUNNING' && regionStatus.functionExists) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!regionStatus.functionExists && regionStatus.serviceStatus !== 'RUNNING') {
      return res.status(503).json({ error: 'ORS routing service not available. Build city data first.' });
    }
    const dirFn = getDirectionsFn(city);
    const sql = `
      SELECT ${dirFn}(
        '${profile.replace(/'/g, "''")}',
        ARRAY_CONSTRUCT(${startLon}, ${startLat}),
        ARRAY_CONSTRUCT(${endLon}, ${endLat})
      ) AS ROUTE_RESPONSE`;
    const rows = await snowSql(sql);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No route found' });
    }
    const raw = rows[0].ROUTE_RESPONSE || rows[0].route_response;
    let parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const feature = parsed?.features?.[0];
    if (!feature?.geometry?.coordinates) {
      return res.status(404).json({ error: 'No route geometry in response' });
    }
    const coords: [number, number][] = feature.geometry.coordinates;
    const distance = feature.properties?.summary?.distance || 0;
    const duration = feature.properties?.summary?.duration || 0;
    let totalDist = 0;
    const timestamps: number[] = [0];
    for (let i = 1; i < coords.length; i++) {
      const dx = coords[i][0] - coords[i - 1][0];
      const dy = coords[i][1] - coords[i - 1][1];
      totalDist += Math.sqrt(dx * dx + dy * dy);
      timestamps.push(totalDist);
    }
    if (totalDist > 0) {
      for (let i = 0; i < timestamps.length; i++) {
        timestamps[i] = (timestamps[i] / totalDist) * duration;
      }
    }
    res.json({
      coordinates: coords,
      timestamps,
      distance_meters: distance,
      duration_seconds: duration,
      start: [startLon, startLat],
      end: [endLon, endLat],
    });
  } catch (err: any) {
    console.error('directions error:', err.message);
    res.status(500).json({ error: err.message?.slice(0, 300) });
  }
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
