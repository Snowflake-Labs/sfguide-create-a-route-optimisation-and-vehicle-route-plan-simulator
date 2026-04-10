import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStudioRouter } from './studio/routes.js';
import { log, getEntries, clearEntries, getUptimeMs } from './diagnostics.js';
import { IS_SPCS, SF_DATABASE, SF_WAREHOUSE, setWarehouse, CONN, SNOWFLAKE_HOST, DEFAULT_WAREHOUSE } from './constants.js';
config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
async function detectWarehouse() {
    if (SF_WAREHOUSE)
        return;
    try {
        const rows = IS_SPCS
            ? await snowSqlSpcs('SHOW WAREHOUSES LIMIT 1')
            : snowSqlLocal('SHOW WAREHOUSES LIMIT 1');
        const name = rows?.[0]?.name || rows?.[0]?.NAME;
        if (name)
            setWarehouse(name);
        else
            setWarehouse(DEFAULT_WAREHOUSE);
    }
    catch {
        setWarehouse(DEFAULT_WAREHOUSE);
    }
}
async function waitForOrsGraphReady(region, maxWaitSecs = 600) {
    const start = Date.now();
    const interval = 15000;
    const maxAttempts = Math.ceil((maxWaitSecs * 1000) / interval);
    const safeRegion = region.replace(/[^A-Za-z0-9_]/g, '');
    let isDefault = !safeRegion || safeRegion.toUpperCase() === 'DEFAULT';
    if (!isDefault) {
        try {
            const svcRows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion.toUpperCase()}' IN SCHEMA ${SF_DATABASE}.CORE`);
            isDefault = !svcRows || svcRows.length === 0;
        }
        catch {
            isDefault = true;
        }
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
        }
        catch { }
        await new Promise((r) => setTimeout(r, interval));
    }
    return { ready: false, elapsed: Math.round((Date.now() - start) / 1000), profiles: [] };
}
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;
function sanitizeIdentifier(val) {
    const cleaned = val.replace(/[^A-Za-z0-9_]/g, '');
    if (!IDENTIFIER_RE.test(cleaned))
        throw new Error(`Invalid identifier: ${val}`);
    return cleaned;
}
function sanitizeFloat(val) {
    const n = Number(val);
    if (!Number.isFinite(n))
        throw new Error(`Invalid number: ${val}`);
    return n;
}
function sanitizeInt(val) {
    const n = Math.round(Number(val));
    if (!Number.isFinite(n) || n < 0 || n > 10000)
        throw new Error(`Invalid integer: ${val}`);
    return n;
}
function escapeString(val) {
    return val.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '');
}
function getSpcsToken() {
    return readFileSync('/snowflake/session/token', 'utf-8').trim();
}
function snowSqlLocal(sql, database, schema) {
    const tmpFile = join(tmpdir(), `ors_query_${Date.now()}.sql`);
    const db = database || SF_DATABASE;
    let fullSql = `ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';\nUSE WAREHOUSE ${SF_WAREHOUSE};\nUSE DATABASE ${db};\n`;
    if (schema)
        fullSql += `USE SCHEMA ${schema};\n`;
    fullSql += `${sql};`;
    writeFileSync(tmpFile, fullSql);
    try {
        const result = execSync(`snow sql -c ${CONN} -f "${tmpFile}" --format json 2>/dev/null`, {
            maxBuffer: 50 * 1024 * 1024, timeout: 120000, encoding: 'utf-8',
        });
        const parsed = JSON.parse(result.trim());
        if (Array.isArray(parsed) && Array.isArray(parsed[0]))
            return parsed[parsed.length - 1];
        return parsed;
    }
    finally {
        try {
            unlinkSync(tmpFile);
        }
        catch { }
    }
}
async function snowSqlSpcs(sql, database, schema, timeoutSecs = 600) {
    const token = getSpcsToken();
    const body = { statement: sql, timeout: timeoutSecs, database: database || SF_DATABASE, schema: schema || 'CORE', warehouse: SF_WAREHOUSE };
    const headers = {
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
    let result = await res.json();
    if (result.statementStatusUrl && (!result.data || result.code === '333334')) {
        const pollUrl = `https://${SNOWFLAKE_HOST}${result.statementStatusUrl}`;
        for (let i = 0; i < 120; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            const pr = await fetch(pollUrl, { headers });
            result = await pr.json();
            if (result.data || (result.code && result.code !== '333334'))
                break;
        }
    }
    if (result.message && !result.data) {
        log('ERROR', 'SQL', `Statement error: ${result.message?.slice(0, 200)}`, { durationMs: Date.now() - sqlStart });
        throw new Error(`SQL error: ${result.message}`);
    }
    if (!result.data)
        return [];
    const cols = (result.resultSetMetaData?.rowType || []).map((c) => c.name);
    let allData = [...(result.data || [])];
    const partitions = result.resultSetMetaData?.partitionInfo;
    if (partitions && partitions.length > 1) {
        const handle = result.statementHandle;
        console.log(`[SQL API] Result has ${partitions.length} partitions (${result.resultSetMetaData?.numRows} rows). Fetching remaining...`);
        for (let p = 1; p < partitions.length; p++) {
            const pr = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements/${handle}?partition=${p}`, { headers });
            const partResult = await pr.json();
            if (partResult.data)
                allData = allData.concat(partResult.data);
        }
    }
    console.log(`[SQL API] Returning ${allData.length} rows`);
    return allData.map((row) => {
        const obj = {};
        cols.forEach((c, i) => { obj[c] = row[i]; });
        return obj;
    });
}
async function runSql(sql, database, schema) {
    if (IS_SPCS)
        return snowSqlSpcs(sql, database, schema);
    return snowSqlLocal(sql, database, schema);
}
async function callProcedure(proc) {
    const rows = await runSql(`CALL ${SF_DATABASE}.CORE.${proc}`);
    return rows?.[0]?.[Object.keys(rows[0])[0]] || '';
}
app.get('/api/status', async (_req, res) => {
    try {
        const result = await callProcedure('GET_STATUS()');
        res.json(JSON.parse(result));
    }
    catch (err) {
        log('ERROR', 'Health', `/api/status error: ${err.message?.slice(0, 200)}`);
        res.json({ compute_pool: 'ERROR', services: [], error: err.message });
    }
});
app.get('/api/config', (_req, res) => {
    res.json({ database: SF_DATABASE });
});
const APP_VERSION = '1.0.51';
const DEFAULT_PROFILES = ['driving-car', 'driving-hgv', 'cycling-electric'];
let cachedDefaultExpectedProfiles = null;
async function getExpectedProfiles(region) {
    if (region === 'default') {
        if (cachedDefaultExpectedProfiles)
            return cachedDefaultExpectedProfiles;
        try {
            const rows = await runSql(`SELECT "$1" AS CONTENT FROM @${SF_DATABASE}.CORE.ORS_SPCS_STAGE/SanFrancisco/ors-config.yml (FILE_FORMAT => (TYPE='CSV' FIELD_DELIMITER=NONE RECORD_DELIMITER=NONE))`);
            const content = rows?.[0]?.CONTENT;
            if (content && typeof content === 'string') {
                const profileMatches = content.match(/profiles:\s*([\s\S]*?)(?:^\S|$)/m);
                if (profileMatches) {
                    const profiles = [];
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
        }
        catch (e) {
            console.log(`[getExpectedProfiles] Could not parse config from stage: ${e.message}`);
        }
        cachedDefaultExpectedProfiles = DEFAULT_PROFILES;
        return DEFAULT_PROFILES;
    }
    try {
        const safeRegion = sanitizeIdentifier(region);
        const rows = await runSql(`SELECT PROFILES FROM ${SF_DATABASE}.CORE.CITY_PROVISION_JOBS WHERE REGION='${escapeString(safeRegion)}' AND STATUS='COMPLETED' ORDER BY COMPLETED_AT DESC LIMIT 1`);
        const profileStr = rows?.[0]?.PROFILES;
        if (profileStr && typeof profileStr === 'string') {
            return profileStr.split(',').map((p) => p.trim()).filter(Boolean);
        }
    }
    catch (e) {
        console.log(`[getExpectedProfiles] Could not get profiles for ${region}: ${e.message}`);
    }
    return DEFAULT_PROFILES;
}
app.get('/api/health', async (_req, res) => {
    const result = { healthy: false, version: APP_VERSION, services: {} };
    try {
        const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.ORS_SERVICE')) AS S`);
        const raw = statusRows?.[0]?.S;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) {
            result.services.ors = parsed[0]?.status || 'UNKNOWN';
        }
    }
    catch {
        result.services.ors = 'ERROR';
    }
    try {
        const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.ROUTING_GATEWAY_SERVICE')) AS S`);
        const raw = statusRows?.[0]?.S;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) {
            result.services.gateway = parsed[0]?.status || 'UNKNOWN';
        }
    }
    catch {
        result.services.gateway = 'ERROR';
    }
    try {
        const statusRows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${SF_DATABASE}.CORE.VROOM_SERVICE')) AS S`);
        const raw = statusRows?.[0]?.S;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed)) {
            result.services.vroom = parsed[0]?.status || 'UNKNOWN';
        }
    }
    catch {
        result.services.vroom = 'ERROR';
    }
    try {
        const versionRows = await runSql(`SELECT COMPONENT, VERSION FROM ${SF_DATABASE}.CORE.VERSION_INFO`);
        if (versionRows?.length) {
            result.versions = {};
            for (const row of versionRows) {
                result.versions[row.COMPONENT || row.component] = row.VERSION || row.version;
            }
        }
    }
    catch { }
    result.healthy = result.services.ors === 'READY' && result.services.gateway === 'READY';
    res.json(result);
});
app.get('/api/ors-readiness', async (_req, res) => {
    const readiness = {};
    async function buildReadiness(regionKey, data) {
        const builtProfiles = Object.keys(data.profiles || {});
        const expectedProfiles = await getExpectedProfiles(regionKey);
        const allProfiles = [...new Set([...expectedProfiles, ...builtProfiles])];
        const graphs = allProfiles.map(p => ({
            profile: p,
            ready: builtProfiles.includes(p),
            build_date: (data.bounds_info || {})[p]?.graph_build_date || null,
        }));
        return {
            service_ready: data.service_ready ?? false,
            health_ready: data.health_ready ?? false,
            profiles: builtProfiles,
            expected_profiles: expectedProfiles,
            graphs,
        };
    }
    try {
        const defaultRows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS()) AS S`);
        const raw = defaultRows?.[0]?.S;
        if (raw) {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            readiness['default'] = await buildReadiness('default', data);
        }
    }
    catch (e) {
        readiness['default'] = { service_ready: false, health_ready: false, error: e.message };
    }
    try {
        const cities = JSON.parse(await callProcedure('LIST_CITIES()') || '[]');
        for (const city of cities) {
            const safeRegion = sanitizeIdentifier(city.region);
            try {
                const rows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')) AS S`);
                const raw = rows?.[0]?.S;
                if (raw) {
                    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    readiness[city.region] = await buildReadiness(city.region, data);
                }
            }
            catch (e) {
                readiness[city.region] = { service_ready: false, health_ready: false, error: e.message };
            }
        }
    }
    catch { }
    res.json(readiness);
});
app.post('/api/resume', async (_req, res) => {
    try {
        const result = await callProcedure('RESUME_ALL_SERVICES()');
        res.json({ status: 'ok', result });
    }
    catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});
app.post('/api/suspend', async (_req, res) => {
    try {
        const result = await callProcedure('SUSPEND_ALL_SERVICES()');
        res.json({ status: 'ok', result });
    }
    catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});
app.post('/api/scale', async (req, res) => {
    try {
        const min = sanitizeInt(req.body.min);
        const max = sanitizeInt(req.body.max);
        if (min < 1 || max < min || max > 20)
            return res.status(400).json({ error: 'min must be 1-20, max >= min' });
        const result = await callProcedure(`SCALE_SERVICES(${min}, ${max})`);
        res.json({ status: 'ok', result });
    }
    catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});
app.get('/api/cities', async (_req, res) => {
    try {
        const result = await callProcedure('LIST_CITIES()');
        const cities = JSON.parse(result || '[]');
        const enriched = await Promise.all(cities.map(async (c) => {
            let serviceStatus = 'UNKNOWN';
            try {
                const safeRegion = sanitizeIdentifier(c.region);
                const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion}' IN SCHEMA ${SF_DATABASE}.CORE`);
                serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
            }
            catch {
                serviceStatus = 'NOT_FOUND';
            }
            return { ...c, serviceStatus, functionExists: true };
        }));
        let defaultStatus = 'NOT_FOUND';
        try {
            const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE' IN SCHEMA ${SF_DATABASE}.CORE`);
            defaultStatus = rows?.[0]?.status || 'NOT_FOUND';
        }
        catch { }
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
        res.json({ cities: enriched });
    }
    catch (err) {
        res.json({ cities: [], error: err.message });
    }
});
app.post('/api/cities/provision', async (req, res) => {
    const { city, region, pbf_url, bbox, profiles } = req.body;
    if (!region)
        return res.status(400).json({ error: 'region required' });
    let safeRegion;
    let safeCity;
    try {
        safeRegion = sanitizeIdentifier(region);
        safeCity = escapeString(city || region);
        sanitizeFloat(bbox?.minLat);
        sanitizeFloat(bbox?.maxLat);
        sanitizeFloat(bbox?.minLon);
        sanitizeFloat(bbox?.maxLon);
    }
    catch (err) {
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
        ? profiles.filter((p) => validProfiles.includes(p)).join(',')
        : defaultProfiles;
    const safeProfiles = escapeString(selectedProfiles || defaultProfiles);
    const jobId = `PROVISION_${safeRegion}_${Date.now()}`.toUpperCase();
    try {
        await runSql(`INSERT INTO ${SF_DATABASE}.CORE.CITY_PROVISION_JOBS (JOB_ID, REGION, DISPLAY_NAME, PBF_URL, PROFILES, STATUS, STAGE) VALUES ('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', '${safeProfiles}', 'PENDING', 'NOT_STARTED')`);
    }
    catch (err) {
        return res.status(500).json({ error: `Failed to create job: ${err.message}` });
    }
    res.json({ status: 'launched', job_id: jobId });
    try {
        const callSql = `CALL ${SF_DATABASE}.CORE.PROVISION_CITY_WRAPPER('${escapeString(jobId)}', '${safeRegion}', '${safeCity}', '${safePbfUrl}', ${minLat}, ${maxLat}, ${minLon}, ${maxLon}, '${safeProfiles}')`;
        const handle = await submitSqlAsync(callSql);
        await runSql(`UPDATE ${SF_DATABASE}.CORE.CITY_PROVISION_JOBS SET STATEMENT_HANDLE='${escapeString(handle)}' WHERE JOB_ID='${escapeString(jobId)}'`);
    }
    catch (e) {
        console.error(`[provision] async launch error: ${e.message}`);
    }
});
app.get('/api/cities/provision/status', async (_req, res) => {
    try {
        const result = await callProcedure('GET_PROVISION_STATUS()');
        const jobs = JSON.parse(result || '[]');
        res.json({ jobs });
    }
    catch (err) {
        res.json({ jobs: [], error: err.message });
    }
});
app.get('/api/cities/:region/progress', async (req, res) => {
    try {
        const safeRegion = sanitizeIdentifier(req.params.region);
        const result = await callProcedure('GET_PROVISION_STATUS()');
        const jobs = JSON.parse(result || '[]');
        const job = jobs.find((j) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
        if (job) {
            res.json({ status: job.status === 'RUNNING' ? 'running' : job.status, phase: job.stage.toLowerCase(), message: job.message, error: job.error_msg });
        }
        else {
            const completed = jobs.find((j) => j.region === safeRegion);
            res.json(completed ? { status: completed.status.toLowerCase(), phase: completed.stage.toLowerCase(), message: completed.message } : { status: 'idle', phase: '' });
        }
    }
    catch {
        res.json({ status: 'idle', phase: '' });
    }
});
app.post('/api/cities/:region/cancel', async (req, res) => {
    try {
        const safeRegion = sanitizeIdentifier(req.params.region);
        const result = await callProcedure('GET_PROVISION_STATUS()');
        const jobs = JSON.parse(result || '[]');
        const active = jobs.find((j) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
        if (active?.statement_handle)
            await cancelStatement(active.statement_handle);
        await runSql(`UPDATE ${SF_DATABASE}.CORE.CITY_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=CURRENT_TIMESTAMP() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
        res.json({ status: 'cancelled' });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.delete('/api/cities/:region', async (req, res) => {
    try {
        const safeRegion = sanitizeIdentifier(req.params.region);
        const result = await callProcedure(`DROP_CITY_ORS('${safeRegion}')`);
        await runSql(`UPDATE ${SF_DATABASE}.CORE.CITY_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=CURRENT_TIMESTAMP() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
        res.json({ status: 'ok', result });
    }
    catch (err) {
        res.json({ status: 'error', error: err.message });
    }
});
app.get('/api/matrix/regions', async (_req, res) => {
    try {
        const cities = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.CITY_ORS_MAP`);
        const regions = [];
        for (const c of cities) {
            const safeRegion = sanitizeIdentifier(c.REGION || '');
            let serviceStatus = 'NOT_FOUND';
            try {
                const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_${safeRegion}' IN SCHEMA ${SF_DATABASE}.CORE`);
                serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
            }
            catch { }
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
        }
        catch { }
        if (mainStatus !== 'NOT_FOUND') {
            let defaultRegion = 'DEFAULT';
            let defaultLabel = 'Default ORS';
            let defaultBounds = { minLat: 37.71, maxLat: 37.81, minLon: -122.51, maxLon: -122.37 };
            try {
                const stageRows = await runSql(`LIST @${SF_DATABASE}.CORE.ORS_SPCS_STAGE PATTERN='.*ors-config.*'`);
                const cityRegions = new Set(cities.map((c) => (c.REGION || '').toUpperCase()));
                for (const row of stageRows || []) {
                    const path = row.name || row.NAME || '';
                    const match = path.match(/ors_spcs_stage\/([^/]+)\/ors-config/i);
                    if (match) {
                        const stageRegion = match[1];
                        if (!cityRegions.has(stageRegion.toUpperCase())) {
                            defaultRegion = stageRegion;
                            defaultLabel = stageRegion.replace(/([a-z])([A-Z])/g, '$1 $2');
                            break;
                        }
                    }
                }
            }
            catch { }
            try {
                const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.CITY_ORS_MAP WHERE REGION = '${escapeString(defaultRegion)}'`);
                if (cityRow?.[0]) {
                    defaultLabel = cityRow[0].DISPLAY_NAME || defaultLabel;
                    defaultBounds = { minLat: cityRow[0].MIN_LAT, maxLat: cityRow[0].MAX_LAT, minLon: cityRow[0].MIN_LON, maxLon: cityRow[0].MAX_LON };
                }
            }
            catch { }
            regions.unshift({
                region: defaultRegion, label: `${defaultLabel} (Default)`,
                bounds: defaultBounds,
                serviceStatus: mainStatus, serviceExists: true,
                matrixFunctionExists: true, directionsFunctionExists: true,
                ready: mainStatus === 'RUNNING' || mainStatus === 'SUSPENDED',
                provisioned: true,
                matrixFn: `${SF_DATABASE}.CORE.MATRIX_TABULAR`,
                cities: [defaultLabel],
                isDefault: true,
            });
        }
        res.json({ regions });
    }
    catch (err) {
        res.json({ regions: [], error: err.message });
    }
});
async function submitSqlAsync(sql) {
    if (!IS_SPCS) {
        runSql(sql).catch((e) => console.error(`[Async local] Error: ${e.message}`));
        return `local_${Date.now()}`;
    }
    const token = getSpcsToken();
    const body = { statement: sql, timeout: 0, database: SF_DATABASE, warehouse: SF_WAREHOUSE };
    const headers = {
        'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
        'Accept': 'application/json', 'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    };
    console.log(`[SQL API Async] Submitting: ${sql.slice(0, 200)}`);
    const r = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements`, { method: 'POST', headers, body: JSON.stringify(body) });
    const result = await r.json();
    return result.statementHandle || '';
}
async function cancelStatement(handle) {
    if (!IS_SPCS || !handle || handle.startsWith('local_'))
        return false;
    try {
        const token = getSpcsToken();
        const headers = {
            'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
            'X-Snowflake-Authorization-Token-Type': 'OAUTH',
        };
        const r = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements/${handle}/cancel`, { method: 'POST', headers });
        return r.ok;
    }
    catch {
        return false;
    }
}
app.post('/api/matrix/cost-estimate', async (req, res) => {
    try {
        const { region, resolutions, profile } = req.body;
        if (!region || !resolutions)
            return res.status(400).json({ error: 'region and resolutions required' });
        let safeRegion;
        try {
            safeRegion = sanitizeIdentifier(region);
        }
        catch {
            return res.status(400).json({ error: 'Invalid region' });
        }
        let bbox = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
        try {
            const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.CITY_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
            if (cityRow?.[0])
                bbox = cityRow[0];
        }
        catch { }
        const latSpan = Math.abs(Number(bbox.MAX_LAT) - Number(bbox.MIN_LAT));
        const lonSpan = Math.abs(Number(bbox.MAX_LON) - Number(bbox.MIN_LON));
        const areaSqKm = latSpan * 111 * lonSpan * 111 * Math.cos(((Number(bbox.MIN_LAT) + Number(bbox.MAX_LAT)) / 2) * Math.PI / 180);
        const hexAreaKm2 = { 5: 252.9, 6: 36.13, 7: 5.16, 8: 0.737, 9: 0.105, 10: 0.015 };
        const pairsPerSecond = 30000;
        const computePoolNodes = 10;
        const computePoolCreditPerNodeHr = 1;
        const warehouseCreditPerHr = 10;
        const flattenCredits = 2;
        const creditPriceDollars = 3;
        const estimates = resolutions.filter((r) => r >= 5 && r <= 10).map((resolution) => {
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
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/matrix/existing', async (req, res) => {
    try {
        const region = req.query.region;
        const profile = req.query.profile || 'driving-car';
        const safeRegion = region ? sanitizeIdentifier(region) : 'SAN_FRANCISCO';
        const safeProfile = profile.replace(/-/g, '_').toUpperCase();
        const prefix = `${safeRegion}_${safeProfile}`;
        const counts = {};
        for (const r of [5, 6, 7, 8, 9, 10]) {
            try {
                const rows = await runSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.TRAVEL_MATRIX.${prefix}_MATRIX_RES${r}`);
                const cnt = parseInt(rows?.[0]?.CNT || '0');
                if (cnt > 0)
                    counts[`RES${r}`] = cnt;
            }
            catch { }
        }
        res.json(counts);
    }
    catch (err) {
        res.json({});
    }
});
app.post('/api/matrix/build', async (req, res) => {
    const { region, resolutions, profile: reqProfile } = req.body;
    if (!region || !resolutions)
        return res.status(400).json({ error: 'region and resolutions required' });
    const profile = reqProfile || 'driving-car';
    let safeRegion;
    try {
        safeRegion = sanitizeIdentifier(region);
    }
    catch (err) {
        return res.status(400).json({ error: `Invalid region: ${err.message}` });
    }
    const safeResolutions = resolutions.filter((r) => r >= 5 && r <= 10);
    if (safeResolutions.length === 0)
        return res.status(400).json({ error: 'resolutions must be between 5 and 10' });
    const safeProfile = escapeString(profile);
    try {
        let bbox = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
        try {
            const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.CITY_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
            if (cityRow?.[0])
                bbox = cityRow[0];
        }
        catch { }
        let matrixFn = `${SF_DATABASE}.CORE.MATRIX_TABULAR`;
        const jobs = [];
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
                        }
                        catch {
                            break;
                        }
                    }
                }
                catch (e) {
                    console.error(`[matrix/build] async launch error for ${jobId}: ${e.message}`);
                }
            }
        })().catch(() => { });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/matrix/status', async (req, res) => {
    try {
        const result = await callProcedure('GET_BUILD_STATUS()');
        let jobs = JSON.parse(result || '[]');
        for (const job of jobs) {
            if (job.status === 'RUNNING' && job.stage === 'BUILDING' && job.work_queue_rows > 0) {
                try {
                    const liveResult = await callProcedure(`GET_LIVE_TABLE_COUNT('${escapeString(job.region)}', '${escapeString(job.profile)}', '${escapeString(job.resolution)}')`);
                    const live = JSON.parse(liveResult || '{}');
                    if (live.raw_ingested > 0) {
                        job.raw_rows = live.raw_ingested;
                        job.pct_complete = Math.round(live.raw_ingested * 1000 / job.work_queue_rows) / 10;
                    }
                }
                catch { }
            }
        }
        res.json({ jobs });
    }
    catch (err) {
        res.json({ jobs: [], error: err.message });
    }
});
app.get('/api/matrix/inventory', async (_req, res) => {
    try {
        const result = await callProcedure('GET_MATRIX_INVENTORY()');
        const tables = JSON.parse(result || '[]');
        const inventory = tables.map((t) => {
            const name = t.table_name || '';
            const parts = name.match(/^(.+)_MATRIX_(RES\d+)$/);
            if (!parts)
                return null;
            const regionProfile = parts[1];
            const resolution = parts[2];
            const profileIdx = regionProfile.lastIndexOf('_DRIVING_') >= 0
                ? regionProfile.lastIndexOf('_DRIVING_')
                : regionProfile.lastIndexOf('_CYCLING_') >= 0
                    ? regionProfile.lastIndexOf('_CYCLING_')
                    : regionProfile.lastIndexOf('_FOOT_') >= 0
                        ? regionProfile.lastIndexOf('_FOOT_')
                        : regionProfile.lastIndexOf('_WHEELCHAIR');
            let region = regionProfile;
            let profileName = 'driving-car';
            if (profileIdx > 0) {
                region = regionProfile.substring(0, profileIdx);
                profileName = regionProfile.substring(profileIdx + 1).toLowerCase().replace(/_/g, '-');
            }
            return {
                region, profile: profileName, resolution,
                row_count: parseInt(t.row_count || '0'),
                bytes: parseInt(t.bytes || '0'),
                created: t.created || '',
                table_name: name,
                execution_time_secs: parseInt(t.execution_time_secs || '0'),
            };
        }).filter(Boolean);
        res.json({ inventory });
    }
    catch (err) {
        res.json({ inventory: [], error: err.message });
    }
});
app.delete('/api/matrix/:region/:profile/:resolution', async (req, res) => {
    try {
        const safeRegion = sanitizeIdentifier(req.params.region);
        const safeProfile = escapeString(req.params.profile);
        const safeRes = sanitizeIdentifier(req.params.resolution);
        const result = await callProcedure(`DELETE_MATRIX_CONFIG('${safeRegion}', '${safeProfile}', '${safeRes}')`);
        res.json({ status: 'ok', result });
    }
    catch (err) {
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
    }
    catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});
app.post('/api/matrix/cancel', async (req, res) => {
    try {
        const { job_id } = req.body;
        if (!job_id)
            return res.status(400).json({ error: 'job_id required' });
        const result = await callProcedure(`CANCEL_MATRIX_BUILD('${escapeString(job_id)}')`);
        const parsed = JSON.parse(result || '{}');
        if (parsed.statement_handle) {
            await cancelStatement(parsed.statement_handle);
        }
        res.json({ status: 'cancelled', result: parsed });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
const VIEWER_PROFILE_PATTERNS = ['DRIVING_CAR', 'DRIVING_HGV', 'CYCLING_REGULAR', 'CYCLING_ROAD', 'CYCLING_MOUNTAIN', 'CYCLING_ELECTRIC', 'FOOT_WALKING', 'FOOT_HIKING', 'WHEELCHAIR'];
function parseViewerTableName(name) {
    for (const profile of VIEWER_PROFILE_PATTERNS) {
        const pattern = new RegExp(`^(.+?)_${profile}_MATRIX_(RES\\d+)$`);
        const match = name.match(pattern);
        if (match) {
            return { region: match[1], profile: profile.toLowerCase().replace(/_/g, '-'), resolution: match[2] };
        }
    }
    return null;
}
let viewerInventoryCache = { tables: [], ts: 0 };
const VIEWER_CACHE_TTL = 60000;
async function getViewerInventory() {
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
    const tables = rows.map((r) => {
        const parsed = parseViewerTableName(r.TABLE_NAME);
        if (!parsed)
            return null;
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
function validateViewerTable(tableName) {
    const tables = viewerInventoryCache.tables;
    const found = tables.find((t) => t.full_table === tableName || t.table_name === tableName);
    if (found)
        return found.full_table;
    if (/^[A-Z0-9_]+\.[A-Z0-9_]+\.[A-Z0-9_]+$/i.test(tableName)) {
        const parsed = parseViewerTableName(tableName.split('.').pop());
        if (parsed)
            return tableName;
    }
    return null;
}
app.get('/api/matrix/viewer-inventory', async (_req, res) => {
    try {
        const tables = await getViewerInventory();
        res.json({ tables });
    }
    catch (err) {
        res.json({ tables: [], error: err.message });
    }
});
app.get('/api/matrix/travel-times', async (req, res) => {
    try {
        const tableParam = req.query.table;
        if (!tableParam)
            return res.status(400).json({ error: 'table parameter required' });
        await getViewerInventory();
        const table = validateViewerTable(tableParam);
        if (!table)
            return res.status(400).json({ error: 'Invalid table name' });
        const rows = await runSql(`
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
      FROM ${table}
      GROUP BY ORIGIN_H3
      ORDER BY DEST_COUNT DESC
      LIMIT 5000
    `);
        const totalRows = await runSql(`SELECT COUNT(*) AS CNT FROM ${table}`);
        res.json({ hexagons: rows, total_pairs: Number(totalRows[0]?.CNT || 0) });
    }
    catch (err) {
        console.error('Travel-times error:', err.message);
        res.json({ hexagons: [], total_pairs: 0 });
    }
});
app.get('/api/matrix/random-origin', async (req, res) => {
    try {
        const tableParam = req.query.table;
        if (!tableParam)
            return res.status(400).json({ error: 'table parameter required' });
        await getViewerInventory();
        const table = validateViewerTable(tableParam);
        if (!table)
            return res.status(400).json({ error: 'Invalid table name' });
        const [[originRow], [maxRow]] = await Promise.all([
            runSql(`SELECT ORIGIN_H3 FROM (SELECT ORIGIN_H3, COUNT(*) AS CNT FROM ${table} GROUP BY ORIGIN_H3 ORDER BY CNT DESC LIMIT 10) ORDER BY RANDOM() LIMIT 1`),
            runSql(`SELECT MAX(TRAVEL_TIME_SECONDS) AS GLOBAL_MAX FROM ${table}`),
        ]);
        const hex = originRow?.ORIGIN_H3;
        if (!hex)
            return res.json({ error: 'No data in table' });
        const latLon = await runSql(`SELECT ST_Y(H3_CELL_TO_POINT('${hex}')) AS LAT, ST_X(H3_CELL_TO_POINT('${hex}')) AS LON`);
        res.json({
            origin_hex: hex,
            origin_lat: Number(latLon[0]?.LAT || 0),
            origin_lon: Number(latLon[0]?.LON || 0),
            global_max_time_secs: Number(maxRow?.GLOBAL_MAX || 0),
        });
    }
    catch (err) {
        console.error('Random-origin error:', err.message);
        res.json({ error: err.message });
    }
});
app.get('/api/matrix/all-hexes', async (req, res) => {
    try {
        const tableParam = req.query.table;
        if (!tableParam)
            return res.status(400).json({ error: 'table parameter required' });
        await getViewerInventory();
        const table = validateViewerTable(tableParam);
        if (!table)
            return res.status(400).json({ error: 'Invalid table name' });
        const rows = await runSql(`SELECT DISTINCT ORIGIN_H3 AS HEX_ID FROM ${table}`);
        res.json({ hexes: rows.map((r) => r.HEX_ID) });
    }
    catch (err) {
        console.error('All-hexes error:', err.message);
        res.json({ hexes: [] });
    }
});
app.get('/api/matrix/reachability', async (req, res) => {
    try {
        const tableParam = req.query.table;
        const origin = req.query.origin;
        if (!tableParam || !origin)
            return res.status(400).json({ error: 'table and origin required' });
        await getViewerInventory();
        const table = validateViewerTable(tableParam);
        if (!table)
            return res.status(400).json({ error: 'Invalid table name' });
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
        const originLatLon = await runSql(`SELECT ST_Y(H3_CELL_TO_POINT('${safeOrigin}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safeOrigin}')) AS LON`);
        res.json({
            destinations: rows,
            origin_lat: Number(originLatLon[0]?.LAT || 0),
            origin_lon: Number(originLatLon[0]?.LON || 0),
        });
    }
    catch (err) {
        console.error('Reachability error:', err.message);
        res.json({ destinations: [], origin_lat: 0, origin_lon: 0 });
    }
});
app.get('/api/matrix/ring-stats', async (req, res) => {
    try {
        const tableParam = req.query.table;
        const origin = req.query.origin;
        if (!tableParam || !origin)
            return res.status(400).json({ error: 'table and origin required' });
        await getViewerInventory();
        const table = validateViewerTable(tableParam);
        if (!table)
            return res.status(400).json({ error: 'Invalid table name' });
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
    }
    catch (err) {
        console.error('Ring-stats error:', err.message);
        res.json({ rings: [] });
    }
});
app.get('/api/regions', async (_req, res) => {
    try {
        let regions = [];
        try {
            regions = await runSql(`SELECT REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON,
                BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON,
                ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE, IS_DEFAULT
         FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
         ORDER BY IS_DEFAULT DESC, PROVISIONED_AT`, 'FLEET_INTELLIGENCE', 'CORE');
        }
        catch { }
        const knownNames = new Set(regions.map((r) => r.REGION_NAME));
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
        }
        catch { }
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
        const active = regions.find((r) => r.IS_DEFAULT === true || r.IS_DEFAULT === 'true')?.REGION_NAME || regions[0]?.REGION_NAME || 'SanFrancisco';
        res.json({ regions, active });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/regions/active', async (_req, res) => {
    try {
        const rows = await runSql(`SELECT REGION_NAME, DISPLAY_NAME, CENTER_LAT, CENTER_LON,
              BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON,
              ZOOM_LEVEL, ORS_REGION_KEY, DATA_SOURCE
       FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
       WHERE IS_DEFAULT = TRUE LIMIT 1`, 'FLEET_INTELLIGENCE', 'CORE');
        res.json(rows[0] || {
            REGION_NAME: 'SanFrancisco',
            DISPLAY_NAME: 'San Francisco',
            CENTER_LAT: 37.7749,
            CENTER_LON: -122.4194,
            ZOOM_LEVEL: 11,
        });
    }
    catch {
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
        if (!region)
            return res.status(400).json({ error: 'region required' });
        await runSql(`CALL FLEET_INTELLIGENCE.CORE.SET_ACTIVE_REGION('${region.replace(/'/g, "''")}')`, 'FLEET_INTELLIGENCE', 'CORE');
        const safeRegion = escapeString(region);
        const CONFIG_SCHEMAS = [
            'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
            'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
            'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
            'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
        ];
        for (const schema of CONFIG_SCHEMAS) {
            try {
                await runSql(`UPDATE ${schema}.CONFIG SET REGION = '${safeRegion}'`);
            }
            catch (e) {
                log('WARN', 'CONFIG', `Failed to update ${schema}.CONFIG region: ${e.message}`);
            }
        }
        res.json({ ok: true, region });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
const TOOL_PROCEDURE_MAP = {
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
const FLEET_CONFIG_SCHEMAS = [
    'FLEET_INTELLIGENCE.DWELL_ANALYSIS',
    'FLEET_INTELLIGENCE.ROUTE_DEVIATION',
    'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_TAXIS',
    'FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY',
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
        }
        catch { }
        let availableTypes = [];
        try {
            const rows = await runSql('SELECT DISTINCT VEHICLE_TYPE FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY ORDER BY VEHICLE_TYPE');
            availableTypes = rows.map((r) => r.VEHICLE_TYPE).filter(Boolean);
        }
        catch { }
        if (vehicleType && !availableTypes.includes(vehicleType))
            availableTypes.push(vehicleType);
        if (availableTypes.length === 0)
            availableTypes = [vehicleType];
        res.json({ vehicleType, region, availableTypes });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/fleet-config/vehicle-type', async (req, res) => {
    try {
        const { vehicleType } = req.body;
        if (!vehicleType)
            return res.status(400).json({ error: 'vehicleType required' });
        const safeType = escapeString(vehicleType);
        for (const schema of FLEET_CONFIG_SCHEMAS) {
            try {
                await runSql(`UPDATE ${schema}.CONFIG SET VEHICLE_TYPE = '${safeType}'`);
            }
            catch (e) {
                log('WARN', 'CONFIG', `Failed to update ${schema}.CONFIG vehicleType: ${e.message}`);
            }
        }
        res.json({ ok: true, vehicleType });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
const ROUTING_SYSTEM_PROMPT = `You are a routing agent powered by OpenRouteService. You help users with:
1. Driving/cycling/walking directions between locations
2. Reachability analysis (isochrones) - areas reachable within X minutes
3. Multi-stop delivery route optimization

You have access to three tools. To call a tool, respond with EXACTLY this JSON format and NOTHING else:
{"tool_call": {"name": "TOOL_NAME", "input": {PARAMS}}}

Available tools:
1. tool_directions - Get directions between locations
   Input: {"locations_description": "string describing start/end/waypoints (required)", "profile": "string (default: driving-car)"}
2. tool_isochrone - Get area reachable within specified minutes from a location
   Input: {"location_description": "string describing the center location (required)", "range_minutes": number (required), "profile": "string (default: driving-car)"}
3. tool_optimization - Optimize delivery/pickup routes for multiple stops with one or more vehicles
   Input: {"jobs_description": "string describing all delivery/pickup locations (required)", "vehicles_description": "string describing vehicle start/end locations (required)", "num_vehicles": number (default: 1), "profile": "string (default: driving-car)"}

Transport profiles: driving-car, cycling-electric (for any bike/cycling request), driving-hgv (trucks)

CRITICAL RULES:
1. ALWAYS call the appropriate tool for ANY routing question. NEVER answer from general knowledge.
2. When you need to call a tool, respond ONLY with the JSON tool_call object. No other text.
3. After receiving tool results, format them clearly: distances in km, durations in minutes.
4. If a tool returns an error, report it clearly. Do NOT provide alternative estimates.
5. NEVER fabricate routing data.`;
const AGENT_PROFILE_ALIASES = {
    'bike': 'cycling-electric', 'bicycle': 'cycling-electric', 'cycling': 'cycling-electric',
    'walk': 'foot-walking', 'walking': 'foot-walking', 'car': 'driving-car',
    'drive': 'driving-car', 'driving': 'driving-car', 'truck': 'driving-hgv', 'hgv': 'driving-hgv',
};
const AGENT_VALID_PROFILES = new Set(['driving-car', 'driving-hgv', 'cycling-regular', 'cycling-mountain', 'cycling-road', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair']);
function normalizeAgentProfile(profile) {
    if (!profile)
        return 'driving-car';
    const lower = profile.toLowerCase().trim();
    if (AGENT_VALID_PROFILES.has(lower))
        return lower;
    return AGENT_PROFILE_ALIASES[lower] || 'driving-car';
}
function escAgentSql(val) {
    if (val === undefined || val === null)
        return "''";
    return "'" + String(val).replace(/'/g, "''") + "'";
}
async function executeToolLocally(toolName, input) {
    const mapping = TOOL_PROCEDURE_MAP[toolName];
    if (!mapping)
        return { error: `Unknown tool: ${toolName}`, status: 'FAILED' };
    const args = mapping.params.map(p => {
        let val = input[p];
        if (p === 'profile')
            val = normalizeAgentProfile(val);
        if (val === undefined || val === null)
            return 'DEFAULT';
        if (typeof val === 'number')
            return String(val);
        return escAgentSql(val);
    });
    const sql = `CALL ${mapping.identifier}(${args.join(', ')})`;
    try {
        const rows = await runSql(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
        const result = rows?.[0];
        if (result) {
            const firstVal = Object.values(result)[0];
            if (typeof firstVal === 'string') {
                try {
                    return JSON.parse(firstVal);
                }
                catch {
                    return firstVal;
                }
            }
            return firstVal;
        }
        return { error: 'No result from tool execution', status: 'FAILED' };
    }
    catch (err) {
        return { error: `Tool execution failed: ${err.message}`, status: 'FAILED' };
    }
}
function escAgentSqlStr(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, ' ');
}
const AGENT_MODELS = ['claude-3-5-sonnet', 'mistral-large2'];
let agentModel = AGENT_MODELS[0];
async function callCortexComplete(messages) {
    const msgArray = messages.map(m => {
        return `{'role':'${m.role}','content':'${escAgentSqlStr(m.content)}'}`;
    }).join(',');
    const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('${agentModel}', [${msgArray}], {'max_tokens':4096,'temperature':0}) as RESPONSE`;
    console.log(`[Agent] Calling CORTEX.COMPLETE with model=${agentModel}, msgCount=${messages.length}, sqlLen=${sql.length}`);
    const startMs = Date.now();
    let rows;
    try {
        rows = await runSql(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
    }
    catch (err) {
        console.error(`[Agent] CORTEX.COMPLETE failed (${Date.now() - startMs}ms): ${err.message}`);
        if (agentModel === AGENT_MODELS[0] && AGENT_MODELS.length > 1) {
            console.log(`[Agent] Retrying with fallback model ${AGENT_MODELS[1]}`);
            agentModel = AGENT_MODELS[1];
            const retrySql = sql.replace(AGENT_MODELS[0], agentModel);
            rows = await runSql(retrySql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
        }
        else {
            throw err;
        }
    }
    console.log(`[Agent] CORTEX.COMPLETE returned in ${Date.now() - startMs}ms`);
    if (!rows || rows.length === 0)
        throw new Error('No response from CORTEX.COMPLETE');
    const raw = rows[0].RESPONSE || rows[0][Object.keys(rows[0])[0]] || '';
    let content = '';
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        content = parsed.choices?.[0]?.messages || parsed.choices?.[0]?.message?.content || '';
    }
    catch {
        content = String(raw);
    }
    if (!content) {
        console.error(`[Agent] Empty content from CORTEX.COMPLETE. Raw: ${JSON.stringify(raw).slice(0, 500)}`);
        throw new Error('Empty response from LLM');
    }
    return content.trim();
}
function findMatchingBrace(s) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (esc) {
            esc = false;
            continue;
        }
        if (c === '\\') {
            esc = true;
            continue;
        }
        if (c === '"') {
            inStr = !inStr;
            continue;
        }
        if (inStr)
            continue;
        if (c === '{')
            depth++;
        if (c === '}') {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return -1;
}
function parseToolCall(text) {
    try {
        const match = text.match(/\{\s*"tool_call"\s*:/s);
        if (!match)
            return null;
        const jsonStr = text.slice(text.indexOf('{'));
        const braceEnd = findMatchingBrace(jsonStr);
        if (braceEnd < 0)
            return null;
        const parsed = JSON.parse(jsonStr.slice(0, braceEnd + 1));
        if (parsed.tool_call?.name && TOOL_PROCEDURE_MAP[parsed.tool_call.name]) {
            return { name: parsed.tool_call.name, input: parsed.tool_call.input || {} };
        }
    }
    catch { }
    return null;
}
async function callCortexAgentWithToolLoop(message, threadId, parentMessageId, onProgress) {
    if (!IS_SPCS)
        throw new Error('Cortex Agent is only available in SPCS mode');
    console.log(`[Agent] Starting tool loop for: "${message.slice(0, 100)}"`);
    const messages = [
        { role: 'system', content: ROUTING_SYSTEM_PROMPT },
        { role: 'user', content: message },
    ];
    const maxIterations = 5;
    const allToolResults = [];
    for (let iter = 0; iter < maxIterations; iter++) {
        onProgress?.({ step: 'calling_llm', detail: iter === 0 ? 'Thinking...' : `Processing (step ${iter + 1})` });
        const response = await callCortexComplete(messages);
        console.log(`[Agent] LLM response (iter ${iter}): ${response.slice(0, 200)}`);
        const toolCall = parseToolCall(response);
        if (!toolCall) {
            console.log(`[Agent] No tool call found, returning text response`);
            return { role: 'assistant', content: [{ type: 'text', text: response }], _toolResults: allToolResults };
        }
        const toolLabel = toolCall.name.replace('tool_', '');
        onProgress?.({ step: 'executing_tool', detail: toolLabel });
        console.log(`[Agent] Executing tool: ${toolCall.name}`);
        messages.push({ role: 'assistant', content: response });
        const toolResult = await executeToolLocally(toolCall.name, toolCall.input);
        allToolResults.push(toolResult);
        onProgress?.({ step: 'formatting', detail: 'Processing tool results' });
        const resultStr = JSON.stringify(toolResult).slice(0, 30000);
        messages.push({ role: 'user', content: `Tool result from ${toolCall.name}:\n${resultStr}\n\nNow provide your final answer based on this data. Format distances in km and durations in minutes. Be concise.` });
    }
    return { role: 'assistant', content: [{ type: 'text', text: 'I was unable to complete the request after multiple attempts.' }], _toolResults: allToolResults };
}
function sendSseEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
app.post('/api/agent/chat', async (req, res) => {
    const { message, thread_id, parent_message_id } = req.body;
    if (!message)
        return res.status(400).json({ error: 'message required' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try {
        const onProgress = (data) => { sendSseEvent(res, 'progress', data); };
        const agentResult = await callCortexAgentWithToolLoop(message, thread_id, parent_message_id, onProgress);
        const content = agentResult?.content || [];
        let msg = '';
        let geometry = null;
        const toolResults = agentResult?._toolResults || [];
        for (const item of content) {
            if (item.type === 'text')
                msg += (msg ? '\n' : '') + item.text;
        }
        for (const tr of toolResults) {
            if (tr && typeof tr === 'object' && tr.geometry && !geometry)
                geometry = tr.geometry;
        }
        if (!msg)
            msg = agentResult?.message || 'No response from agent';
        const response = { message: msg, tool_results: toolResults };
        if (geometry)
            response.geometry = geometry;
        if (agentResult?.metadata?.thread_id)
            response.thread_id = agentResult.metadata.thread_id;
        if (agentResult?.metadata?.message_id)
            response.message_id = agentResult.metadata.message_id;
        sendSseEvent(res, 'result', response);
        res.end();
    }
    catch (err) {
        console.error(`[Agent] Chat endpoint error: ${err.message}`);
        sendSseEvent(res, 'error', { error: err.message || 'Unknown agent error' });
        res.end();
    }
});
app.get('/api/diagnostics/logs', (_req, res) => {
    const { level, tag, jobId, since, limit } = _req.query;
    const entries = getEntries({
        level: level,
        tag: tag,
        jobId: jobId,
        since: since,
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
    const results = {};
    let t = Date.now();
    try {
        await runSql('SELECT 1 AS PING');
        results.snowflakeSql = { ok: true, ms: Date.now() - t };
    }
    catch (e) {
        results.snowflakeSql = { ok: false, ms: Date.now() - t, detail: e.message?.slice(0, 200) };
    }
    t = Date.now();
    try {
        const rows = await runSql(`SELECT ${SF_DATABASE}.CORE.ORS_STATUS() AS S`);
        const raw = rows?.[0]?.S;
        const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const profiles = Object.keys(status?.profiles || {});
        results.orsService = { ok: !!status?.service_ready, ms: Date.now() - t, detail: `profiles: ${profiles.join(', ') || 'none'}` };
    }
    catch (e) {
        results.orsService = { ok: false, ms: Date.now() - t, detail: e.message?.slice(0, 200) };
    }
    t = Date.now();
    try {
        await runSql('SELECT 1 FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1', 'OVERTURE_MAPS__PLACES', 'CARTO');
        results.overtureMaps = { ok: true, ms: Date.now() - t };
    }
    catch (e) {
        results.overtureMaps = { ok: false, ms: Date.now() - t, detail: e.message?.slice(0, 200) };
    }
    log('INFO', 'Diagnostics', 'Connectivity probe completed', { detail: results });
    res.json(results);
});
app.post('/api/diagnostics/logs/clear', (_req, res) => {
    clearEntries();
    res.json({ ok: true });
});
function formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}
app.use('/api/studio', createStudioRouter(runSql));
app.post('/api/query', async (req, res) => {
    try {
        const { sql, database, schema } = req.body;
        if (!sql)
            return res.status(400).json({ error: 'sql required' });
        const trimmed = sql.trim().replace(/;+$/, '').trim();
        const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
        const ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'CALL', 'WITH'];
        if (!ALLOWED.includes(firstWord)) {
            return res.status(403).json({ error: `Only read-only queries allowed. Got: ${firstWord}` });
        }
        const rows = await runSql(trimmed, database, schema);
        res.json({ result: rows });
    }
    catch (err) {
        res.json({ error: err.message });
    }
});
const tileCache = new Map();
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
            if (!resp.ok) {
                continue;
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            tileCache.set(key, { buf, ts: Date.now() });
            if (tileCache.size > 5000) {
                const oldest = [...tileCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 1000);
                for (const [k] of oldest)
                    tileCache.delete(k);
            }
            res.set('Content-Type', 'image/png');
            res.set('Cache-Control', 'public, max-age=86400');
            res.send(buf);
            return;
        }
        catch (e) {
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
                continue;
            }
            console.error(`Tile proxy error for ${key}: ${e.cause?.message || e.message}`);
            res.status(502).send('Tile fetch failed');
        }
    }
});
const distDir = join(import.meta.dirname || '.', '../dist');
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
