import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const IS_SPCS = existsSync('/snowflake/session/token');

const SF_DATABASE = process.env.SNOWFLAKE_DATABASE || 'OPENROUTESERVICE_SETUP';
const SF_SCHEMA = process.env.SNOWFLAKE_SCHEMA || 'FLEET_INTELLIGENCE_FOOD_DELIVERY';
const SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH';
const CONN = process.env.SNOWFLAKE_CONNECTION_NAME || 'FREE_TRIAL';
const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';

function getSpcsToken(): string {
  return readFileSync('/snowflake/session/token', 'utf-8').trim();
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\[[\d;]*m/g, '');
}

function cortexCompleteLocal(prompt: string, model: string = 'llama3.1-70b'): string {
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

function cortexCompleteLocalFile(messages: any[], model: string = 'llama3.1-70b'): string {
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

Available tables in OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY:
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
Keep queries efficient. Use fully qualified table names.`;

    let sqlStatement = '';
    let sqlExplanation = '';
    let mapAction: any = null;

    if (IS_SPCS) {
      try {
        const escapedSystem = systemPrompt.replace(/'/g, "\\'");
        const escapedUser = userQuestion.replace(/'/g, "\\'");
        const cortexSql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('llama3.1-70b', [{'role':'system','content':'${escapedSystem}'},{'role':'user','content':'${escapedUser}'}], {'max_tokens':1024}) as RESPONSE`;
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
      const result = cortexCompleteLocalFile([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuestion },
      ], 'llama3.1-70b');
      try {
        const jsonMatch = result.match(/\{[\s\S]*"sql"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          sqlStatement = parsed.sql || '';
          sqlExplanation = parsed.explanation || '';
          mapAction = parsed.map_action || null;
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
If the data query failed or returned no results, provide a helpful response using general knowledge about fleet operations.

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
    }

    if (IS_SPCS) {
      try {
        const escapedSys = responsePrompt.replace(/'/g, "\\'");
        const userContent = `${userQuestion}${dataContext}`.replace(/'/g, "\\'");
        const cortexSql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('llama3.1-70b', [{'role':'system','content':'${escapedSys}'},{'role':'user','content':'${userContent}'}], {'max_tokens':2048}) as RESPONSE`;
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
      ], 'llama3.1-70b');
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

app.get('/api/matrix/existing', async (_req, res) => {
  try {
    const counts: Record<string, number> = {};
    for (const tbl of ['CA_TRAVEL_TIME_RES7', 'CA_TRAVEL_TIME_RES8', 'CA_TRAVEL_TIME_RES9']) {
      try {
        const rows = await snowSql(`SELECT COUNT(*) as CNT FROM OPENROUTESERVICE_SETUP.PUBLIC.${tbl}`);
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

    const jobId = `${region}_${Date.now()}`;
    const statuses: Record<number, any> = {};
    for (const r of resolutions) {
      statuses[r] = {
        resolution: r,
        status: 'building',
        total_origins: 0,
        processed_origins: 0,
        total_pairs: 0,
        built_pairs: 0,
        percent_complete: 0,
        elapsed_seconds: 0,
        est_remaining_seconds: 0,
      };
    }
    matrixBuildJobs[region] = { region, resolutions, started: Date.now(), statuses };

    for (const r of resolutions) {
      const tableName = `CA_TRAVEL_TIME_RES${r}`;
      const pairsTable = `CA_H3_RES${r}_PAIRS`;
      const procName = `BUILD_TRAVEL_TIME_MATRIX_RES${r}`;

      (async () => {
        try {
          const pairsCount = await snowSql(`SELECT COUNT(*) as CNT FROM OPENROUTESERVICE_SETUP.PUBLIC.${pairsTable}`);
          const totalPairs = Number(pairsCount[0]?.CNT || 0);
          statuses[r].total_pairs = totalPairs;

          await snowSql(`CALL OPENROUTESERVICE_SETUP.PUBLIC.${procName}()`);

          statuses[r].status = 'complete';
          statuses[r].built_pairs = totalPairs;
          statuses[r].percent_complete = 100;
        } catch (err: any) {
          statuses[r].status = 'error';
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
    if (!job) {
      return res.json({ region, resolutions: [] });
    }

    for (const r of job.resolutions) {
      if (job.statuses[r].status === 'building') {
        try {
          const tableName = `CA_TRAVEL_TIME_RES${r}`;
          const rows = await snowSql(`SELECT COUNT(*) as CNT FROM OPENROUTESERVICE_SETUP.PUBLIC.${tableName}`);
          const builtPairs = Number(rows[0]?.CNT || 0);
          job.statuses[r].built_pairs = builtPairs;
          const elapsed = (Date.now() - job.started) / 1000;
          job.statuses[r].elapsed_seconds = elapsed;
          if (job.statuses[r].total_pairs > 0) {
            job.statuses[r].percent_complete = (builtPairs / job.statuses[r].total_pairs) * 100;
            if (builtPairs > 0) {
              const rate = builtPairs / elapsed;
              const remaining = (job.statuses[r].total_pairs - builtPairs) / rate;
              job.statuses[r].est_remaining_seconds = remaining;
            }
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
