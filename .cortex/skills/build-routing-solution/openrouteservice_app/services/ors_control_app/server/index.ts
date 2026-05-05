import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStudioRouter } from './studio/routes.js';
import { log, getEntries, clearEntries, getUptimeMs } from './diagnostics.js';
import { IS_SPCS, SF_DATABASE, SF_WAREHOUSE, setWarehouse, CONN, SNOWFLAKE_HOST, DEFAULT_WAREHOUSE } from './constants.js';

config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

async function detectWarehouse(): Promise<void> {
  if (SF_WAREHOUSE) return;
  try {
    const rows = IS_SPCS
      ? await snowSqlSpcs('SHOW WAREHOUSES LIMIT 1')
      : snowSqlLocal('SHOW WAREHOUSES LIMIT 1');
    const name = (rows as any[])?.[0]?.name || (rows as any[])?.[0]?.NAME;
    if (name) setWarehouse(name);
    else setWarehouse(DEFAULT_WAREHOUSE);
  } catch {
    setWarehouse(DEFAULT_WAREHOUSE);
  }
}

async function waitForOrsGraphReady(region: string, maxWaitSecs: number = 600): Promise<{ ready: boolean; elapsed: number; profiles: string[] }> {
  const start = Date.now();
  const interval = 15000;
  const maxAttempts = Math.ceil((maxWaitSecs * 1000) / interval);
  const safeRegion = region.replace(/[^A-Za-z0-9_]/g, '');
  let isDefault = !safeRegion || safeRegion.toUpperCase() === 'DEFAULT';
  if (!isDefault) {
    try {
      const svcRows = await runSql(
        `SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion.toUpperCase()}' IN SCHEMA ${SF_DATABASE}.CORE`
      );
      isDefault = !svcRows || svcRows.length === 0;
    } catch { isDefault = true; }
  }
  const statusSql = isDefault
    ? `SELECT ${SF_DATABASE}.CORE.ORS_STATUS() AS S`
    : `SELECT ${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}') AS S`;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const rows = await runSql(statusSql);
      const raw = rows?.[0]?.S;
      if (raw) {
        const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (status.service_ready === true && status.profiles) {
          const profileNames = Object.keys(status.profiles);
          if (profileNames.length > 0) {
            return { ready: true, elapsed: Math.round((Date.now() - start) / 1000), profiles: profileNames };
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  return { ready: false, elapsed: Math.round((Date.now() - start) / 1000), profiles: [] };
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
  return val.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '');
}

function getSpcsToken(): string {
  return readFileSync('/snowflake/session/token', 'utf-8').trim();
}

function snowSqlLocal(sql: string, database?: string, schema?: string): any[] {
  const tmpFile = join(tmpdir(), `ors_query_${Date.now()}.sql`);
  const db = database || SF_DATABASE;
  let fullSql = `ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';\nUSE WAREHOUSE ${SF_WAREHOUSE};\nUSE DATABASE ${db};\n`;
  if (schema) fullSql += `USE SCHEMA ${schema};\n`;
  fullSql += `${sql};`;
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

async function snowSqlSpcs(sql: string, database?: string, schema?: string, timeoutSecs: number = 600): Promise<any[]> {
  const token = getSpcsToken();
  const QUERY_TAG = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
  const body = { statement: sql, timeout: timeoutSecs, database: database || SF_DATABASE, schema: schema || 'CORE', warehouse: SF_WAREHOUSE, parameters: { QUERY_TAG } };
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
    'Accept': 'application/json', 'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  console.log(`[SQL API] Executing: ${sql.slice(0, 200)} (WH: ${SF_WAREHOUSE}, DB: ${SF_DATABASE}, HOST: ${SNOWFLAKE_HOST})`);
  const sqlStart = Date.now();
  const res = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 500);
    log('ERROR', 'SQL', `API error ${res.status}: ${errBody.slice(0, 200)}`, { durationMs: Date.now() - sqlStart });
    throw new Error(`SQL API error ${res.status}: ${errBody}`);
  }
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
  if (result.message && !result.data) {
    log('ERROR', 'SQL', `Statement error: ${result.message?.slice(0, 200)}`, { durationMs: Date.now() - sqlStart });
    throw new Error(`SQL error: ${result.message}`);
  }
  if (!result.data) return [];
  const cols = (result.resultSetMetaData?.rowType || []).map((c: any) => c.name);
  let allData: any[][] = [...(result.data || [])];
  const partitions = result.resultSetMetaData?.partitionInfo;
  if (partitions && partitions.length > 1) {
    const handle = result.statementHandle;
    console.log(`[SQL API] Result has ${partitions.length} partitions (${result.resultSetMetaData?.numRows} rows). Fetching remaining...`);
    for (let p = 1; p < partitions.length; p++) {
      const pr = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements/${handle}?partition=${p}`, { headers });
      const partResult: any = await pr.json();
      if (partResult.data) allData = allData.concat(partResult.data);
    }
  }
  console.log(`[SQL API] Returning ${allData.length} rows`);
  return allData.map((row: any[]) => {
    const obj: Record<string, any> = {};
    cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
    return obj;
  });
}

async function runSql(sql: string, database?: string, schema?: string): Promise<any[]> {
  if (IS_SPCS) return snowSqlSpcs(sql, database, schema);
  return snowSqlLocal(sql, database, schema);
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
    log('ERROR', 'Health', `/api/status error: ${err.message?.slice(0, 200)}`);
    res.json({ compute_pool: 'ERROR', services: [], error: err.message });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ database: SF_DATABASE });
});

const APP_VERSION = process.env.APP_VERSION || '0.0.0';

const DEFAULT_PROFILES = ['driving-car', 'driving-hgv', 'cycling-electric'];
let cachedDefaultExpectedProfiles: string[] | null = null;
let activeRegionOverride: string | null = null;

async function getExpectedProfiles(region: string): Promise<string[]> {
  if (region === 'default') {
    if (cachedDefaultExpectedProfiles) return cachedDefaultExpectedProfiles;
    try {
      const rows = await runSql(`SELECT "$1" AS CONTENT FROM @${SF_DATABASE}.CORE.ORS_SPCS_STAGE/SanFrancisco/ors-config.yml (FILE_FORMAT => (TYPE='CSV' FIELD_DELIMITER=NONE RECORD_DELIMITER=NONE))`);
      const content = rows?.[0]?.CONTENT;
      if (content && typeof content === 'string') {
        const profileMatches = content.match(/profiles:\s*([\s\S]*?)(?:^\S|$)/m);
        if (profileMatches) {
          const profiles: string[] = [];
          const enabledPattern = /([\w-]+):\s*\n[\s\S]*?enabled:\s*true/gm;
          const block = profileMatches[1];
          let m;
          while ((m = enabledPattern.exec(block)) !== null) {
            profiles.push(m[1]);
          }
          if (profiles.length > 0) {
            cachedDefaultExpectedProfiles = profiles;
            return profiles;
          }
        }
      }
    } catch (e: any) {
      console.log(`[getExpectedProfiles] Could not parse config from stage: ${e.message}`);
    }
    cachedDefaultExpectedProfiles = DEFAULT_PROFILES;
    return DEFAULT_PROFILES;
  }
  try {
    const safeRegion = sanitizeIdentifier(region);
    const rows = await runSql(`SELECT PROFILES FROM ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS WHERE REGION='${escapeString(safeRegion)}' AND STATUS='COMPLETED' ORDER BY COMPLETED_AT DESC LIMIT 1`);
    const profileStr = rows?.[0]?.PROFILES;
    if (profileStr && typeof profileStr === 'string') {
      return profileStr.split(',').map((p: string) => p.trim()).filter(Boolean);
    }
  } catch (e: any) {
    console.log(`[getExpectedProfiles] Could not get profiles for ${region}: ${e.message}`);
  }
  return DEFAULT_PROFILES;
}

app.get('/api/health', async (_req, res) => {
  const result: Record<string, any> = { healthy: false, version: APP_VERSION, services: {} };
  try {
    const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.ORS_SERVICE')) AS S`);
    const raw = statusRows?.[0]?.S;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      result.services.ors = parsed[0]?.status || 'UNKNOWN';
    }
  } catch { result.services.ors = 'ERROR'; }

  try {
    const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.ROUTING_GATEWAY_SERVICE')) AS S`);
    const raw = statusRows?.[0]?.S;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      result.services.gateway = parsed[0]?.status || 'UNKNOWN';
    }
  } catch { result.services.gateway = 'ERROR'; }

  try {
    const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.VROOM_SERVICE')) AS S`);
    const raw = statusRows?.[0]?.S;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      result.services.vroom = parsed[0]?.status || 'UNKNOWN';
    }
  } catch { result.services.vroom = 'ERROR'; }

  try {
    const versionRows = await runSql(`SELECT COMPONENT, VERSION FROM ${SF_DATABASE}.CORE.VERSION_INFO`);
    if (versionRows?.length) {
      result.versions = {};
      for (const row of versionRows) {
        result.versions[row.COMPONENT || row.component] = row.VERSION || row.version;
      }
    }
  } catch {}

  result.healthy = result.services.ors === 'READY' && result.services.gateway === 'READY';
  res.json(result);
});

app.get('/api/ors-readiness', async (_req, res) => {
  const readiness: Record<string, any> = {};

  async function checkGraphsPersisted(_regionKey: string): Promise<boolean> {
    return true;
  }

  async function buildReadiness(regionKey: string, data: any): Promise<any> {
    const builtProfiles = Object.keys(data.profiles || {});
    const expectedProfiles = await getExpectedProfiles(regionKey);
    const allProfiles = [...new Set([...expectedProfiles, ...builtProfiles])];
    const graphs = allProfiles.map(p => ({
      profile: p,
      ready: builtProfiles.includes(p),
      build_date: (data.bounds_info || {})[p]?.graph_build_date || null,
    }));
    const graphs_persisted = await checkGraphsPersisted(regionKey);
    return {
      service_ready: data.service_ready ?? false,
      health_ready: data.health_ready ?? false,
      profiles: builtProfiles,
      expected_profiles: expectedProfiles,
      graphs,
      graphs_persisted,
    };
  }

  try {
    const defaultRows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS()) AS S`);
    const raw = defaultRows?.[0]?.S;
    if (raw) {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      readiness['default'] = await buildReadiness('default', data);
    }
  } catch (e: any) {
    readiness['default'] = { service_ready: false, health_ready: false, error: e.message };
  }

  try {
    const regions = JSON.parse(await callProcedure('LIST_REGIONS()') || '[]');
    for (const r of regions) {
      const safeRegion = sanitizeIdentifier(r.region);
      try {
        const rows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')) AS S`);
        const raw = rows?.[0]?.S;
        if (raw) {
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          readiness[r.region] = await buildReadiness(r.region, data);
        }
      } catch (e: any) {
        readiness[r.region] = { service_ready: false, health_ready: false, error: e.message };
      }
    }
  } catch {}

  res.json(readiness);
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

app.get('/api/regions/catalog', async (req, res) => {
  try {
    const search = (req.query.search as string || '').trim();
    const source = (req.query.source as string || '').trim();
    const level = (req.query.level as string || '').trim();
    let where = 'WHERE 1=1';
    if (search) where += ` AND LOWER(REGION_NAME) LIKE '%${escapeString(search.toLowerCase())}%'`;
    if (source) where += ` AND SOURCE = '${escapeString(source)}'`;
    if (level) where += ` AND LEVEL = '${escapeString(level)}'`;
    const rows = await runSql(`SELECT CATALOG_ID, SOURCE, REGION_NAME, REGION_KEY, HIERARCHY, CONTINENT, COUNTRY, PBF_URL, PBF_SIZE_MB, LEVEL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM ${SF_DATABASE}.CORE.REGION_CATALOG ${where} QUALIFY ROW_NUMBER() OVER (PARTITION BY SOURCE, REGION_KEY, COALESCE(COUNTRY,'') ORDER BY CATALOG_ID) = 1 ORDER BY SOURCE, CONTINENT, COUNTRY, REGION_NAME`);
    res.json({ catalog: rows || [] });
  } catch (err: any) {
    res.json({ catalog: [], error: err.message });
  }
});

app.post('/api/regions/catalog/refresh', async (_req, res) => {
  const GEOFABRIK_BASE = 'https://download.geofabrik.de';
  const BBBIKE_BASE = 'https://download.bbbike.org/osm/bbbike';

  function parseSize(sizeStr: string): number | null {
    const m = sizeStr.trim().match(/^([\d.]+)\s*(MB|GB|KB|bytes)$/i);
    if (!m) return null;
    const val = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    if (unit === 'GB') return val * 1024;
    if (unit === 'KB') return val / 1024;
    if (unit === 'BYTES') return val / (1024 * 1024);
    return val;
  }

  function toRegionKey(name: string): string {
    return name.replace(/[-_]/g, ' ').split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/[^A-Za-z0-9]/g, '');
  }

  async function fetchPage(url: string): Promise<string> {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return '';
      return await r.text();
    } catch { return ''; }
  }

  interface CatalogRow {
    catalog_id: string; source: string; region_name: string; region_key: string;
    hierarchy: string | null; continent: string | null; country: string | null;
    pbf_url: string; pbf_size_mb: number | null; level: string;
    min_lat: number | null; max_lat: number | null; min_lon: number | null; max_lon: number | null;
  }

  type BboxLookup = Map<string, { min_lat: number; max_lat: number; min_lon: number; max_lon: number }>;

  async function fetchGeofabrikBboxIndex(): Promise<BboxLookup> {
    const lookup: BboxLookup = new Map();
    try {
      const resp = await fetch('https://download.geofabrik.de/index-v1.json', { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) return lookup;
      const data = await resp.json() as any;
      for (const feature of data.features || []) {
        const id = feature.properties?.id;
        const geom = feature.geometry;
        if (!id || !geom?.coordinates) continue;
        const allPoints: number[][] = [];
        for (const poly of geom.coordinates) {
          for (const ring of poly) {
            if (Array.isArray(ring[0])) {
              for (const pt of ring) allPoints.push(pt as number[]);
            } else {
              allPoints.push(ring as number[]);
            }
          }
        }
        if (allPoints.length === 0) continue;
        const lons = allPoints.map(p => p[0]);
        const lats = allPoints.map(p => p[1]);
        lookup.set(id, {
          min_lat: Math.min(...lats), max_lat: Math.max(...lats),
          min_lon: Math.min(...lons), max_lon: Math.max(...lons),
        });
      }
    } catch {}
    return lookup;
  }

  function parseBBBikePoly(polyText: string): { min_lat: number; max_lat: number; min_lon: number; max_lon: number } | null {
    const coords: [number, number][] = [];
    for (const line of polyText.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) {
        const lon = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (!isNaN(lon) && !isNaN(lat)) coords.push([lon, lat]);
      }
    }
    if (coords.length === 0) return null;
    return {
      min_lat: Math.min(...coords.map(c => c[1])), max_lat: Math.max(...coords.map(c => c[1])),
      min_lon: Math.min(...coords.map(c => c[0])), max_lon: Math.max(...coords.map(c => c[0])),
    };
  }

  function parseGeofabrikIndex(html: string, basePath: string): Array<{ name: string; pbf_url: string; size_mb: number | null; sub_path: string; has_sub: boolean }> {
    const rows: Array<{ name: string; pbf_url: string; size_mb: number | null; sub_path: string; has_sub: boolean }> = [];
    const trBlocks = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const block of trBlocks) {
      const pbfMatch = block.match(/<a\s+href="([^"]+\.osm\.pbf)"/i);
      if (!pbfMatch) continue;
      const pbfHref = pbfMatch[1];
      if (!pbfHref.includes('-latest')) continue;

      let link = '';
      let name = '';
      const subregionMatch = block.match(/<td[^>]*class="subregion"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
      if (subregionMatch) { link = subregionMatch[1]; name = subregionMatch[2].trim(); }
      else {
        const dirMatch = block.match(/<td[^>]*>\s*<a\s+href="([^"]+\/)"[^>]*>([^<]+)<\/a>/i);
        if (dirMatch) { link = dirMatch[1]; name = dirMatch[2].trim(); }
        else {
          const nameMatch = block.match(/<td[^>]*>\s*<a\s+href="[^"]*"[^>]*>([^<]+)<\/a>/i);
          if (nameMatch) { name = nameMatch[1].trim(); }
          else continue;
        }
      }

      const sizeMatch = block.match(/\((\d[\d.]*\s*(?:MB|GB|KB|bytes))\)/i);
      const sizeMb = sizeMatch ? parseSize(sizeMatch[1]) : null;

      let pbfUrl: string;
      if (pbfHref.startsWith('http')) pbfUrl = pbfHref;
      else if (pbfHref.startsWith('/')) pbfUrl = GEOFABRIK_BASE + pbfHref;
      else {
        const cleanHref = pbfHref.replace(/^\.\//,  '');
        pbfUrl = GEOFABRIK_BASE + '/' + cleanHref;
      }

      let subPath = link.replace(/\.html$/, '').replace(/^\.\//,  '').replace(/\/$/, '');
      if (subPath && !subPath.startsWith('http') && !subPath.startsWith('/')) {
        subPath = basePath ? basePath.replace(/^\/|\/$/g, '') + '/' + subPath : subPath;
      }

      rows.push({ name, pbf_url: pbfUrl, size_mb: sizeMb, sub_path: subPath.replace(/^\/|\/$/g, ''), has_sub: !!(link && (link.endsWith('/') || link.endsWith('.html'))) });
    }
    return rows;
  }

  try {
    const allRows: CatalogRow[] = [];

    const gfBbox = await fetchGeofabrikBboxIndex();

    const html = await fetchPage(GEOFABRIK_BASE);
    const continents = parseGeofabrikIndex(html, '');

    for (const continent of continents) {
      const cname = continent.name;
      const cBbox = gfBbox.get(continent.sub_path);
      allRows.push({
        catalog_id: 'geofabrik:' + continent.sub_path, source: 'geofabrik',
        region_name: cname, region_key: toRegionKey(cname),
        hierarchy: '', continent: cname, country: null,
        pbf_url: continent.pbf_url, pbf_size_mb: continent.size_mb, level: 'continent',
        min_lat: cBbox?.min_lat ?? null, max_lat: cBbox?.max_lat ?? null,
        min_lon: cBbox?.min_lon ?? null, max_lon: cBbox?.max_lon ?? null,
      });

      if (!continent.has_sub || !continent.sub_path) continue;
      const subHtml = await fetchPage(GEOFABRIK_BASE + '/' + continent.sub_path + '.html');
      if (!subHtml) continue;
      const countries = parseGeofabrikIndex(subHtml, continent.sub_path);

      for (const country of countries) {
        const hierarchy = continent.sub_path + '/' + country.name.toLowerCase().replace(/ /g, '-');
        const coId = country.sub_path.split('/').pop() || country.name.toLowerCase().replace(/ /g, '-');
        const coBbox = gfBbox.get(coId) || gfBbox.get(country.sub_path.replace(/^.*\//, ''));
        allRows.push({
          catalog_id: 'geofabrik:' + hierarchy, source: 'geofabrik',
          region_name: country.name, region_key: toRegionKey(country.name),
          hierarchy: continent.sub_path, continent: cname, country: country.name,
          pbf_url: country.pbf_url, pbf_size_mb: country.size_mb, level: 'country',
          min_lat: coBbox?.min_lat ?? null, max_lat: coBbox?.max_lat ?? null,
          min_lon: coBbox?.min_lon ?? null, max_lon: coBbox?.max_lon ?? null,
        });

        if (!country.has_sub || !country.sub_path) continue;
        const sub2Html = await fetchPage(GEOFABRIK_BASE + '/' + country.sub_path + '.html');
        if (!sub2Html) continue;
        const subRegions = parseGeofabrikIndex(sub2Html, country.sub_path);

        for (const subReg of subRegions) {
          const srId = subReg.sub_path.split('/').pop() || subReg.name.toLowerCase().replace(/ /g, '-');
          const srBbox = gfBbox.get(srId) || gfBbox.get(subReg.name.toLowerCase().replace(/ /g, '-'));
          allRows.push({
            catalog_id: 'geofabrik:' + country.sub_path + '/' + subReg.name.toLowerCase().replace(/ /g, '-'),
            source: 'geofabrik',
            region_name: subReg.name, region_key: toRegionKey(subReg.name),
            hierarchy: country.sub_path, continent: cname, country: country.name,
            pbf_url: subReg.pbf_url, pbf_size_mb: subReg.size_mb, level: 'sub-region',
            min_lat: srBbox?.min_lat ?? null, max_lat: srBbox?.max_lat ?? null,
            min_lon: srBbox?.min_lon ?? null, max_lon: srBbox?.max_lon ?? null,
          });
        }
      }
    }

    try {
      const bbResp = await fetch(BBBIKE_BASE + '/', { signal: AbortSignal.timeout(30000) });
      if (bbResp.ok) {
        const bbHtml = await bbResp.text();
        const cityDirs = bbHtml.match(/<a\s+href="([A-Z][A-Za-z0-9_-]+)\/"/g) || [];
        const seen = new Set<string>();
        const cities: string[] = [];
        for (const m of cityDirs) {
          const city = m.match(/href="([^"]+)\/"/)?.[1];
          if (!city || seen.has(city) || city.startsWith('.') || ['planet', 'update'].includes(city.toLowerCase())) continue;
          seen.add(city);
          cities.push(city);
        }
        const polyResults = await Promise.allSettled(
          cities.map(async (city) => {
            try {
              const pr = await fetch(`${BBBIKE_BASE}/${city}/${city}.poly`, { signal: AbortSignal.timeout(10000) });
              if (!pr.ok) return { city, bbox: null };
              return { city, bbox: parseBBBikePoly(await pr.text()) };
            } catch { return { city, bbox: null }; }
          })
        );
        const bbBboxMap = new Map<string, { min_lat: number; max_lat: number; min_lon: number; max_lon: number }>();
        for (const r of polyResults) {
          if (r.status === 'fulfilled' && r.value.bbox) bbBboxMap.set(r.value.city, r.value.bbox);
        }
        for (const city of cities) {
          const display = city.replace(/([a-z])([A-Z])/g, '$1 $2');
          const bb = bbBboxMap.get(city);
          allRows.push({
            catalog_id: 'bbbike:' + city, source: 'bbbike',
            region_name: display, region_key: city,
            hierarchy: null, continent: null, country: null,
            pbf_url: BBBIKE_BASE + '/' + city + '/' + city + '.osm.pbf',
            pbf_size_mb: null, level: 'city',
            min_lat: bb?.min_lat ?? null, max_lat: bb?.max_lat ?? null,
            min_lon: bb?.min_lon ?? null, max_lon: bb?.max_lon ?? null,
          });
        }
      }
    } catch {}

    const seenKeys = new Map<string, boolean>();
    for (let i = allRows.length - 1; i >= 0; i--) {
      const dk = `${allRows[i].source}:${allRows[i].region_key}:${allRows[i].country || ''}`;
      if (seenKeys.has(dk)) {
        allRows.splice(i, 1);
      } else {
        seenKeys.set(dk, true);
      }
    }

    const geofabrikCount = allRows.filter(r => r.source === 'geofabrik').length;
    const bbbikeCount = allRows.filter(r => r.source === 'bbbike').length;

    if (allRows.length > 0) {
      await runSql(`DELETE FROM ${SF_DATABASE}.CORE.REGION_CATALOG`);
      const batchSize = 100;
      for (let i = 0; i < allRows.length; i += batchSize) {
        const batch = allRows.slice(i, i + batchSize);
        const values = batch.map(r => {
          const esc = (v: string | null) => v === null ? 'NULL' : "'" + v.replace(/'/g, "''") + "'";
          const num = (v: number | null) => v === null ? 'NULL' : String(v);
          return `(${esc(r.catalog_id)},${esc(r.source)},${esc(r.region_name)},${esc(r.region_key)},${esc(r.hierarchy)},${esc(r.continent)},${esc(r.country)},${esc(r.pbf_url)},${num(r.pbf_size_mb)},${esc(r.level)},${num(r.min_lat)},${num(r.max_lat)},${num(r.min_lon)},${num(r.max_lon)},CURRENT_TIMESTAMP())`;
        }).join(',');
        await runSql(`INSERT INTO ${SF_DATABASE}.CORE.REGION_CATALOG (CATALOG_ID,SOURCE,REGION_NAME,REGION_KEY,HIERARCHY,CONTINENT,COUNTRY,PBF_URL,PBF_SIZE_MB,LEVEL,MIN_LAT,MAX_LAT,MIN_LON,MAX_LON,UPDATED_AT) VALUES ${values}`);
      }
    }

    res.json({ status: 'ok', result: { geofabrik_count: geofabrikCount, bbbike_count: bbbikeCount, total: allRows.length } });
  } catch (err: any) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/regions/provisioned', async (_req, res) => {
  try {
    const result = await callProcedure('LIST_REGIONS()');
    const regions = JSON.parse(result || '[]');
    const enriched = await Promise.all(regions.map(async (c: any) => {
      let serviceStatus = 'UNKNOWN';
      try {
        const safeRegion = sanitizeIdentifier(c.region);
        const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion}' IN SCHEMA ${SF_DATABASE}.CORE`);
        serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
      } catch { serviceStatus = 'NOT_FOUND'; }

      let bbox = c.bbox;
      const bboxInvalid = !bbox
        || bbox.min_lat == null || bbox.max_lat == null || bbox.min_lon == null || bbox.max_lon == null
        || (bbox.min_lat === 0 && bbox.max_lat === 0 && bbox.min_lon === 0 && bbox.max_lon === 0);
      if (bboxInvalid) {
        try {
          const safeRegion = sanitizeIdentifier(c.region);
          const catRows = await runSql(`SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE UPPER(REGION_KEY) = UPPER('${safeRegion}') OR UPPER(REGION_NAME) = UPPER('${safeRegion}') LIMIT 1`);
          const cat = catRows?.[0];
          if (cat && cat.MIN_LAT != null && cat.MAX_LAT != null && cat.MIN_LON != null && cat.MAX_LON != null
              && !(cat.MIN_LAT === 0 && cat.MAX_LAT === 0 && cat.MIN_LON === 0 && cat.MAX_LON === 0)) {
            bbox = { min_lat: cat.MIN_LAT, max_lat: cat.MAX_LAT, min_lon: cat.MIN_LON, max_lon: cat.MAX_LON };
          }
        } catch {}
      }

      return { ...c, bbox, serviceStatus, functionExists: true };
    }));

    let defaultStatus = 'NOT_FOUND';
    try {
      const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE' IN SCHEMA ${SF_DATABASE}.CORE`);
      defaultStatus = rows?.[0]?.status || 'NOT_FOUND';
    } catch {}
    if (defaultStatus !== 'NOT_FOUND') {
      enriched.unshift({
        region: 'default',
        display_name: 'San Francisco (Default)',
        status: 'DEPLOYED',
        serviceStatus: defaultStatus,
        functionExists: true,
        isDefault: true,
        bbox: { min_lat: 37.71, max_lat: 37.81, min_lon: -122.51, max_lon: -122.37 },
      });
    }

    res.json({ regions: enriched });
  } catch (err: any) {
    res.json({ regions: [], error: err.message });
  }
});

app.post('/api/regions/provision', async (req, res) => {
  const { city, region, pbf_url, bbox, profiles } = req.body;
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

  const defaultProfiles = 'driving-car,driving-hgv,cycling-electric';
  const validProfiles = ['driving-car', 'driving-hgv', 'cycling-regular', 'cycling-road', 'cycling-mountain', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair'];
  const selectedProfiles = Array.isArray(profiles)
    ? profiles.filter((p: string) => validProfiles.includes(p)).join(',')
    : defaultProfiles;
  const safeProfiles = escapeString(selectedProfiles || defaultProfiles);

  const jobId = `PROVISION_${safeRegion}_${Date.now()}`.toUpperCase();

  try {
    await runSql(`INSERT INTO ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS (JOB_ID, REGION, DISPLAY_NAME, PBF_URL, PROFILES, STATUS, STAGE) VALUES ('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', '${safeProfiles}', 'PENDING', 'NOT_STARTED')`);
  } catch (err: any) {
    return res.status(500).json({ error: `Failed to create job: ${err.message}` });
  }

  res.json({ status: 'launched', job_id: jobId });

  try {
    const callSql = `CALL ${SF_DATABASE}.CORE.PROVISION_REGION_WRAPPER('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', ${minLat}, ${maxLat}, ${minLon}, ${maxLon}, '${safeProfiles}')`;
    const handle = await submitSqlAsync(callSql);
    await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATEMENT_HANDLE='${escapeString(handle)}' WHERE JOB_ID='${escapeString(jobId)}'`);
  } catch (e: any) {
    console.error(`[provision] async launch error: ${e.message}`);
  }
});

app.get('/api/regions/provision/status', async (_req, res) => {
  try {
    const result = await callProcedure('GET_PROVISION_STATUS()');
    const jobs = JSON.parse(result || '[]');
    res.json({ jobs });
  } catch (err: any) {
    res.json({ jobs: [], error: err.message });
  }
});

app.get('/api/regions/:region/progress', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const result = await callProcedure('GET_PROVISION_STATUS()');
    const jobs = JSON.parse(result || '[]');
    const job = jobs.find((j: any) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
    if (job) {
      res.json({ status: job.status === 'RUNNING' ? 'running' : job.status, phase: job.stage.toLowerCase(), message: job.message, error: job.error_msg });
    } else {
      const completed = jobs.find((j: any) => j.region === safeRegion);
      res.json(completed ? { status: completed.status.toLowerCase(), phase: completed.stage.toLowerCase(), message: completed.message } : { status: 'idle', phase: '' });
    }
  } catch { res.json({ status: 'idle', phase: '' }); }
});

app.get('/api/regions/:region/build-progress', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const svcName = `${SF_DATABASE}.CORE.ORS_SERVICE_${safeRegion.toUpperCase()}`;
    const rows = await runSql(
      `SELECT SYSTEM$GET_SERVICE_LOGS('${svcName}', 0, 'ors', 1000) AS LOGS`
    );
    const logs: string = rows?.[0]?.LOGS || '';

    const finishedProfiles = [...logs.matchAll(/\[1\] Profile: '([\w-]+)'/g)].map(m => m[1]);
    const startedProfiles = [...logs.matchAll(/ORS-pl-([\w-]+)/g)].map(m => m[1]);
    const uniqueStarted = [...new Set(startedProfiles)];
    const totalProfiles = Math.max(uniqueStarted.length, finishedProfiles.length);
    const lastStarted = uniqueStarted.length > 0 ? uniqueStarted[uniqueStarted.length - 1] : null;
    const currentProfile = lastStarted && !finishedProfiles.includes(lastStarted) ? lastStarted : null;

    if (finishedProfiles.length === totalProfiles && totalProfiles > 0 && !currentProfile) {
      const healthOk = logs.includes('Started Application');
      res.json({
        phase: healthOk ? 'ready' : 'finalizing',
        progress: healthOk ? 100 : 99,
        completedProfiles: finishedProfiles,
        totalProfiles,
        currentProfile: null,
      });
      return;
    }

    const nodeLines = [...logs.matchAll(/edge,\s*nodes:\s*([\d\s]+\d),\s*shortcuts:\s*([\d\s]+\d)/g)];

    const profileTagEsc = currentProfile ? `ORS-pl-${currentProfile}`.replace(/[-/]/g, '\\$&') : null;
    const hasImport = profileTagEsc ? new RegExp(`${profileTagEsc}.*?start creating graph`).test(logs) : false;
    const hasCH = profileTagEsc ? new RegExp(`${profileTagEsc}.*?Creating CH preparations`).test(logs) : false;
    const hasLM = profileTagEsc ? new RegExp(`${profileTagEsc}.*?Creating LM preparations`).test(logs) : false;

    if (nodeLines.length === 0 || !hasCH) {
      const started = logs.includes('Starting Application') || logs.includes('Spring Boot');
      let phase = 'waiting';
      if (started) {
        if (hasImport) phase = 'importing';
        else if (currentProfile) phase = 'initializing';
        else phase = 'initializing';
      }
      res.json({
        phase,
        progress: totalProfiles > 0 ? Math.round((finishedProfiles.length / totalProfiles) * 100) : 0,
        completedProfiles: finishedProfiles,
        totalProfiles,
        currentProfile,
      });
      return;
    }

    if (hasLM) {
      const overallProgress = totalProfiles > 0
        ? Math.round(((finishedProfiles.length + 0.95) / totalProfiles) * 100)
        : 95;
      res.json({
        phase: 'building',
        progress: Math.min(overallProgress, 99),
        profileProgress: 95,
        currentProfile,
        completedProfiles: finishedProfiles,
        totalProfiles,
        detail: 'Landmark preparation',
      });
      return;
    }

    const parseNum = (s: string) => parseInt(s.replace(/\s/g, ''), 10);
    const firstNodes = parseNum(nodeLines[0][1]);
    const lastNodes = parseNum(nodeLines[nodeLines.length - 1][1]);
    const profileProgress = firstNodes > 0 ? (1 - lastNodes / firstNodes) : 0;
    const overallProgress = totalProfiles > 0
      ? Math.round(((finishedProfiles.length + profileProgress * 0.9) / totalProfiles) * 100)
      : Math.round(profileProgress * 90);

    res.json({
      phase: 'building',
      progress: Math.min(overallProgress, 99),
      profileProgress: Math.min(Math.round(profileProgress * 100), 99),
      nodesRemaining: lastNodes,
      nodesTotal: firstNodes,
      currentProfile,
      completedProfiles: finishedProfiles,
      totalProfiles,
    });
  } catch (err: any) {
    res.json({ phase: 'unknown', progress: 0, error: err.message });
  }
});

app.post('/api/regions/:region/cancel', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const result = await callProcedure('GET_PROVISION_STATUS()');
    const jobs = JSON.parse(result || '[]');
    const active = jobs.find((j: any) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
    if (active?.statement_handle) await cancelStatement(active.statement_handle);
    await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=CURRENT_TIMESTAMP() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
    res.json({ status: 'cancelled' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/regions/:region', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const result = await callProcedure(`DROP_REGION_ORS('${safeRegion}')`);
    await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=CURRENT_TIMESTAMP() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
    res.json({ status: 'ok', result });
  } catch (err: any) {
    res.json({ status: 'error', error: err.message });
  }
});

app.get('/api/matrix/regions', async (_req, res) => {
  try {
    const orsRegions = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP`);
    const regions: any[] = [];

    for (const c of orsRegions) {
      const safeRegion = sanitizeIdentifier(c.REGION || '');
      let serviceStatus = 'NOT_FOUND';
      try {
        const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion}' IN SCHEMA ${SF_DATABASE}.CORE`);
        serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
      } catch {}

      regions.push({
        region: c.REGION, label: c.DISPLAY_NAME || c.REGION,
        bounds: { minLat: Number(c.MIN_LAT), maxLat: Number(c.MAX_LAT), minLon: Number(c.MIN_LON), maxLon: Number(c.MAX_LON) },
        serviceStatus, serviceExists: serviceStatus !== 'NOT_FOUND',
        matrixFunctionExists: true, directionsFunctionExists: true,
        ready: serviceStatus === 'RUNNING' || serviceStatus === 'SUSPENDED',
        provisioned: true,
        matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`,
        labels: [c.DISPLAY_NAME || c.REGION],
      });
    }

    let mainStatus = 'NOT_FOUND';
    try {
      const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE' IN SCHEMA ${SF_DATABASE}.CORE`);
      mainStatus = rows?.[0]?.status || 'NOT_FOUND';
    } catch {}
    if (mainStatus !== 'NOT_FOUND') {
      let defaultRegion = 'DEFAULT';
      let defaultLabel = 'Default ORS';
      let defaultBounds = { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 };
      try {
        const stageRows = await runSql(`LIST @${SF_DATABASE}.CORE.ORS_SPCS_STAGE PATTERN='.*ors-config.*'`);
        const knownRegions = new Set(orsRegions.map((c: any) => (c.REGION || '').toUpperCase()));
        for (const row of stageRows || []) {
          const path = row.name || row.NAME || '';
          const match = path.match(/ors_spcs_stage\/([^/]+)\/ors-config/i);
          if (match) {
            const stageRegion = match[1];
            if (!knownRegions.has(stageRegion.toUpperCase())) {
              defaultRegion = stageRegion;
              defaultLabel = stageRegion.replace(/([a-z])([A-Z])/g, '$1 $2');
              break;
            }
          }
        }
      } catch {}
      try {
        const regionRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(defaultRegion)}'`);
        if (regionRow?.[0]) {
          defaultLabel = regionRow[0].DISPLAY_NAME || defaultLabel;
          defaultBounds = { minLat: Number(regionRow[0].MIN_LAT), maxLat: Number(regionRow[0].MAX_LAT), minLon: Number(regionRow[0].MIN_LON), maxLon: Number(regionRow[0].MAX_LON) };
        }
      } catch {}
      regions.unshift({
        region: defaultRegion, label: `${defaultLabel} (Default)`,
        bounds: defaultBounds,
        serviceStatus: mainStatus, serviceExists: true,
        matrixFunctionExists: true, directionsFunctionExists: true,
        ready: mainStatus === 'RUNNING' || mainStatus === 'SUSPENDED',
        provisioned: true,
        matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`,
        labels: [defaultLabel],
        isDefault: true,
      });
    }

    res.json({ regions });
  } catch (err: any) {
    res.json({ regions: [], error: err.message });
  }
});

async function submitSqlAsync(sql: string): Promise<string> {
  if (!IS_SPCS) {
    runSql(sql).catch((e: any) => console.error(`[Async local] Error: ${e.message}`));
    return `local_${Date.now()}`;
  }
  const token = getSpcsToken();
  const body = { statement: sql, timeout: 0, database: SF_DATABASE, warehouse: SF_WAREHOUSE };
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
    'Accept': 'application/json', 'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  console.log(`[SQL API Async] Submitting: ${sql.slice(0, 200)}`);
  const r = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements`, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await r.json();
  return result.statementHandle || '';
}

async function cancelStatement(handle: string): Promise<boolean> {
  if (!IS_SPCS || !handle || handle.startsWith('local_')) return false;
  try {
    const token = getSpcsToken();
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    };
    const r = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements/${handle}/cancel`, { method: 'POST', headers });
    return r.ok;
  } catch { return false; }
}

app.post('/api/matrix/cost-estimate', async (req, res) => {
  try {
    const { region, resolutions, profile } = req.body;
    if (!region || !resolutions) return res.status(400).json({ error: 'region and resolutions required' });

    let safeRegion: string;
    try { safeRegion = sanitizeIdentifier(region); }
    catch { return res.status(400).json({ error: 'Invalid region' }); }

    let bbox = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
    try {
      const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
      if (cityRow?.[0]) bbox = cityRow[0];
    } catch {}

    const latSpan = Math.abs(Number(bbox.MAX_LAT) - Number(bbox.MIN_LAT));
    const lonSpan = Math.abs(Number(bbox.MAX_LON) - Number(bbox.MIN_LON));
    const areaSqKm = latSpan * 111 * lonSpan * 111 * Math.cos(((Number(bbox.MIN_LAT) + Number(bbox.MAX_LAT)) / 2) * Math.PI / 180);

    const hexAreaKm2: Record<number, number> = { 5: 252.9, 6: 36.13, 7: 5.16, 8: 0.737, 9: 0.105, 10: 0.015 };
    const pairsPerSecond = 30000;
    const computePoolNodes = 10;
    const computePoolCreditPerNodeHr = 1;
    const warehouseCreditPerHr = 10;
    const flattenCredits = 2;
    const creditPriceDollars = 3;

    const estimates = (resolutions as number[]).filter((r) => r >= 5 && r <= 10).map((resolution) => {
      const hexCount = Math.ceil(areaSqKm / (hexAreaKm2[resolution] || 1));
      const totalPairs = hexCount * (hexCount - 1);
      const buildTimeSecs = totalPairs / pairsPerSecond;
      const buildTimeHrs = buildTimeSecs / 3600;

      const computePoolCredits = computePoolNodes * computePoolCreditPerNodeHr * buildTimeHrs;
      const warehouseCredits = warehouseCreditPerHr * buildTimeHrs;
      const totalCredits = computePoolCredits + warehouseCredits + flattenCredits;
      const estimatedCostDollars = totalCredits * creditPriceDollars;

      return {
        resolution: `RES${resolution}`,
        hex_count: hexCount,
        total_pairs: totalPairs,
        estimated_build_time_minutes: Math.round(buildTimeSecs / 60 * 10) / 10,
        cost_breakdown: {
          compute_pool: { nodes: computePoolNodes, credits: Math.round(computePoolCredits * 10) / 10 },
          warehouse: { type: 'X-Small x10 clusters', credits: Math.round(warehouseCredits * 10) / 10 },
          flatten: { type: 'X-Large', credits: flattenCredits },
          total_credits: Math.round(totalCredits * 10) / 10,
          estimated_cost_usd: Math.round(estimatedCostDollars * 100) / 100,
        },
      };
    });

    const totalCredits = estimates.reduce((sum, e) => sum + e.cost_breakdown.total_credits, 0);
    res.json({
      region: safeRegion,
      profile: profile || 'driving-car',
      area_sq_km: Math.round(areaSqKm),
      bbox: { min_lat: bbox.MIN_LAT, max_lat: bbox.MAX_LAT, min_lon: bbox.MIN_LON, max_lon: bbox.MAX_LON },
      resolutions: estimates,
      total_estimated_credits: Math.round(totalCredits * 10) / 10,
      total_estimated_cost_usd: Math.round(totalCredits * creditPriceDollars * 100) / 100,
      credit_price_usd: creditPriceDollars,
      note: 'Estimates based on 30K pairs/sec throughput with 10-node compute pool. Actual costs depend on ORS graph complexity, network conditions, and retry rates.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matrix/existing', async (req, res) => {
  try {
    const region = req.query.region as string;
    const profile = (req.query.profile as string) || 'driving-car';
    const safeRegion = region ? sanitizeIdentifier(region) : 'SAN_FRANCISCO';
    const safeProfile = profile.replace(/-/g, '_').toUpperCase();
    const prefix = `${safeRegion}_${safeProfile}`;
    const counts: Record<string, number> = {};
    for (const r of [5, 6, 7, 8, 9, 10]) {
      try {
        const rows = await runSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.TRAVEL_MATRIX.${prefix}_MATRIX_RES${r}`);
        const cnt = parseInt(rows?.[0]?.CNT || '0');
        if (cnt > 0) counts[`RES${r}`] = cnt;
      } catch {}
    }
    res.json(counts);
  } catch (err: any) {
    res.json({});
  }
});

app.post('/api/matrix/build', async (req, res) => {
  const { region, resolutions, profile: reqProfile } = req.body;
  if (!region || !resolutions) return res.status(400).json({ error: 'region and resolutions required' });
  const profile = reqProfile || 'driving-car';

  let safeRegion: string;
  try {
    safeRegion = sanitizeIdentifier(region);
  } catch (err: any) {
    return res.status(400).json({ error: `Invalid region: ${err.message}` });
  }
  const safeResolutions = (resolutions as number[]).filter((r) => r >= 5 && r <= 10);
  if (safeResolutions.length === 0) return res.status(400).json({ error: 'resolutions must be between 5 and 10' });
  const safeProfile = escapeString(profile);

  try {
    let bbox = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
    try {
      const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
      if (cityRow?.[0]) bbox = cityRow[0];
    } catch {}

    let matrixFn = `${SF_DATABASE}.CORE.MATRIX_TABULAR`;
    // For non-default regions, the procedure passes (region, profile, origin, dest)
    // but MATRIX_TABULAR expects (profile, origin, dest, region).
    // Use the MATRIX_TABULAR_W wrapper which corrects the argument order.
    if (safeRegion && safeRegion.toUpperCase() !== 'DEFAULT' && safeRegion.toUpperCase() !== 'SANFRANCISCO') {
      matrixFn = `${SF_DATABASE}.CORE.MATRIX_TABULAR_W`;
    }

    const jobs: { job_id: string; resolution: number }[] = [];
    const regionDb = safeRegion;

    const insertValues = safeResolutions.map((resolution, i) => {
      const jobId = `${safeRegion.toUpperCase()}_${profile.replace(/-/g, '_')}_RES${resolution}_${Date.now() + i}`.toUpperCase();
      jobs.push({ job_id: jobId, resolution });
      return `('${escapeString(jobId)}', '${escapeString(regionDb)}', '${safeProfile}', 'RES${resolution}', 'PENDING', 'NOT_STARTED')`;
    });
    await runSql(`INSERT INTO ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS (JOB_ID, REGION, PROFILE, RESOLUTION, STATUS, STAGE) VALUES ${insertValues.join(', ')}`);

    res.json({ status: 'launched', jobs });

    (async () => {
      for (const { job_id: jobId, resolution } of jobs) {
        try {
          const callSql = `CALL ${SF_DATABASE}.CORE.BUILD_MATRIX_JOB_WRAPPER('${escapeString(jobId)}', 'RES${resolution}', ${sanitizeFloat(bbox.MIN_LAT)}, ${sanitizeFloat(bbox.MAX_LAT)}, ${sanitizeFloat(bbox.MIN_LON)}, ${sanitizeFloat(bbox.MAX_LON)}, '${escapeString(matrixFn)}', '${escapeString(regionDb)}', '${safeProfile}')`;
          const handle = await submitSqlAsync(callSql);
          await runSql(`UPDATE ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET STATEMENT_HANDLE = '${escapeString(handle)}' WHERE JOB_ID = '${escapeString(jobId)}'`);
          let jobStatus = 'RUNNING';
          while (jobStatus === 'RUNNING' || jobStatus === 'PENDING') {
            await new Promise(r => setTimeout(r, 10000));
            try {
              const rows = await runSql(`SELECT STATUS FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE JOB_ID = '${escapeString(jobId)}'`);
              jobStatus = rows?.[0]?.STATUS || 'UNKNOWN';
            } catch { break; }
          }
        } catch (e: any) {
          console.error(`[matrix/build] async launch error for ${jobId}: ${e.message}`);
        }
      }
    })().catch(() => {});
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matrix/status', async (req, res) => {
  try {
    let jobs: any[] = [];
    try {
      const rows = await runSql(
        `SELECT JOB_ID, REGION, PROFILE, RESOLUTION, STATUS, STAGE,
                HEXAGONS, WORK_QUEUE_ROWS, RAW_ROWS, MATRIX_ROWS,
                PCT_COMPLETE, ERROR_MSG, STATEMENT_HANDLE,
                CREATED_AT, STARTED_AT, COMPLETED_AT
         FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
         ORDER BY CREATED_AT DESC LIMIT 50`
      );
      jobs = (rows || []).map((r: any) => ({
        job_id: r.JOB_ID,
        region: r.REGION,
        profile: r.PROFILE,
        resolution: r.RESOLUTION,
        status: r.STATUS,
        stage: r.STAGE,
        hexagons: Number(r.HEXAGONS) || 0,
        work_queue_rows: Number(r.WORK_QUEUE_ROWS) || 0,
        raw_rows: Number(r.RAW_ROWS) || 0,
        matrix_rows: Number(r.MATRIX_ROWS) || 0,
        pct_complete: Number(r.PCT_COMPLETE) || 0,
        error_msg: r.ERROR_MSG,
        statement_handle: r.STATEMENT_HANDLE,
        created_at: r.CREATED_AT,
        started_at: r.STARTED_AT,
        completed_at: r.COMPLETED_AT,
      }));
    } catch {}
    res.json({ jobs });
  } catch (err: any) {
    res.json({ jobs: [], error: err.message });
  }
});

app.get('/api/matrix/inventory', async (_req, res) => {
  try {
    let inventory: any[] = [];
    try {
      const rows = await runSql(
        `SELECT TABLE_NAME, ROW_COUNT, BYTES, CREATED
         FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX'
           AND TABLE_NAME LIKE '%_MATRIX_RES%'
         ORDER BY CREATED DESC`
      );
      inventory = (rows || []).map((t: any) => {
        const name = (t.TABLE_NAME || '').toUpperCase();
        const parts = name.match(/^(.+)_(DRIVING_CAR|DRIVING_HGV|CYCLING_ROAD|CYCLING_REGULAR|CYCLING_ELECTRIC|FOOT_WALKING|FOOT_HIKING|WHEELCHAIR)_(RES\d+)$/);
        let region = name, profileName = 'driving-car', resolution = 'RES7';
        if (parts) {
          region = parts[1].replace(/_/g, '').toLowerCase();
          // Capitalise first letter to match region name format
          region = region.charAt(0).toUpperCase() + region.slice(1);
          profileName = parts[2].toLowerCase().replace(/_/g, '-');
          resolution = parts[3];
        }
        return { region, profile: profileName, resolution, row_count: parseInt(t.ROW_COUNT || '0'), bytes: parseInt(t.BYTES || '0'), created: t.CREATED || '', table_name: name, execution_time_secs: 0 };
      }).filter(Boolean);
    } catch {}
    res.json({ inventory });
  } catch (err: any) {
    res.json({ inventory: [], error: err.message });
  }
});

app.delete('/api/matrix/:region/:profile/:resolution', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const safeProfile = escapeString(req.params.profile);
    const safeRes = sanitizeIdentifier(req.params.resolution);
    const tablePrefix = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion}_${safeProfile.toUpperCase().replace(/-/g,'_')}_`;
    const tables = [`${tablePrefix}MATRIX_${safeRes}`, `${tablePrefix}MATRIX_RAW_${safeRes}`, `${tablePrefix}WORK_QUEUE_${safeRes}`, `${tablePrefix}LIST_${safeRes}`];
    for (const t of tables) {
      try { await runSql(`DROP TABLE IF EXISTS ${t}`); } catch {}
    }
    await runSql(`DELETE FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE REGION = '${escapeString(req.params.region)}' AND PROFILE = '${safeProfile}' AND RESOLUTION = '${escapeString(safeRes)}'`);
    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matrix/:region/:profile/:resolution/restore', async (req, res) => {
  try {
    const safeRegion = sanitizeIdentifier(req.params.region);
    const safeProfile = escapeString(req.params.profile);
    const safeRes = sanitizeIdentifier(req.params.resolution);
    const offsetSecs = sanitizeInt(req.body.offset_seconds || 300);
    const result = await callProcedure(`RESTORE_MATRIX_DATA('${safeRegion}', '${safeProfile}', '${safeRes}', ${offsetSecs})`);
    const parsed = JSON.parse(result || '{}');
    res.json(parsed);
  } catch (err: any) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.post('/api/matrix/cancel', async (req, res) => {
  try {
    const { job_id } = req.body;
    if (!job_id) return res.status(400).json({ error: 'job_id required' });
    const result = await callProcedure(`CANCEL_MATRIX_BUILD('${escapeString(job_id)}')`);
    const parsed = JSON.parse(result || '{}');
    if (parsed.statement_handle) {
      await cancelStatement(parsed.statement_handle);
    }
    res.json({ status: 'cancelled', result: parsed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const VIEWER_PROFILE_PATTERNS = ['DRIVING_CAR', 'DRIVING_HGV', 'CYCLING_REGULAR', 'CYCLING_ROAD', 'CYCLING_MOUNTAIN', 'CYCLING_ELECTRIC', 'FOOT_WALKING', 'FOOT_HIKING', 'WHEELCHAIR'];

function parseViewerTableName(name: string): { region: string; profile: string; resolution: string } | null {
  for (const profile of VIEWER_PROFILE_PATTERNS) {
    const pattern = new RegExp(`^(.+?)_${profile}_MATRIX_(RES\\d+)$`);
    const match = name.match(pattern);
    if (match) {
      return { region: match[1], profile: profile.toLowerCase().replace(/_/g, '-'), resolution: match[2] };
    }
  }
  return null;
}

let viewerInventoryCache: { tables: any[]; ts: number } = { tables: [], ts: 0 };
const VIEWER_CACHE_TTL = 60000;

async function getViewerInventory(): Promise<any[]> {
  if (Date.now() - viewerInventoryCache.ts < VIEWER_CACHE_TTL && viewerInventoryCache.tables.length > 0) {
    return viewerInventoryCache.tables;
  }
  const rows = await runSql(`
    SELECT TABLE_NAME, ROW_COUNT, BYTES
    FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX'
      AND TABLE_NAME LIKE '%\\_MATRIX\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_MATRIX\\_RAW\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_LIST\\_%' ESCAPE '\\\\'
      AND TABLE_NAME NOT LIKE '%\\_WORK\\_QUEUE\\_%' ESCAPE '\\\\'
      AND TABLE_NAME != 'MATRIX_BUILD_JOBS'
    ORDER BY TABLE_NAME
  `);
  const tables = rows.map((r: any) => {
    const parsed = parseViewerTableName(r.TABLE_NAME);
    if (!parsed) return null;
    return {
      ...parsed,
      row_count: parseInt(r.ROW_COUNT || '0'),
      bytes: parseInt(r.BYTES || '0'),
      table_name: r.TABLE_NAME,
      full_table: `${SF_DATABASE}.TRAVEL_MATRIX.${r.TABLE_NAME}`,
    };
  }).filter(Boolean);
  viewerInventoryCache = { tables, ts: Date.now() };
  return tables;
}

function validateViewerTable(tableName: string): string | null {
  const tables = viewerInventoryCache.tables;
  const found = tables.find((t: any) => t.full_table === tableName || t.table_name === tableName);
  if (found) return found.full_table;
  if (/^[A-Z0-9_]+\.[A-Z0-9_]+\.[A-Z0-9_]+$/i.test(tableName)) {
    const parsed = parseViewerTableName(tableName.split('.').pop()!);
    if (parsed) return tableName;
  }
  return null;
}

app.get('/api/matrix/viewer-inventory', async (_req, res) => {
  try {
    const tables = await getViewerInventory();
    res.json({ tables });
  } catch (err: any) {
    res.json({ tables: [], error: err.message });
  }
});

app.get('/api/matrix/random-origin', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    if (!tableParam) return res.status(400).json({ error: 'table parameter required' });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const [[originRow], [maxRow]] = await Promise.all([
      runSql(`SELECT ORIGIN_H3 FROM (SELECT ORIGIN_H3, COUNT(*) AS CNT FROM ${table} GROUP BY ORIGIN_H3 ORDER BY CNT DESC LIMIT 10) ORDER BY RANDOM() LIMIT 1`),
      runSql(`SELECT MAX(TRAVEL_TIME_SECONDS) AS GLOBAL_MAX FROM ${table}`),
    ]);
    const hex = originRow?.ORIGIN_H3;
    if (!hex) return res.json({ error: 'No data in table' });
    const latLon = await runSql(
      `SELECT ST_Y(H3_CELL_TO_POINT('${hex}')) AS LAT, ST_X(H3_CELL_TO_POINT('${hex}')) AS LON`
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
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const rows = await runSql(`SELECT DISTINCT ORIGIN_H3 AS HEX_ID FROM ${table}`);
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
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const safeOrigin = origin.replace(/[^a-fA-F0-9]/g, '');
    const maxTimeSecs = req.query.max_time ? Number(req.query.max_time) : null;
    const timeFilter = maxTimeSecs ? `AND TRAVEL_TIME_SECONDS <= ${maxTimeSecs}` : '';
    const rows = await runSql(`
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
    `);
    const originLatLon = await runSql(
      `SELECT ST_Y(H3_CELL_TO_POINT('${safeOrigin}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safeOrigin}')) AS LON`
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

app.get('/api/matrix/ring-stats', async (req, res) => {
  try {
    const tableParam = req.query.table as string;
    const origin = req.query.origin as string;
    if (!tableParam || !origin) return res.status(400).json({ error: 'table and origin required' });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return res.status(400).json({ error: 'Invalid table name' });
    const safeOrigin = origin.replace(/[^a-fA-F0-9]/g, '');
    const rows = await runSql(`
      SELECT
        H3_GRID_DISTANCE('${safeOrigin}', DEST_H3) AS RING,
        COUNT(*) AS HEX_COUNT,
        ROUND(MIN(TRAVEL_TIME_SECONDS) / 60, 1) AS MIN_MINS,
        ROUND(AVG(TRAVEL_TIME_SECONDS) / 60, 1) AS AVG_MINS,
        ROUND(MAX(TRAVEL_TIME_SECONDS) / 60, 1) AS MAX_MINS,
        ROUND(AVG(TRAVEL_DISTANCE_METERS) / 1000, 2) AS AVG_KM
      FROM ${table}
      WHERE ORIGIN_H3 = '${safeOrigin}'
      GROUP BY RING
      HAVING RING IS NOT NULL
      ORDER BY RING
    `);
    res.json({ rings: rows });
  } catch (err: any) {
    console.error('Ring-stats error:', err.message);
    res.json({ rings: [] });
  }
});

app.get('/api/regions', async (_req, res) => {
  try {
    let regions: any[] = [];
    try {
      regions = await runSql(
        `SELECT REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON,
                BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON,
                ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE, IS_DEFAULT
         FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
         ORDER BY IS_DEFAULT DESC, PROVISIONED_AT`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
    } catch {}
    const knownNames = new Set(regions.map((r: any) => r.REGION_NAME));
    try {
      const orsMapRows = await runSql(`SELECT REGION, DISPLAY_NAME, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP`);
      for (const row of orsMapRows || []) {
        if (row.REGION && !knownNames.has(row.REGION)) {
          const centerLat = ((row.MIN_LAT || 0) + (row.MAX_LAT || 0)) / 2;
          const centerLon = ((row.MIN_LON || 0) + (row.MAX_LON || 0)) / 2;
          regions.push({
            REGION_NAME: row.REGION,
            DISPLAY_NAME: row.DISPLAY_NAME || row.REGION,
            CENTER_LAT: centerLat, CENTER_LON: centerLon,
            BBOX_MIN_LAT: row.MIN_LAT, BBOX_MAX_LAT: row.MAX_LAT,
            BBOX_MIN_LON: row.MIN_LON, BBOX_MAX_LON: row.MAX_LON,
            ZOOM_LEVEL: 11, ORS_REGION_KEY: row.REGION,
            DATA_SOURCE: 'ORS_REGION', IS_DEFAULT: false,
          });
          knownNames.add(row.REGION);
        }
      }
      // Also include the default ORS stage region (e.g. SanFrancisco) if not already listed
      try {
        const stageRows = await runSql(`LIST @${SF_DATABASE}.CORE.ORS_SPCS_STAGE PATTERN='.*ors-config.*'`);
        for (const row of stageRows || []) {
          const path = row.name || row.NAME || '';
          const match = path.match(/ors_spcs_stage\/([^/]+)\/ors-config/i);
          if (match) {
            const stageRegion = match[1];
            if (!knownNames.has(stageRegion)) {
              const mapRow = (await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(stageRegion)}'`).catch(() => []))?.[0];
              regions.unshift({
                REGION_NAME: stageRegion,
                DISPLAY_NAME: mapRow?.DISPLAY_NAME || stageRegion,
                CENTER_LAT: mapRow ? ((mapRow.MIN_LAT || 0) + (mapRow.MAX_LAT || 0)) / 2 : 37.7749,
                CENTER_LON: mapRow ? ((mapRow.MIN_LON || 0) + (mapRow.MAX_LON || 0)) / 2 : -122.4194,
                BBOX_MIN_LAT: mapRow?.MIN_LAT ?? 37.700, BBOX_MAX_LAT: mapRow?.MAX_LAT ?? 37.820,
                BBOX_MIN_LON: mapRow?.MIN_LON ?? -122.520, BBOX_MAX_LON: mapRow?.MAX_LON ?? -122.350,
                ZOOM_LEVEL: 11, ORS_REGION_KEY: stageRegion,
                DATA_SOURCE: 'ORS_DEFAULT', IS_DEFAULT: true,
              });
              knownNames.add(stageRegion);
            }
          }
        }
      } catch {}
    } catch {}
    try {
      const synthRows = await runSql('SELECT DISTINCT REGION FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY');
      for (const row of synthRows) {
        if (row.REGION && !knownNames.has(row.REGION)) {
          regions.push({
            REGION_NAME: row.REGION,
            DISPLAY_NAME: row.REGION.replace(/([A-Z])/g, ' $1').trim(),
            CENTER_LAT: 0, CENTER_LON: 0,
            BBOX_MIN_LAT: null, BBOX_MAX_LAT: null, BBOX_MIN_LON: null, BBOX_MAX_LON: null,
            ZOOM_LEVEL: 11, ORS_REGION_KEY: null,
            DATA_SOURCE: 'SYNTHETIC', IS_DEFAULT: false,
          });
        }
      }
    } catch {}
    if (regions.length === 0) {
      regions = [{
        REGION_NAME: 'SanFrancisco',
        DISPLAY_NAME: 'San Francisco',
        CENTER_LAT: 37.7749, CENTER_LON: -122.4194,
        BBOX_MIN_LAT: 37.700, BBOX_MAX_LAT: 37.820, BBOX_MIN_LON: -122.520, BBOX_MAX_LON: -122.350,
        ZOOM_LEVEL: 11, ORS_REGION_KEY: 'SanFrancisco',
        DATA_SOURCE: 'S3_BASELINE', IS_DEFAULT: true,
      }];
    }
    const defaultActive = regions.find((r: any) => r.IS_DEFAULT === true || r.IS_DEFAULT === 'true')?.REGION_NAME || regions[0]?.REGION_NAME || 'SanFrancisco';
    const active = activeRegionOverride && regions.find((r: any) => r.REGION_NAME === activeRegionOverride) ? activeRegionOverride : defaultActive;
    res.json({ regions, active });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/regions/active', async (_req, res) => {
  try {
    const rows = await runSql(
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
    try {
      await runSql(
        `CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${region.replace(/'/g, "''")}')`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
    } catch (e: any) {
      log('WARN', 'Region', `SET_ACTIVE_REGION not available: ${e.message?.slice(0, 100)}`);
    }
    activeRegionOverride = region;
    const safeRegion = escapeString(region);
    const CONFIG_SCHEMAS = [
      'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
      'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
      'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
      'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
      'FLEET_INTELLIGENCE.RETAIL_CATCHMENT',
      'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
    ];
    for (const schema of CONFIG_SCHEMAS) {
      try {
        await runSql(`UPDATE ${schema}.CONFIG SET REGION = '${safeRegion}'`);
      } catch (e: any) {
        log('WARN', 'CONFIG', `Failed to update ${schema}.CONFIG region: ${e.message}`);
      }
    }
    res.json({ ok: true, region });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
    params: ['jobs_description', 'num_vehicles', 'profile'],
  },
  tool_pharma_demo: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION',
    params: ['profile'],
  },
  tool_pharma_catchment: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT',
    params: ['pharmacy_description', 'range_minutes', 'profile'],
  },
  tool_supply_chain: {
    identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN',
    params: ['profile'],
  },
  tool_poi: {
    identifier: '__local__',
    params: ['location_description', 'category', 'range_minutes', 'profile'],
  },
};

const POI_CATEGORY_MAP: Record<string, string[]> = {
  restaurant: ['restaurant', 'fast_food_restaurant', 'casual_eatery', 'fine_dining_restaurant', 'pizzaria', 'chicken_restaurant', 'sandwich_shop', 'sushi_restaurant', 'seafood_restaurant', 'steak_house', 'burger_restaurant'],
  cafe: ['cafe', 'coffee_shop', 'bakery', 'tea_house'],
  bar: ['bar', 'pub', 'nightclub', 'lounge'],
  hotel: ['hotel', 'motel', 'hostel', 'bed_and_breakfast'],
  shop: ['shopping_mall', 'convenience_store', 'supermarket', 'department_store', 'clothing_store'],
  hospital: ['hospital', 'medical_clinic', 'pharmacy', 'dentist'],
  school: ['school', 'university', 'college', 'kindergarten'],
  park: ['park', 'playground', 'sports_complex', 'golf_course'],
  gas_station: ['gas_station', 'charging_station'],
  parking: ['parking', 'parking_garage'],
};

async function executeToolPoi(input: Record<string, any>): Promise<any> {
  const { location_description, category, range_minutes, profile } = input;
  const cats = POI_CATEGORY_MAP[String(category || 'restaurant').toLowerCase()] || POI_CATEGORY_MAP['restaurant'];
  const isoResult = await executeToolLocally('tool_isochrone', { location_description, range_minutes: range_minutes ?? 10, profile });
  if (isoResult?.status === 'FAILED' || isoResult?.error) return isoResult;
  const geometry = isoResult?.geometry;
  if (!geometry) return { error: 'Isochrone returned no geometry', status: 'FAILED' };
  const catFilter = cats.map((c: string) => `'${c}'`).join(',');
  const geojsonStr = JSON.stringify(geometry).replace(/'/g, "''");
  const sql = `
    SELECT NAMES::VARIANT:primary::STRING AS NAME,
           BASIC_CATEGORY AS CATEGORY,
           ST_Y(GEOMETRY) AS LAT,
           ST_X(GEOMETRY) AS LNG
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
    WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('${geojsonStr}'))
      AND BASIC_CATEGORY IN (${catFilter})
    LIMIT 200`;
  try {
    const rows = await runSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
    const poi_list = (rows || []).map((r: any) => ({
      name: r.NAME || 'Unknown',
      category: r.CATEGORY || category,
      lat: Number(r.LAT),
      lng: Number(r.LNG),
    }));
    return { ...isoResult, poi_list, poi_count: poi_list.length };
  } catch (e: any) {
    return { ...isoResult, poi_list: [], poi_count: 0, poi_error: e.message?.slice(0, 200) };
  }
}

const FLEET_CONFIG_SCHEMAS = [
  'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
  'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
  'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
  'FLEET_INTELLIGENCE.RETAIL_CATCHMENT',
  'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION',
];

app.get('/api/fleet-config', async (_req, res) => {
  try {
    let vehicleType = 'ebike';
    let region = 'SanFrancisco';
    try {
      const rows = await runSql('SELECT VEHICLE_TYPE, REGION FROM FLEET_INTELLIGENCE.DWELL_ANALYSIS.CONFIG LIMIT 1');
      if (rows?.[0]) {
        vehicleType = rows[0].VEHICLE_TYPE || vehicleType;
        region = rows[0].REGION || region;
      }
    } catch {}
    let availableTypes: string[] = [];
    try {
      const rows = await runSql('SELECT DISTINCT VEHICLE_TYPE FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY ORDER BY VEHICLE_TYPE');
      availableTypes = rows.map((r: any) => r.VEHICLE_TYPE).filter(Boolean);
    } catch {}
    if (vehicleType && !availableTypes.includes(vehicleType)) availableTypes.push(vehicleType);
    if (availableTypes.length === 0) availableTypes = [vehicleType];
    res.json({ vehicleType, region, availableTypes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fleet-config/vehicle-type', async (req, res) => {
  try {
    const { vehicleType } = req.body;
    if (!vehicleType) return res.status(400).json({ error: 'vehicleType required' });
    const safeType = escapeString(vehicleType);
    for (const schema of FLEET_CONFIG_SCHEMAS) {
      try {
        await runSql(`UPDATE ${schema}.CONFIG SET VEHICLE_TYPE = '${safeType}'`);
      } catch (e: any) {
        log('WARN', 'CONFIG', `Failed to update ${schema}.CONFIG vehicleType: ${e.message}`);
      }
    }
    res.json({ ok: true, vehicleType });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const ROUTING_SYSTEM_PROMPT = `You are a routing agent powered by OpenRouteService. You help users with:
1. Driving/cycling/walking directions between locations
2. Reachability analysis (isochrones) - areas reachable within X minutes
3. Multi-stop delivery route optimization
4. Finding points of interest (restaurants, cafes, bars, hotels, shops, etc.) within a reachable area

You have access to four tools. To call a tool, respond with EXACTLY this JSON format and NOTHING else:
{"tool_call": {"name": "TOOL_NAME", "input": {PARAMS}}}

Available tools:
1. tool_directions - Get directions between locations
   Input: {"locations_description": "string describing start/end/waypoints (required)", "profile": "string (default: driving-car)"}
2. tool_isochrone - Get area reachable within specified minutes from a location
   Input: {"location_description": "string describing the center location (required)", "range_minutes": number (required), "profile": "string (default: driving-car)"}
3. tool_optimization - Optimize delivery/pickup routes for multiple stops with one or more vehicles
   Input: {"jobs_description": "string describing all delivery/pickup locations including the depot/start address (required)", "num_vehicles": number (default: 1), "profile": "string (default: driving-car)"}
4. tool_optimization - Optimize delivery/pickup routes for multiple stops with one or more vehicles
   Input: {"jobs_description": "string describing all delivery/pickup locations including the depot/start address (required)", "num_vehicles": number (default: 1), "profile": "string (default: driving-car)"}
5. tool_pharma_demo - Run a pre-built SF pharmaceutical delivery demo with 30 stops across 3 specialist vehicles (cold chain, controlled substances, standard medicines). Use when user asks for the pharma demo, SF drug delivery demo, or pharmaceutical fleet example.
   Input: {"profile": "string (default: driving-car)"}
   Input: {"location_description": "string describing the center location (required)", "category": "one of: restaurant, cafe, bar, hotel, shop, hospital, school, park, gas_station, parking (required)", "range_minutes": number (required), "profile": "string (default: driving-car)"}

Transport profiles available: driving-car, cycling-electric (use for ANY cycling/bike request), driving-hgv (trucks only)

7. tool_supply_chain - Run a full pharmaceutical supply chain optimisation. Loads 6 SF pharmacies, computes drug demand from population health data (diabetes, hypertension, cardiovascular, respiratory, mobility), generates delivery jobs with VROOM skills, and optimises routes for 3 specialist vehicles (cold chain, controlled, standard). Use when asked to plan supply chain, generate delivery plan, or optimise pharmaceutical logistics.
   Input: {"profile": "string (default: driving-car)"}

CRITICAL RULES:
1. ALWAYS call the appropriate tool for ANY routing question. NEVER answer from general knowledge.
2. When you need to call a tool, respond ONLY with the JSON tool_call object. No other text.
3. After receiving tool results, format them clearly: distances in km, durations in minutes.
4. If a tool returns an error, report it clearly. Do NOT retry with a different profile.
5. NEVER fabricate routing data.
6. tool_pharma_catchment - Analyse the health demographics of the population within a pharmacy catchment area. Shows isochrone + population morbidity profile (diabetes, hypertension, cardiovascular, respiratory, mobility issues, accessibility). Use when asked about pharmacy catchment, patient population, health demographics, morbidity analysis, or population accessibility.
   Input: {"pharmacy_description": "string describing pharmacy name/address (required)", "range_minutes": number (default: 10), "profile": "string (default: driving-car)"}
7. ONLY use these exact profile strings: driving-car, cycling-electric, driving-hgv. Never use cycling-regular, cycling-road, foot-walking or any other variant.`;

const AGENT_PROFILE_ALIASES: Record<string, string> = {
  'bike': 'cycling-electric', 'bicycle': 'cycling-electric', 'cycling': 'cycling-electric',
  'cycle': 'cycling-electric', 'cycling-regular': 'cycling-electric', 'cycling-road': 'cycling-electric',
  'cycling-mountain': 'cycling-electric', 'foot-walking': 'driving-car', 'walk': 'driving-car',
  'walking': 'driving-car', 'foot': 'driving-car', 'car': 'driving-car',
  'drive': 'driving-car', 'driving': 'driving-car', 'truck': 'driving-hgv', 'hgv': 'driving-hgv',
};
const AGENT_VALID_PROFILES = new Set(['driving-car', 'driving-hgv', 'cycling-electric']);

function normalizeAgentProfile(profile: string | undefined): string {
  if (!profile) return 'driving-car';
  const lower = profile.toLowerCase().trim();
  if (AGENT_VALID_PROFILES.has(lower)) return lower;
  return AGENT_PROFILE_ALIASES[lower] || 'driving-car';
}

function escAgentSql(val: any): string {
  if (val === undefined || val === null) return "''";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

async function executeToolLocally(toolName: string, input: Record<string, any>): Promise<any> {
  if (toolName === 'tool_poi') return executeToolPoi(input);
  const mapping = TOOL_PROCEDURE_MAP[toolName];
  if (!mapping || mapping.identifier === '__local__') return { error: `Unknown tool: ${toolName}`, status: 'FAILED' };
  const args = mapping.params.map(p => {
    let val = input[p];
    if (p === 'profile') val = normalizeAgentProfile(val as string);
    if (val === undefined || val === null) return 'DEFAULT';
    if (typeof val === 'number') return String(val);
    return escAgentSql(val);
  });
  const sql = `CALL ${mapping.identifier}(${args.join(', ')})`;
  try {
    const rows = await runSql(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
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
    return { error: `Tool execution failed: ${err.message}`, status: 'FAILED' };
  }
}

function escAgentSqlStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, ' ');
}

const AGENT_MODELS = ['claude-sonnet-4-5', 'mistral-large2'];
let agentModel = AGENT_MODELS[0];

async function callCortexCompleteStreaming(
  messages: Array<{role: string; content: string}>,
  onToken: (text: string) => void,
): Promise<string> {
  const token = getSpcsToken();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  const body = JSON.stringify({
    model: agentModel,
    messages,
    stream: true,
    max_tokens: 4096,
    temperature: 0,
  });
  const url = `https://${SNOWFLAKE_HOST}/api/v2/cortex/inference:complete`;
  console.log(`[Agent] Streaming AI_COMPLETE model=${agentModel}, msgCount=${messages.length}`);
  const startMs = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cortex streaming API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No readable body from Cortex streaming response');
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const text = parsed.choices?.[0]?.delta?.content || '';
        if (text) { fullText += text; onToken(text); }
      } catch {}
    }
  }
  console.log(`[Agent] Streaming completed in ${Date.now() - startMs}ms, length=${fullText.length}`);
  if (!fullText) throw new Error('Cortex streaming returned empty response');
  return fullText;
}

async function callCortexComplete(messages: Array<{role: string; content: string}>): Promise<string> {
  const msgArray = messages.map(m => {
    return `{'role':'${m.role}','content':'${escAgentSqlStr(m.content)}'}`;
  }).join(',');
  const sql = `SELECT AI_COMPLETE('${agentModel}', [${msgArray}], {'max_tokens':4096,'temperature':0}) as RESPONSE`;
  console.log(`[Agent] Calling AI_COMPLETE with model=${agentModel}, msgCount=${messages.length}, sqlLen=${sql.length}`);
  const startMs = Date.now();
  let rows: any[];
  try {
    rows = await runSql(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
  } catch (err: any) {
    console.error(`[Agent] AI_COMPLETE failed (${Date.now() - startMs}ms): ${err.message}`);
    if (agentModel === AGENT_MODELS[0] && AGENT_MODELS.length > 1) {
      console.log(`[Agent] Retrying with fallback model ${AGENT_MODELS[1]}`);
      agentModel = AGENT_MODELS[1];
      const retrySql = sql.replace(AGENT_MODELS[0], agentModel);
      rows = await runSql(retrySql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
    } else {
      throw err;
    }
  }
  console.log(`[Agent] AI_COMPLETE returned in ${Date.now() - startMs}ms`);
  if (!rows || rows.length === 0) throw new Error('No response from AI_COMPLETE');
  const raw = rows[0].RESPONSE || rows[0][Object.keys(rows[0])[0]] || '';
  let content = '';
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (typeof parsed === 'string') {
      content = parsed;
    } else {
      content = parsed.choices?.[0]?.messages || parsed.choices?.[0]?.message?.content || parsed.message || '';
    }
  } catch {
    content = String(raw);
  }
  if (!content && typeof raw === 'string') {
    content = raw;
  }
  if (!content) {
    console.error(`[Agent] Empty content from AI_COMPLETE. Raw: ${JSON.stringify(raw).slice(0, 500)}`);
    throw new Error('Empty response from LLM');
  }
  return content.trim();
}

function findMatchingBrace(s: string): number {
  let depth = 0; let inStr = false; let esc = false;
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

function estimateMessagesTokens(messages: Array<{role: string; content: string}>): number {
  return messages.reduce((acc, m) => acc + estimateTokens(m.content) + 4, 0);
}

const CONTEXT_TOKEN_LIMIT = 8000;
const SUMMARY_MAX_TOKENS = 500;

async function summariseOlderMessages(messages: Array<{role: string; content: string}>): Promise<Array<{role: string; content: string}>> {
  if (messages.length <= 3) return messages;
  const systemMsg = messages[0];
  const recentMessages = messages.slice(-3);
  const olderMessages = messages.slice(1, -3);
  if (olderMessages.length === 0) return messages;
  const olderText = olderMessages.map(m => `${m.role}: ${m.content.slice(0, 500)}`).join('\n');
  const summaryPrompt = `Summarise this conversation history in under 200 words. Focus on key facts, tool results, and decisions made. Do not include greetings or filler.\n\n${olderText}`;
  try {
    const summaryContent = await callCortexComplete([
      { role: 'system', content: 'You summarise conversations concisely.' },
      { role: 'user', content: summaryPrompt },
    ]);
    console.log(`[Agent] Context summarised: ${olderMessages.length} messages -> ${estimateTokens(summaryContent)} tokens`);
    return [
      systemMsg,
      { role: 'user', content: `[Previous conversation summary]: ${summaryContent}` },
      ...recentMessages,
    ];
  } catch (e: any) {
    console.warn(`[Agent] Summarisation failed: ${e.message}`);
    return messages;
  }
}

async function callCortexAgentWithToolLoop(
  message: string, threadId?: string, parentMessageId?: string,
  onProgress?: (data: { step: string; detail?: string }) => void,
  onToken?: (text: string) => void,
  history?: Array<{role: string; content: string}>,
): Promise<any> {
  if (!IS_SPCS) throw new Error('Cortex Agent is only available in SPCS mode');
  console.log(`[Agent] Starting tool loop for: "${message.slice(0, 100)}" (history: ${history?.length || 0} msgs)`);
  let messages: Array<{role: string; content: string}> = [
    { role: 'system', content: ROUTING_SYSTEM_PROMPT },
  ];
  if (history && history.length > 0) {
    for (const h of history) {
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: (h.content || '').slice(0, 2000) });
      }
    }
  }
  messages.push({ role: 'user', content: message });
  const maxIterations = 5;
  const allToolResults: any[] = [];
  let toolsExecuted = false;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let wasSummarised = false;
  let summaryText = '';
  let messagesSummarisedCount = 0;
  let messagesRawCount = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    const contextTokens = estimateMessagesTokens(messages);
    if (contextTokens > CONTEXT_TOKEN_LIMIT && messages.length > 3) {
      onProgress?.({ step: 'formatting', detail: 'Summarising context...' });
      messagesSummarisedCount = messages.length - 4;
      messages = await summariseOlderMessages(messages);
      wasSummarised = true;
      const summaryMsg = messages.find(m => m.content.startsWith('[Previous conversation summary]'));
      if (summaryMsg) summaryText = summaryMsg.content.replace('[Previous conversation summary]: ', '');
    }
    messagesRawCount = messages.length - 1;
    totalPromptTokens += estimateMessagesTokens(messages);
    onProgress?.({ step: 'calling_llm', detail: iter === 0 ? 'Thinking...' : `Processing (step ${iter + 1})` });

    if (toolsExecuted && onToken) {
      onProgress?.({ step: 'formatting', detail: 'Generating response...' });
      try {
        const streamedText = await callCortexCompleteStreaming(messages, onToken);
        totalCompletionTokens += estimateTokens(streamedText);
        return { role: 'assistant', content: [{ type: 'text', text: streamedText }], _toolResults: allToolResults, _tokenUsage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens, total_tokens: totalPromptTokens + totalCompletionTokens, summarised: wasSummarised, summary_text: summaryText, messages_summarised: messagesSummarisedCount, messages_raw: messagesRawCount } };
      } catch (streamErr: any) {
        console.warn(`[Agent] Streaming failed, falling back to blocking: ${streamErr.message}`);
        const fallback = await callCortexComplete(messages);
        totalCompletionTokens += estimateTokens(fallback);
        onToken(fallback);
        return { role: 'assistant', content: [{ type: 'text', text: fallback }], _toolResults: allToolResults, _tokenUsage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens, total_tokens: totalPromptTokens + totalCompletionTokens, summarised: wasSummarised, summary_text: summaryText, messages_summarised: messagesSummarisedCount, messages_raw: messagesRawCount } };
      }
    }

    const response = await callCortexComplete(messages);
    totalCompletionTokens += estimateTokens(response);
    console.log(`[Agent] LLM response (iter ${iter}): ${response.slice(0, 200)}`);
    const toolCall = parseToolCall(response);

    if (!toolCall) {
      console.log(`[Agent] No tool call found, returning text response`);
      if (onToken) onToken(response);
      return { role: 'assistant', content: [{ type: 'text', text: response }], _toolResults: allToolResults, _tokenUsage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens, total_tokens: totalPromptTokens + totalCompletionTokens, summarised: wasSummarised, summary_text: summaryText, messages_summarised: messagesSummarisedCount, messages_raw: messagesRawCount } };
    }

    const toolLabel = toolCall.name.replace('tool_', '');
    onProgress?.({ step: 'executing_tool', detail: toolLabel });
    console.log(`[Agent] Executing tool: ${toolCall.name}`);
    messages.push({ role: 'assistant', content: response });
    const toolResult = await executeToolLocally(toolCall.name, toolCall.input);
    allToolResults.push(toolResult);
    toolsExecuted = true;
    const resultStr = JSON.stringify(toolResult).slice(0, 30000);
    messages.push({ role: 'user', content: `Tool result from ${toolCall.name}:\n${resultStr}\n\nNow provide your final answer based on this data. Format distances in km and durations in minutes. Be concise.` });
  }
  return { role: 'assistant', content: [{ type: 'text', text: 'I was unable to complete the request after multiple attempts.' }], _toolResults: allToolResults, _tokenUsage: { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens, total_tokens: totalPromptTokens + totalCompletionTokens, summarised: wasSummarised, summary_text: summaryText, messages_summarised: messagesSummarisedCount, messages_raw: messagesRawCount } };
}

function sendSseEvent(res: any, event: string, data: any) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post('/api/agent/chat', async (req, res) => {
  const { message, history, thread_id, parent_message_id } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  try {
    const onProgress = (data: { step: string; detail?: string }) => { sendSseEvent(res, 'progress', data); };
    const onToken = (text: string) => { res.write(`event: token\ndata: ${JSON.stringify({ text })}\n\n`); };
    const agentResult = await callCortexAgentWithToolLoop(message, thread_id, parent_message_id, onProgress, onToken, history);
    const content = agentResult?.content || [];
    let msg = '';
    let geometry: any = null;
    const toolResults: any[] = agentResult?._toolResults || [];
    for (const item of content) { if (item.type === 'text') msg += (msg ? '\n' : '') + item.text; }
    for (const tr of toolResults) { if (tr && typeof tr === 'object' && tr.geometry && !geometry) geometry = tr.geometry; }
    if (!msg) msg = agentResult?.message || 'No response from agent';
    const response: any = { message: msg, tool_results: toolResults };
    if (geometry) response.geometry = geometry;
    if (agentResult?.metadata?.thread_id) response.thread_id = agentResult.metadata.thread_id;
    if (agentResult?.metadata?.message_id) response.message_id = agentResult.metadata.message_id;
    if (agentResult?._tokenUsage) response.token_usage = agentResult._tokenUsage;
    sendSseEvent(res, 'result', response);
    res.end();
  } catch (err: any) {
    console.error(`[Agent] Chat endpoint error: ${err.message}`);
    sendSseEvent(res, 'error', { error: err.message || 'Unknown agent error' });
    res.end();
  }
});

app.get('/api/diagnostics/logs', (_req, res) => {
  const { level, tag, jobId, since, limit } = _req.query;
  const entries = getEntries({
    level: level as any,
    tag: tag as string,
    jobId: jobId as string,
    since: since as string,
    limit: limit ? Number(limit) : undefined,
  });
  res.json({ entries, total: entries.length });
});

app.get('/api/diagnostics/env', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    version: APP_VERSION,
    uptimeMs: getUptimeMs(),
    uptime: formatUptime(getUptimeMs()),
    isSpcs: IS_SPCS,
    database: SF_DATABASE,
    warehouse: SF_WAREHOUSE,
    nodeVersion: process.version,
    memoryMb: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
    },
  });
});

app.get('/api/diagnostics/probe', async (_req, res) => {
  const results: Record<string, { ok: boolean; ms: number; detail?: string }> = {};

  let t = Date.now();
  try {
    await runSql('SELECT 1 AS PING');
    results.snowflakeSql = { ok: true, ms: Date.now() - t };
  } catch (e: any) {
    results.snowflakeSql = { ok: false, ms: Date.now() - t, detail: e.message?.slice(0, 200) };
  }

  t = Date.now();
  try {
    const rows = await runSql(`SELECT ${SF_DATABASE}.CORE.ORS_STATUS() AS S`);
    const raw = rows?.[0]?.S;
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const profiles = Object.keys(status?.profiles || {});
    results.orsService = { ok: !!status?.service_ready, ms: Date.now() - t, detail: `profiles: ${profiles.join(', ') || 'none'}` };
  } catch (e: any) {
    results.orsService = { ok: false, ms: Date.now() - t, detail: e.message?.slice(0, 200) };
  }

  t = Date.now();
  try {
    await runSql('SELECT 1 FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1', 'OVERTURE_MAPS__PLACES', 'CARTO');
    results.overtureMaps = { ok: true, ms: Date.now() - t };
  } catch (e: any) {
    results.overtureMaps = { ok: false, ms: Date.now() - t, detail: e.message?.slice(0, 200) };
  }

  log('INFO', 'Diagnostics', 'Connectivity probe completed', { detail: results });
  res.json(results);
});

app.post('/api/diagnostics/logs/clear', (_req, res) => {
  clearEntries();
  res.json({ ok: true });
});

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

app.use('/api/studio', createStudioRouter(runSql));

app.post('/api/query', async (req, res) => {
  try {
    const { sql, database, schema } = req.body;
    if (!sql) return res.status(400).json({ error: 'sql required' });
    const trimmed = sql.trim().replace(/;+$/, '').trim();
    const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
    const ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'CALL', 'WITH'];
    if (!ALLOWED.includes(firstWord)) {
      return res.status(403).json({ error: `Only read-only queries allowed. Got: ${firstWord}` });
    }
    log('INFO', 'Query', `DB:${database} Schema:${schema} SQL:${trimmed.slice(0, 300)}`);
    const rows = await runSql(trimmed, database, schema);
    log('INFO', 'Query', `Returned ${rows?.length ?? 0} rows`);
    res.json({ result: rows });
  } catch (err: any) {
    log('ERROR', 'Query', `/api/query error: ${err.message?.slice(0, 300)}`);
    res.json({ error: err.message });
  }
});

const tileCache = new Map<string, { buf: Buffer; ts: number }>();
const TILE_CACHE_TTL = 3600_000;

app.get('/api/tiles/:z/:x/:y', async (req, res) => {
  const { z, x, y } = req.params;
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached && Date.now() - cached.ts < TILE_CACHE_TTL) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(cached.buf);
    return;
  }
  const url = `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}@2x.png`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) { continue; }
      const buf = Buffer.from(await resp.arrayBuffer());
      tileCache.set(key, { buf, ts: Date.now() });
      if (tileCache.size > 5000) {
        const oldest = [...tileCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 1000);
        for (const [k] of oldest) tileCache.delete(k);
      }
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(buf);
      return;
    } catch (e: any) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 200 * (attempt + 1))); continue; }
      console.error(`Tile proxy error for ${key}: ${e.cause?.message || e.message}`);
      res.status(502).send('Tile fetch failed');
    }
  }
});

const distDir = join(import.meta.dirname || '.', '../dist');

app.get('/logout', (req, res) => {
  // Redirect to Snowflake account logout which clears the session and shows login screen
  const appUrl = encodeURIComponent(`https://${req.headers.host || ''}/`);
  const accountHost = SNOWFLAKE_HOST || '';
  if (accountHost) {
    res.redirect(302, `https://${accountHost}/session/v1/logout-from-application?redirect_url=${appUrl}`);
  } else {
    res.clearCookie('session');
    res.redirect(302, '/');
  }
});

app.use('/assets', express.static(join(distDir, 'assets'), {
  maxAge: '1y',
  immutable: true,
}));
app.use(express.static(distDir, {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(join(distDir, 'index.html'));
});

const PORT = parseInt(process.env.PORT || '3001');
detectWarehouse().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ORS Control App server running on port ${PORT} (SPCS: ${IS_SPCS}, WH: ${SF_WAREHOUSE})`);
  });
});