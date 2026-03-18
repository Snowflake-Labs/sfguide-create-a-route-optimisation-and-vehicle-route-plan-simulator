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

const CITY_ORS_MAP: Record<string, any> = {
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

const ORS_REGION_CONFIG: Record<string, any> = {};
for (const [city, cfg] of Object.entries(CITY_ORS_MAP)) {
  if (!ORS_REGION_CONFIG[cfg.orsRegion]) {
    ORS_REGION_CONFIG[cfg.orsRegion] = { pbfUrl: cfg.pbfUrl, pbfFilename: cfg.pbfFilename, cities: [] };
  }
  ORS_REGION_CONFIG[cfg.orsRegion].cities.push(city);
}

const cityProvisionStates: Record<string, any> = {};

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

async function snowSqlSpcs(sql: string, timeoutSecs: number = 600): Promise<any[]> {
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

  if (result.statementStatusUrl && (!result.data || result.code === '333334')) {
    const pollUrl = `https://${host}${result.statementStatusUrl}`;
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
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
}

async function snowSql(sql: string, timeoutSecs?: number): Promise<any[]> {
  if (IS_SPCS) return snowSqlSpcs(sql, timeoutSecs || 600);
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
    const conditions: string[] = [];
    if (city !== 'All Cities') conditions.push(`CITY = '${city.replace(/'/g, "''")}'`);
    if (statusFilter === 'active') conditions.push(`ORDER_STATUS != 'delivered'`);
    else if (statusFilter && statusFilter !== 'all') conditions.push(`ORDER_STATUS = '${statusFilter.replace(/'/g, "''")}'`);
    if (dateFilter) conditions.push(`TO_VARCHAR(ORDER_TIME::DATE, 'YYYY-MM-DD') = '${dateFilter.replace(/'/g, "''")}'`);
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
    send({ type: 'status', message: 'Analyzing your question...' });
    send({ type: 'thinking_delta', text: 'Interpreting your question and generating a data query...\n' });

    send({ type: 'tool_use', tool_name: 'fleet_data', tool_type: 'cortex_analyst_text_to_sql' });
    send({ type: 'status', message: 'Querying fleet intelligence data...' });

    console.log('Generating SQL for:', userQuestion.slice(0, 200));

    const systemPrompt = `You are a fleet intelligence analyst for SwiftBite, a food delivery company operating across multiple cities including San Francisco, London, and Paris. Generate a SQL query for the user's question.

Available tables in ${SF_DATABASE}.${SF_SCHEMA}:
- DELIVERY_SUMMARY: ORDER_ID, COURIER_ID, RESTAURANT_ID, RESTAURANT_NAME, CUISINE_TYPE, CUSTOMER_ADDRESS, CITY, ORDER_TIME (TIMESTAMP), PICKUP_TIME (TIMESTAMP), DELIVERY_TIME (TIMESTAMP), ORDER_STATUS (values: 'delivered', 'in_transit', 'picked_up'), ROUTE_DISTANCE_METERS, ROUTE_DURATION_SECS, PREP_TIME_MINS, SHIFT_TYPE (Lunch/Dinner/Afternoon), VEHICLE_TYPE (car/scooter/bicycle), AVERAGE_KMH, MAX_KMH, GEOMETRY
- COURIER_LOCATIONS: ORDER_ID, COURIER_ID, ORDER_TIME, PICKUP_TIME, DROPOFF_TIME, RESTAURANT_LOCATION (GeoJSON Point), CUSTOMER_LOCATION (GeoJSON Point), ROUTE (GeoJSON LineString), POINT_GEOM (GeoJSON Point - current position), CURR_TIME, POINT_INDEX, COURIER_STATE (en_route, etc.), KMH, CITY
- ORDERS_ASSIGNED_TO_COURIERS: ORDER_ID, COURIER_ID, RESTAURANT_ID, RESTAURANT_NAME, CUSTOMER_ADDRESS, CITY, ORDER_TIME, ORDER_STATUS

For time-series/trend queries, use DATE_TRUNC or HOUR(ORDER_TIME) to bucket time. For "delivery load over time" queries, count deliveries grouped by time bucket.

IMPORTANT: ORDER_STATUS can be 'delivered', 'in_transit', or 'picked_up'. Active/pending orders are those NOT 'delivered'. When the user asks about active, in-progress, pending, or not-yet-delivered orders, filter with ORDER_STATUS != 'delivered'.

You can also emit map_action commands to control the dashboard map. If the user asks to show active/in-transit orders on the map, or to filter the map, include a "map_action" field:
- {"sql": "...", "explanation": "...", "map_action": {"filter": "active"}} — show only active (non-delivered) routes on map
- {"sql": "...", "explanation": "...", "map_action": {"filter": "in_transit"}} — show only in_transit routes
- {"sql": "...", "explanation": "...", "map_action": {"filter": "all"}} — show all routes (reset filter)

Return ONLY a JSON object: {"sql": "SELECT ...", "explanation": "...", "map_action": {...} (optional)}
Keep queries efficient and concise. Use fully qualified table names. IMPORTANT: Keep SQL short — select only the columns needed to answer the question, never SELECT *. For count/summary questions use aggregations. Limit detail queries to 20 rows.`;

    let sqlStatement = '';
    let sqlExplanation = '';
    let mapAction: any = null;

    if (IS_SPCS) {
      try {
        const escapedSystem = systemPrompt.replace(/'/g, "\\'");
        const escapedUser = userQuestion.replace(/'/g, "\\'");
        const cortexSql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-3-5-sonnet', [{'role':'system','content':'${escapedSystem}'},{'role':'user','content':'${escapedUser}'}], {'max_tokens':2048}) as RESPONSE`;
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
              const sanitized = jsonMatch[0].replace(/(?<=":[\s]*"[^"]*)\n/g, ' ').replace(/[\x00-\x1f]/g, (c: string) => c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '\\r' : '');
              let parsedJson: any;
              try {
                parsedJson = JSON.parse(sanitized);
              } catch {
                const sqlDirect = content.match(/"sql"\s*:\s*"([\s\S]*?)(?:"\s*[,}])/);
                const explDirect = content.match(/"explanation"\s*:\s*"([\s\S]*?)(?:"\s*[,}])/);
                if (sqlDirect) {
                  parsedJson = { sql: sqlDirect[1].replace(/\\n/g, ' ').replace(/\n/g, ' '), explanation: explDirect?.[1] || '' };
                }
              }
              if (parsedJson) {
                sqlStatement = parsedJson.sql || '';
                sqlExplanation = parsedJson.explanation || '';
                mapAction = parsedJson.map_action || null;
              }
            } else {
              console.error('SQL gen: no JSON match found in content (length=' + content.length + '):', content.slice(0, 500));
            }
          } catch (parseErr: any) {
            console.error('SQL gen: JSON parse failed:', parseErr.message, 'content preview:', content.slice(0, 500));
          }
        }
      } catch (cortexErr: any) {
        console.error('CORTEX.COMPLETE SQL gen exception:', cortexErr.name, cortexErr.message);
      }
    } else {
      const result = cortexCompleteLocalFile([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuestion },
      ], 'claude-3-5-sonnet');
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
            mapAction = parsed.map_action || null;
          }
        }
      } catch {}
    }

    if (mapAction) {
      send({ type: 'map_filter', filter: mapAction.filter || 'all' });
    }

    let queryResults: any[] = [];
    let queryError = '';

    if (sqlStatement) {
      console.log('Generated SQL:', sqlStatement.slice(0, 300));
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
      const svcName = region === 'SanFrancisco' ? 'ORS_SERVICE' : `ORS_SERVICE_${region.toUpperCase()}`;
      const matrixFnName = region === 'SanFrancisco' ? 'MATRIX_TABULAR' : `MATRIX_${region.toUpperCase()}`;
      const dirFnName = region === 'SanFrancisco' ? 'DIRECTIONS' : `DIRECTIONS_${region.toUpperCase()}`;

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
        `SELECT TABLE_NAME, ROW_COUNT FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'DATA' AND TABLE_NAME IN ('CA_TRAVEL_TIME_RES7', 'CA_TRAVEL_TIME_RES8', 'CA_TRAVEL_TIME_RES9')`
      );
      for (const row of rows) {
        counts[row.TABLE_NAME] = Number(row.ROW_COUNT || 0);
      }
    } catch {
      for (const tbl of ['CA_TRAVEL_TIME_RES7', 'CA_TRAVEL_TIME_RES8', 'CA_TRAVEL_TIME_RES9']) {
        counts[tbl] = 0;
      }
    }
    try {
      for (const res_level of [7, 8, 9]) {
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
    const matrixFnName = region === 'SanFrancisco' ? 'MATRIX_TABULAR' : `MATRIX_${region.toUpperCase()}`;
    const matrixFn = `${SF_DATABASE}.ROUTING.${matrixFnName}`;
    const vehicleProfile = vehicle_type || 'cycling-electric';

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

    try {
      await snowSql(`ALTER SERVICE IF EXISTS ${SF_DATABASE}.ROUTING.ROUTING_GATEWAY_SERVICE RESUME`);
    } catch {}
    if (region === 'SanFrancisco') {
      try { await snowSql(`ALTER SERVICE IF EXISTS ${SF_DATABASE}.ROUTING.ORS_SERVICE RESUME`); } catch {}
    } else {
      try { await snowSql(`ALTER SERVICE IF EXISTS ${SF_DATABASE}.ROUTING.ORS_SERVICE_${region.toUpperCase()} RESUME`); } catch {}
    }

    for (const r of resolutions) {
      const resLabel = `RES${r}`;

      (async () => {
        try {
          statuses[r].stage = 'HEXAGONS_READY';
          const result = await snowSql(
            `CALL ${SF_DATABASE}.DATA.BUILD_MATRIX_FOR_REGION('${resLabel}', ${bounds.minLat}, ${bounds.maxLat}, ${bounds.minLon}, ${bounds.maxLon}, '${matrixFn}', '${region}', '${vehicleProfile}')`
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

    res.json({ status: 'started', jobId, region, vehicle_type: vehicleProfile });
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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: IS_SPCS ? 'spcs' : 'local' });
});

app.delete('/api/matrix/remove', async (req, res) => {
  try {
    const resolutions = (req.query.resolutions as string || '7,8,9').split(',').map(Number);
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
    const { resolutions = [7, 8, 9], offset_minutes = 5 } = req.body;
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

  const { cities = ['San Francisco'], num_couriers = 50, num_days = 1, start_date = '2025-01-15', shifts, vehicle_type = 'cycling-electric' } = req.body;
  const DB = SF_DATABASE;
  const cityList = cities.map((c: string) => `'${c.replace(/'/g, "''")}'`).join(',');
  const vehicleType = vehicle_type || 'cycling-electric';

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

      // Step 5: ORS Routes
      updateStep('routes', { status: 'running', message: 'Generating ORS routes (this may take several minutes)...', started_at: Date.now() });
      try {
        const routingFn = `${DB}.ROUTING.DIRECTIONS`;
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
  const svcName = region === 'SanFrancisco' ? 'ORS_SERVICE' : `ORS_SERVICE_${region.toUpperCase()}`;
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
  const isSF = region === 'SanFrancisco';
  const svcName = isSF ? 'ORS_SERVICE' : `ORS_SERVICE_${region.toUpperCase()}`;
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
    if (!isSF) {
      await snowSql(`CALL ${DB}.ROUTING.CREATE_CITY_ORS_SERVICE('${region}')`);
      try {
        await snowSql(`CALL ${DB}.ROUTING.CREATE_SERVICES()`);
      } catch (e: any) {
        console.log('create_services for shared gateway info:', e.message?.slice(0, 200));
      }
    } else {
      await snowSql(`CALL ${DB}.ROUTING.SETUP_ORS()`);
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
    if (!isSF) {
      await snowSql(`CALL ${DB}.ROUTING.CREATE_CITY_FUNCTIONS('${region}')`);
    } else {
      await snowSql(`CALL ${DB}.ROUTING.CREATE_FUNCTIONS()`);
    }
  }
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
  if (region === 'SanFrancisco') return `${SF_DATABASE}.ROUTING.DIRECTIONS`;
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
  const DB = SF_DATABASE;
  const { num_couriers, num_days, start_date } = opts;
  const vehicleType = opts.vehicle_type || 'cycling-electric';
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
WHERE ST_Y(GEOMETRY) BETWEEN ${cityBbox.minLat} AND ${cityBbox.maxLat}
  AND ST_X(GEOMETRY) BETWEEN ${cityBbox.minLon} AND ${cityBbox.maxLon}
  AND STREET IS NOT NULL) SAMPLE (50000 ROWS)`);
      }
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.CUSTOMER_ADDRESSES WHERE CITY IN (${cityList})`);
      updateStep('addresses', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('addresses', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

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
      updateStep('couriers', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('couriers', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    updateStep('orders', { status: 'complete', message: 'Orders generated in routes step', rows: 0 });

    if (opts.orsPromise) {
      updateStep('routes', { status: 'waiting_for_ors', message: 'Waiting for ORS routing service to be ready...', started_at: Date.now() });
      await opts.orsPromise;
    }

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
      '${vehicleType.replace(/'/g, "''")}',
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
FROM cumulative_timing`, 1800);
      updateStep('routes', { status: 'complete' });
    } catch (err: any) { updateStep('routes', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

    updateStep('geometries', { status: 'running', message: 'Counting results...', started_at: Date.now() });
    try {
      const rc = await snowSql(`SELECT COUNT(*) AS CNT FROM ${DB}.DATA.DELIVERY_ROUTE_GEOMETRIES WHERE CITY IN (${cityList})`);
      updateStep('orders', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
      updateStep('geometries', { status: 'complete', rows: Number(rc[0]?.CNT || 0) });
    } catch (err: any) { updateStep('geometries', { status: 'error', message: err.message?.slice(0, 300) }); throw err; }

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

const CITY_DATA_TABLES = ['COURIER_LOCATIONS', 'DELIVERY_ROUTE_GEOMETRIES', 'COURIERS'];

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
    const profile = (req.query.profile as string) || 'cycling-electric';
    if (!startLon || !startLat || !endLon || !endLat) {
      return res.status(400).json({ error: 'start_lon, start_lat, end_lon, end_lat required' });
    }
    const region = getOrsRegion(city);
    const regionStatus = await checkOrsRegionReady(region);
    if (regionStatus.serviceStatus === 'SUSPENDED') {
      const svcName = region === 'SanFrancisco' ? 'ORS_SERVICE' : `ORS_SERVICE_${region.toUpperCase()}`;
      try {
        await snowSql(`ALTER SERVICE ${SF_DATABASE}.ROUTING.${svcName} RESUME`);
        await snowSql(`ALTER SERVICE IF EXISTS ${SF_DATABASE}.ROUTING.ROUTING_GATEWAY_SERVICE RESUME`);
      } catch (e: any) {
        console.log('ORS resume attempt:', e.message?.slice(0, 200));
      }
      for (let i = 0; i < 60; i++) {
        const check = await checkOrsRegionReady(region);
        if (check.serviceStatus === 'RUNNING' && check.functionExists) break;
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
