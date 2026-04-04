import { Router } from 'express';
import { getJobs, getJob, cancelJob, subscribeJob, startGeneration } from './jobs.js';
import { PROFILE_TEMPLATES } from './profiles.js';
import { log } from '../diagnostics.js';
async function checkOrsReadiness(snowSql, orsProfile) {
    try {
        const rows = await snowSql(`SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ORS_STATUS() AS STATUS`);
        const raw = rows[0]?.STATUS;
        const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!status?.service_ready) {
            log('WARN', 'ORS', `ORS readiness check failed: service not ready (profile: ${orsProfile})`);
            return { ready: false, error: 'ORS service is not running (suspended or starting up). Resume the service from the Service Lifecycle page before generating.' };
        }
        const profiles = Object.keys(status.profiles || {});
        if (!profiles.includes(orsProfile)) {
            log('WARN', 'ORS', `ORS profile "${orsProfile}" not built. Available: ${profiles.join(', ')}`);
            return { ready: false, error: `ORS profile "${orsProfile}" is not built. Available profiles: ${profiles.join(', ') || 'none'}. Build the graph for this profile first.` };
        }
    }
    catch (e) {
        log('ERROR', 'ORS', `ORS readiness check exception: ${e.message?.slice(0, 200)}`);
        return { ready: false, error: `Cannot reach ORS service: ${e.message?.slice(0, 120)}. The app may not be installed.` };
    }
    return { ready: true };
}
export function createStudioRouter(snowSql) {
    const router = Router();
    router.get('/templates', (_req, res) => {
        res.json(PROFILE_TEMPLATES.map(t => ({
            id: t.id,
            name: t.name,
            description: t.description,
            vehicleType: t.vehicleType,
            orsProfile: t.orsProfile,
            regionScale: t.regionScale,
            feeds: t.feeds,
            defaultConfig: t.defaultConfig,
        })));
    });
    router.get('/regions', async (_req, res) => {
        try {
            const rows = await snowSql(`SELECT REGION_NAME, BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON, ORS_PROFILES, STATUS
         FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY ORDER BY REGION_NAME`, 'FLEET_INTELLIGENCE', 'CORE');
            res.json(rows);
        }
        catch (e) {
            log('WARN', 'Studio', `Failed to load regions: ${e.message?.slice(0, 200)}`);
            res.json([]);
        }
    });
    router.get('/coverage', async (_req, res) => {
        try {
            const telemetryStats = await snowSql(`SELECT VEHICLE_TYPE, REGION, ORS_PROFILE,
                COUNT(*) AS TELEMETRY_ROWS,
                COUNT(DISTINCT VEHICLE_ID) AS VEHICLES,
                COUNT(DISTINCT TRIP_ID) AS TRIPS
         FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
         GROUP BY VEHICLE_TYPE, REGION, ORS_PROFILE`, 'SYNTHETIC_DATASETS', 'UNIFIED');
            let tripStats = [];
            try {
                tripStats = await snowSql(`SELECT VEHICLE_TYPE, REGION, COUNT(*) AS TRIP_ROWS
           FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
           GROUP BY VEHICLE_TYPE, REGION`, 'SYNTHETIC_DATASETS', 'UNIFIED');
            }
            catch (e) {
                log('WARN', 'Studio', `Failed to load trip stats for coverage: ${e.message?.slice(0, 200)}`);
            }
            const merged = telemetryStats.map((t) => {
                const ts = tripStats.find((s) => s.VEHICLE_TYPE === t.VEHICLE_TYPE && s.REGION === t.REGION);
                return { ...t, TRIP_ROWS: ts?.TRIP_ROWS || 0 };
            });
            res.json(merged);
        }
        catch (e) {
            log('WARN', 'Studio', `Failed to load coverage: ${e.message?.slice(0, 200)}`);
            res.json([]);
        }
    });
    router.get('/presets', async (_req, res) => {
        try {
            const rows = await snowSql(`SELECT PRESET_ID, NAME, ORS_PROFILE, REGION, CONFIG, IS_BUILTIN, CREATED_AT
         FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS ORDER BY IS_BUILTIN DESC, CREATED_AT`, 'FLEET_INTELLIGENCE', 'CORE');
            const presets = rows.map((r) => ({
                preset_id: r.PRESET_ID,
                name: r.NAME,
                ors_profile: r.ORS_PROFILE,
                region: r.REGION,
                config: typeof r.CONFIG === 'string' ? JSON.parse(r.CONFIG) : r.CONFIG,
                is_builtin: r.IS_BUILTIN === true || r.IS_BUILTIN === 'true',
                created_at: r.CREATED_AT,
            }));
            res.json(presets);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.post('/presets', async (req, res) => {
        try {
            const { name, ors_profile, region, config } = req.body;
            if (!name || !ors_profile || !region || !config) {
                return res.status(400).json({ error: 'name, ors_profile, region, config required' });
            }
            const configJson = JSON.stringify(config).replace(/\$\$/g, '$ $');
            await snowSql(`INSERT INTO FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS (PRESET_ID, NAME, ORS_PROFILE, REGION, CONFIG)
         SELECT UUID_STRING(), '${name.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '')}', '${ors_profile}', '${region}', PARSE_JSON($$${configJson}$$)`, 'FLEET_INTELLIGENCE', 'CORE');
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.put('/presets/:id', async (req, res) => {
        try {
            const { name, ors_profile, region, config } = req.body;
            const configJson = JSON.stringify(config).replace(/\$\$/g, '$ $');
            await snowSql(`UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS
         SET NAME='${(name || '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '')}',
             ORS_PROFILE='${ors_profile || ''}',
             REGION='${region || ''}',
             CONFIG=PARSE_JSON($$${configJson}$$),
             UPDATED_AT=CURRENT_TIMESTAMP()
         WHERE PRESET_ID='${req.params.id}'`, 'FLEET_INTELLIGENCE', 'CORE');
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.delete('/presets/:id', async (req, res) => {
        try {
            await snowSql(`DELETE FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS WHERE PRESET_ID='${req.params.id}' AND IS_BUILTIN = FALSE`, 'FLEET_INTELLIGENCE', 'CORE');
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.post('/generate', async (req, res) => {
        try {
            const { preset_id, config: rawConfig, preset_name } = req.body;
            let config;
            let name;
            if (preset_id) {
                const rows = await snowSql(`SELECT NAME, ORS_PROFILE, REGION, CONFIG FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS WHERE PRESET_ID='${preset_id}'`, 'FLEET_INTELLIGENCE', 'CORE');
                if (!rows.length)
                    return res.status(404).json({ error: 'Preset not found' });
                const preset = rows[0];
                const presetConfig = typeof preset.CONFIG === 'string' ? JSON.parse(preset.CONFIG) : preset.CONFIG;
                name = preset.NAME;
                const regionRows = await snowSql(`SELECT BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY WHERE REGION_NAME='${preset.REGION}'`, 'FLEET_INTELLIGENCE', 'CORE');
                const bbox = regionRows.length ? {
                    min_lat: Number(regionRows[0].BBOX_MIN_LAT),
                    max_lat: Number(regionRows[0].BBOX_MAX_LAT),
                    min_lng: Number(regionRows[0].BBOX_MIN_LON),
                    max_lng: Number(regionRows[0].BBOX_MAX_LON),
                } : { min_lat: 37.7, max_lat: 37.82, min_lng: -122.52, max_lng: -122.35 };
                config = {
                    ...presetConfig,
                    region: preset.REGION,
                    ors_profile: preset.ORS_PROFILE,
                    bbox,
                };
            }
            else if (rawConfig) {
                config = rawConfig;
                name = preset_name || `Custom ${config.ors_profile}`;
            }
            else {
                return res.status(400).json({ error: 'preset_id or config required' });
            }
            const health = await checkOrsReadiness(snowSql, config.ors_profile);
            if (!health.ready) {
                return res.status(409).json({ error: health.error, code: 'ORS_NOT_READY' });
            }
            const jobId = await startGeneration(config, name, snowSql);
            res.json({ job_id: jobId, status: 'RUNNING' });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/jobs', async (_req, res) => {
        try {
            const memoryJobs = getJobs();
            let dbJobs = [];
            try {
                dbJobs = await snowSql(`SELECT JOB_ID, PRESET_NAME, REGION, ORS_PROFILE, NUM_VEHICLES, STATUS,
                  POINTS_GENERATED, TRIPS_GENERATED, STARTED_AT, COMPLETED_AT, ERROR_MESSAGE,
                  DATEDIFF('second', STARTED_AT, COALESCE(COMPLETED_AT, CURRENT_TIMESTAMP())) AS DURATION_SEC,
                  START_DATE, END_DATE
           FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS ORDER BY STARTED_AT DESC LIMIT 50`, 'FLEET_INTELLIGENCE', 'CORE');
            }
            catch (e) {
                log('WARN', 'Studio', `Failed to load job history: ${e.message?.slice(0, 200)}`);
            }
            res.json({ active: memoryJobs, history: dbJobs });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/jobs/:id/stream', (req, res) => {
        const jobId = req.params.id;
        const job = getJob(jobId);
        if (!job)
            return res.status(404).json({ error: 'Job not found' });
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const send = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send('status', { jobId, status: job.status, points: job.pointsGenerated, trips: job.tripsGenerated });
        if (job.status !== 'RUNNING') {
            send(job.status === 'COMPLETED' ? 'complete' : job.status === 'STOPPED' ? 'stopped' : 'error', { status: job.status });
            return res.end();
        }
        const heartbeat = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            }
            catch (e) {
                log('DEBUG', 'Studio', `Heartbeat write failed (client likely disconnected)`);
            }
        }, 15000);
        const unsub = subscribeJob(jobId, send);
        req.on('close', () => {
            clearInterval(heartbeat);
            unsub();
        });
    });
    router.post('/jobs/:id/cancel', (_req, res) => {
        const ok = cancelJob(_req.params.id);
        res.json({ ok });
    });
    router.get('/stats', async (_req, res) => {
        try {
            const rows = await snowSql(`SELECT ORS_PROFILE, VEHICLE_TYPE, REGION, COUNT(*) AS POINT_COUNT, COUNT(DISTINCT VEHICLE_ID) AS VEHICLES, COUNT(DISTINCT TRIP_ID) AS TRIPS
         FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
         GROUP BY ORS_PROFILE, VEHICLE_TYPE, REGION`, 'SYNTHETIC_DATASETS', 'UNIFIED');
            res.json(rows);
        }
        catch (e) {
            log('WARN', 'Studio', `Failed to load stats: ${e.message?.slice(0, 200)}`);
            res.json([]);
        }
    });
    return router;
}
