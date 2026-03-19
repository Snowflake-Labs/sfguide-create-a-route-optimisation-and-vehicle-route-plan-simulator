import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const IS_SPCS = existsSync('/snowflake/session/token');
const SF_DATABASE = process.env.SNOWFLAKE_DATABASE || 'OPENROUTESERVICE_NATIVE_APP';
let SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || '';
const CONN = process.env.SNOWFLAKE_CONNECTION_NAME || 'FREE_TRIAL';
const SNOWFLAKE_HOST = process.env.SNOWFLAKE_HOST || '';

async function detectWarehouse(): Promise<void> {
  if (SF_WAREHOUSE) return;
  try {
    const rows = IS_SPCS
      ? await snowSqlSpcs('SHOW WAREHOUSES LIMIT 1')
      : snowSqlLocal('SHOW WAREHOUSES LIMIT 1');
    const name = (rows as any[])?.[0]?.name || (rows as any[])?.[0]?.NAME;
    if (name) SF_WAREHOUSE = name;
    else SF_WAREHOUSE = 'COMPUTE_WH';
  } catch {
    SF_WAREHOUSE = 'COMPUTE_WH';
  }
}

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

function sanitizeIdentifier(val: string): string {
  const cleaned = val.replace(/[^A-Za-z0-9_]/g, '');
  if (!IDENTIFIER_RE.test(cleaned)) throw new Error(`Invalid identifier: ${val}`);
  return cleaned;
}

function sanitizeFloat(val: any): number {
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${val}`);
  return n;
}

function sanitizeInt(val: any): number {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error(`Invalid integer: ${val}`);
  return n;
}

function escapeString(val: string): string {
  return val.replace(/'/g, "''");
}

function getSpcsToken(): string {
  return readFileSync('/snowflake/session/token', 'utf-8').trim();
}

function snowSqlLocal(sql: string): any[] {
  const tmpFile = join(tmpdir(), `ors_query_${Date.now()}.sql`);
  const fullSql = `USE WAREHOUSE ${SF_WAREHOUSE};\nUSE DATABASE ${SF_DATABASE};\n${sql};`;
  writeFileSync(tmpFile, fullSql);
  try {
    const result = execSync(`snow sql -c ${CONN} -f "${tmpFile}" --format json 2>/dev/null`, {
      maxBuffer: 50 * 1024 * 1024, timeout: 120000, encoding: 'utf-8',
    });
    const parsed = JSON.parse(result.trim());
    if (Array.isArray(parsed) && Array.isArray(parsed[0])) return parsed[parsed.length - 1];
    return parsed;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function snowSqlSpcs(sql: string, timeoutSecs: number = 600): Promise<any[]> {
  const token = getSpcsToken();
  const body = { statement: sql, timeout: timeoutSecs, database: SF_DATABASE, warehouse: SF_WAREHOUSE };
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
    'Accept': 'application/json', 'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  const res = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`SQL API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  let result: any = await res.json();
  if (result.statementStatusUrl && (!result.data || result.code === '333334')) {
    const pollUrl = `https://${SNOWFLAKE_HOST}${result.statementStatusUrl}`;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pr = await fetch(pollUrl, { headers });
      result = await pr.json();
      if (result.data || (result.code && result.code !== '333334')) break;
    }
  }
  if (!result.data) return [];
  const cols = (result.resultSetMetaData?.rowType || []).map((c: any) => c.name);
  return (result.data || []).map((row: any[]) => {
    const obj: Record<string, any> = {};
    cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
    return obj;
  });
}

async function runSql(sql: string): Promise<any[]> {
  if (IS_SPCS) return snowSqlSpcs(sql);
  return snowSqlLocal(sql);
}

async function callProcedure(proc: string): Promise<string> {
  const rows = await runSql(`CALL ${SF_DATABASE}.CORE.${proc}`);
  return rows?.[0]?.[Object.keys(rows[0])[0]] || '';
}

app.get('/api/status', async (_req, res) => {
  try {
    const result = await callProcedure('GET_STATUS()');
    res.json(JSON.parse(result));
  } catch (err: any) {
    res.json({ compute_pool: 'ERROR', services: [], error: err.message });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    const rows = await runSql(`SELECT ${SF_DATABASE}.CORE.CHECK_HEALTH() AS H`);
    res.json({ healthy: rows?.[0]?.H === 'true' || rows?.[0]?.H === true || rows?.[0]?.H === 'TRUE' });
  } catch {
    res.json({ healthy: false });
  }
});

app.post('/api/resume', async (_req, res) => {
  try {
    const result = await callProcedure('RESUME_ALL_SERVICES()');
    res.json({ status: 'ok', result });
  } catch (err: any) {
    res.json({ status: 'error', error: err.message });
  }
});

app.post('/api/suspend', async (_req, res) => {
  try {
    const result = await callProcedure('SUSPEND_ALL_SERVICES()');
    res.json({ status: 'ok', result });
  } catch (err: any) {
    res.json({ status: 'error', error: err.message });
  }
});

app.post('/api/scale', async (req, res) => {
  try {
    const min = sanitizeInt(req.body.min);
    const max = sanitizeInt(req.body.max);
    if (min < 1 || max < min || max > 20) return res.status(400).json({ error: 'min must be 1-20, max >= min' });
    const result = await callProcedure(`SCALE_SERVICES(${min}, ${max})`);
    res.json({ status: 'ok', result });
  } catch (err: any) {
    res.json({ status: 'error', error: err.message });
  }
});

app.get('/api/cities', async (_req, res) => {
  try {
    const result = await callProcedure('LIST_CITIES()');
    const cities = JSON.parse(result || '[]');
    const enriched = await Promise.all(cities.map(async (c: any) => {
      let serviceStatus = 'UNKNOWN';
      try {
        const safeRegion = sanitizeIdentifier(c.region);
        const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion}' IN SCHEMA ${SF_DATABASE}.CORE`);
        serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
      } catch { serviceStatus = 'NOT_FOUND'; }
      return { ...c, serviceStatus, functionExists: true };
    }));
    res.json({ cities: enriched });
  } catch (err: any) {
    res.json({ cities: [], error: err.message });
  }
});

const provisionStates: Record<string, any> = {};

app.post('/api/cities/provision', async (req, res) => {
  const { city, region, pbf_url, bbox } = req.body;
  if (!region) return res.status(400).json({ error: 'region required' });

  let safeRegion: string;
  let safeCity: string;
  try {
    safeRegion = sanitizeIdentifier(region);
    safeCity = escapeString(city || region);
    sanitizeFloat(bbox?.minLat);
    sanitizeFloat(bbox?.maxLat);
    sanitizeFloat(bbox?.minLon);
    sanitizeFloat(bbox?.maxLon);
  } catch (err: any) {
    return res.status(400).json({ error: `Invalid input: ${err.message}` });
  }

  const safePbfUrl = escapeString(pbf_url || '');
  const minLat = sanitizeFloat(bbox.minLat);
  const maxLat = sanitizeFloat(bbox.maxLat);
  const minLon = sanitizeFloat(bbox.minLon);
  const maxLon = sanitizeFloat(bbox.maxLon);

  provisionStates[safeRegion] = { status: 'started', phase: 'downloading_pbf' };
  res.json({ status: 'started' });

  (async () => {
    try {
      provisionStates[safeRegion] = { status: 'running', phase: 'downloading_pbf', message: 'Downloading PBF file...' };
      await runSql(`INSERT INTO ${SF_DATABASE}.CORE.CITY_ORS_MAP (REGION, DISPLAY_NAME, PBF_URL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, STATUS) VALUES ('${safeRegion}', '${safeCity}', '${safePbfUrl}', ${minLat}, ${maxLat}, ${minLon}, ${maxLon}, 'PROVISIONING')`);

      try {
        const pbfFilename = escapeString((pbf_url || '').split('/').pop() || 'data.osm.pbf');
        await runSql(`SELECT ${SF_DATABASE}.CORE.DOWNLOAD('ors_spcs_stage/${safeRegion}', '${pbfFilename}', '${safePbfUrl}')`);
      } catch {}

      provisionStates[safeRegion] = { status: 'running', phase: 'creating_service', message: 'Creating ORS service...' };
      await callProcedure(`SETUP_CITY_ORS('${safeRegion}')`);

      provisionStates[safeRegion] = { status: 'running', phase: 'building_graph', message: 'Waiting for routing graph build...' };
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        try {
          const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion}' IN SCHEMA ${SF_DATABASE}.CORE`);
          if (rows?.[0]?.status === 'RUNNING') break;
        } catch {}
      }

      provisionStates[safeRegion] = { status: 'running', phase: 'creating_functions', message: 'Creating city functions...' };
      await callProcedure(`CREATE_CITY_FUNCTIONS('${safeRegion}')`);

      provisionStates[safeRegion] = { status: 'complete', phase: 'ready', message: 'City provisioned' };
    } catch (err: any) {
      provisionStates[safeRegion] = { status: 'error', phase: '', error: err.message };
    }
  })();
});

app.get('/api/cities/:region/progress', (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    res.json(provisionStates[safeRegion] || { status: 'idle', phase: '' });
  } catch {
    res.json({ status: 'idle', phase: '' });
  }
});

app.delete('/api/cities/:region', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const result = await callProcedure(`DROP_CITY_ORS('${safeRegion}')`);
    delete provisionStates[safeRegion];
    res.json({ status: 'ok', result });
  } catch (err: any) {
    res.json({ status: 'error', error: err.message });
  }
});

app.get('/api/matrix/regions', async (_req, res) => {
  try {
    const cities = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.CITY_ORS_MAP`);
    const regions: any[] = [];

    for (const c of cities) {
      const safeRegion = sanitizeIdentifier(c.REGION || '');
      let serviceStatus = 'NOT_FOUND';
      try {
        const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion}' IN SCHEMA ${SF_DATABASE}.CORE`);
        serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
      } catch {}

      regions.push({
        region: c.REGION, label: c.DISPLAY_NAME || c.REGION,
        bounds: { minLat: c.MIN_LAT, maxLat: c.MAX_LAT, minLon: c.MIN_LON, maxLon: c.MAX_LON },
        serviceStatus, serviceExists: serviceStatus !== 'NOT_FOUND',
        matrixFunctionExists: true, directionsFunctionExists: true,
        ready: serviceStatus === 'RUNNING' || serviceStatus === 'SUSPENDED',
        provisioned: true,
        matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`,
        cities: [c.DISPLAY_NAME || c.REGION],
      });
    }

    let mainStatus = 'NOT_FOUND';
    try {
      const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE' IN SCHEMA ${SF_DATABASE}.CORE`);
      mainStatus = rows?.[0]?.status || 'NOT_FOUND';
    } catch {}
    if (mainStatus !== 'NOT_FOUND') {
      regions.unshift({
        region: 'default', label: 'Default (Main ORS)',
        bounds: { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 },
        serviceStatus: mainStatus, serviceExists: true,
        matrixFunctionExists: true, directionsFunctionExists: true,
        ready: mainStatus === 'RUNNING' || mainStatus === 'SUSPENDED',
        provisioned: true,
        matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`,
        cities: ['Default'],
      });
    }

    res.json({ regions });
  } catch (err: any) {
    res.json({ regions: [], error: err.message });
  }
});

app.get('/api/matrix/existing', async (req, res) => {
  try {
    const region = req.query.region as string;
    let where = '';
    if (region && region !== 'default') {
      const safeRegion = sanitizeIdentifier(region);
      where = ` WHERE REGION = '${safeRegion}'`;
    }
    const counts: Record<string, number> = {};
    for (const r of [7, 8, 9]) {
      const rows = await runSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.CORE.TRAVEL_TIME_RES${r}${where}`);
      counts[`RES${r}`] = parseInt(rows?.[0]?.CNT || '0');
    }
    res.json(counts);
  } catch (err: any) {
    res.json({});
  }
});

const matrixBuildStates: Record<string, any> = {};

app.post('/api/matrix/build', async (req, res) => {
  const { region, resolutions } = req.body;
  if (!region || !resolutions) return res.status(400).json({ error: 'region and resolutions required' });

  let safeRegion: string;
  try {
    safeRegion = region === 'default' ? 'default' : sanitizeIdentifier(region);
  } catch (err: any) {
    return res.status(400).json({ error: `Invalid region: ${err.message}` });
  }
  const safeResolutions = (resolutions as number[]).filter((r) => [7, 8, 9].includes(r));
  if (safeResolutions.length === 0) return res.status(400).json({ error: 'resolutions must include 7, 8, or 9' });

  const key = `${safeRegion}_${Date.now()}`;
  matrixBuildStates[key] = { region: safeRegion, resolutions: safeResolutions.map((r: number) => ({ resolution: r, status: 'starting', stage: 'NOT_STARTED', percent_complete: 0, hexagons: 0, work_queue: 0, raw_ingested: 0, flattened: 0, total_origins: 0, processed_origins: 0, total_pairs: 0, built_pairs: 0, elapsed_seconds: 0, est_remaining_seconds: 0, region: safeRegion })) };
  res.json({ status: 'started', key });

  (async () => {
    for (const resolution of safeResolutions) {
      try {
        const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.CITY_ORS_MAP WHERE REGION = '${safeRegion}'`);
        const bbox = cityRow?.[0] || { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
        const matrixFn = safeRegion === 'default' ? `${SF_DATABASE}.CORE.MATRIX_TABULAR` : `${SF_DATABASE}.CORE.MATRIX_${safeRegion.toUpperCase()}`;

        const resState = matrixBuildStates[key].resolutions.find((r: any) => r.resolution === resolution);
        if (resState) { resState.status = 'building'; resState.stage = 'HEXAGONS_READY'; }

        await callProcedure(`BUILD_MATRIX_FOR_REGION('RES${resolution}', ${sanitizeFloat(bbox.MIN_LAT)}, ${sanitizeFloat(bbox.MAX_LAT)}, ${sanitizeFloat(bbox.MIN_LON)}, ${sanitizeFloat(bbox.MAX_LON)}, '${escapeString(matrixFn)}', '${safeRegion}')`);

        if (resState) { resState.status = 'complete'; resState.stage = 'COMPLETE'; resState.percent_complete = 100; }
      } catch (err: any) {
        const resState = matrixBuildStates[key].resolutions.find((r: any) => r.resolution === resolution);
        if (resState) { resState.status = 'error'; resState.error = err.message; }
      }
    }
  })();
});

app.get('/api/matrix/status', async (req, res) => {
  try {
    const progress = await callProcedure('MATRIX_PROGRESS()');
    const parsed = JSON.parse(progress || '{}');
    const resolutions = Object.entries(parsed).map(([key, val]: [string, any]) => ({
      resolution: parseInt(key.replace('RES', '')), status: val.stage === 'COMPLETE' ? 'complete' : val.stage === 'NOT_STARTED' ? 'idle' : 'building',
      stage: val.stage, hexagons: val.hexagons, work_queue: val.work_queue, raw_ingested: val.raw_ingested, flattened: val.flattened,
      percent_complete: val.pct || 0, total_origins: val.work_queue, processed_origins: val.raw_ingested,
      total_pairs: val.flattened, built_pairs: val.flattened, elapsed_seconds: 0, est_remaining_seconds: 0, region: req.query.region || '',
    }));
    res.json({ resolutions });
  } catch (err: any) {
    res.json({ resolutions: [], error: err.message });
  }
});

app.post('/api/query', async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql) return res.status(400).json({ error: 'sql required' });
    const trimmed = sql.trim().replace(/;+$/, '').trim();
    const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
    const ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'CALL', 'WITH'];
    if (!ALLOWED.includes(firstWord)) {
      return res.status(403).json({ error: `Only read-only queries allowed. Got: ${firstWord}` });
    }
    const rows = await runSql(trimmed);
    res.json({ result: rows });
  } catch (err: any) {
    res.json({ error: err.message });
  }
});

app.use(express.static(join(import.meta.dirname || '.', '../dist')));

const PORT = parseInt(process.env.PORT || '3001');
detectWarehouse().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ORS Control App server running on port ${PORT} (SPCS: ${IS_SPCS}, WH: ${SF_WAREHOUSE})`);
  });
});
