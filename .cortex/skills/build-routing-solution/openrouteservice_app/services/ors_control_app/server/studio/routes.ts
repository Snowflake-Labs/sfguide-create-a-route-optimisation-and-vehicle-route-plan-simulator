import { Router } from 'express';
import { getJobs, getJob, cancelJob, subscribeJob, startGeneration, deleteJobData, getJobEvents } from './jobs.js';
import { GenerationConfig, PROFILE_TEMPLATES } from './profiles.js';
import { log } from '../diagnostics.js';
import { normalizeRegion } from '../lib/region.js';

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

type Bbox = { min_lat: number; max_lat: number; min_lng: number; max_lng: number };

// Single source of truth for the bbox passed to the synthetic data engine.
// ALWAYS resolves bbox from REGION_REGISTRY (preferred) or REGION_CATALOG
// (fallback) by region name. Throws if neither exists. Any client-supplied
// bbox is intentionally ignored to avoid hardcoded SF/Germany fallbacks
// silently leaking into other regions (issue: California data generated
// inside SF bbox because the React client hardcoded SF as the catch-all).
async function resolveRegionBbox(region: string, snowSql: SnowSqlFn): Promise<Bbox> {
  const safeRegion = region.replace(/'/g, "''");
  const regionRows = await snowSql(
    `SELECT
       COALESCE(rr.BBOX_MIN_LAT, rc.MIN_LAT) AS BBOX_MIN_LAT,
       COALESCE(rr.BBOX_MAX_LAT, rc.MAX_LAT) AS BBOX_MAX_LAT,
       COALESCE(rr.BBOX_MIN_LON, rc.MIN_LON) AS BBOX_MIN_LON,
       COALESCE(rr.BBOX_MAX_LON, rc.MAX_LON) AS BBOX_MAX_LON
     FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY rr
     LEFT JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
       ON UPPER(rc.LOOKUP_NAME) = UPPER(rr.ORS_REGION_KEY)
       OR UPPER(rc.REGION_KEY)  = UPPER(rr.ORS_REGION_KEY)
     WHERE rr.REGION_NAME='${safeRegion}'
     QUALIFY ROW_NUMBER() OVER (ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC) = 1`,
    'FLEET_INTELLIGENCE', 'CORE'
  ).catch(() => [] as any[]);
  let bbox: Bbox | null = regionRows.length ? {
    min_lat: Number(regionRows[0].BBOX_MIN_LAT),
    max_lat: Number(regionRows[0].BBOX_MAX_LAT),
    min_lng: Number(regionRows[0].BBOX_MIN_LON),
    max_lng: Number(regionRows[0].BBOX_MAX_LON),
  } : null;
  if (!bbox || [bbox.min_lat, bbox.max_lat, bbox.min_lng, bbox.max_lng].some(v => v == null || Number.isNaN(v))) {
    const catalogOnly = await snowSql(
      `SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON
       FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
       WHERE UPPER(LOOKUP_NAME)=UPPER('${safeRegion}')
          OR UPPER(REGION_KEY)=UPPER('${safeRegion}')
       QUALIFY ROW_NUMBER() OVER (ORDER BY COALESCE(BOUNDARY_AREA_KM2, 1e15) ASC) = 1`,
      'OPENROUTESERVICE_APP', 'CORE'
    ).catch(() => [] as any[]);
    if (catalogOnly.length) {
      bbox = {
        min_lat: Number(catalogOnly[0].MIN_LAT),
        max_lat: Number(catalogOnly[0].MAX_LAT),
        min_lng: Number(catalogOnly[0].MIN_LON),
        max_lng: Number(catalogOnly[0].MAX_LON),
      };
    }
  }
  if (!bbox || [bbox.min_lat, bbox.max_lat, bbox.min_lng, bbox.max_lng].some(v => v == null || Number.isNaN(v))) {
    throw new Error(`No bbox registered for region '${region}'. Add it to FLEET_INTELLIGENCE.CORE.REGION_REGISTRY (or OPENROUTESERVICE_APP.CORE.REGION_CATALOG) before generating data.`);
  }
  return bbox;
}

async function checkOrsReadiness(
  snowSql: SnowSqlFn,
  orsProfile: string,
  region: string,
): Promise<{ ready: boolean; error?: string }> {
  try {
    // Use the 1-arg ORS_STATUS(region) overload so the gateway routes the
    // status check to the per-region ORS service (e.g. ors-service-california).
    // Default region is normalized to DEFAULT_REGION_NAME (SanFrancisco) so it
    // hits ors-service-sanfrancisco the same as any other region.
    const resolvedRegion = normalizeRegion(region);
    const sql = `SELECT TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS('${resolvedRegion.replace(/'/g, "''")}')) AS STATUS`;
    const rows = await snowSql(sql);
    const raw = rows[0]?.STATUS;
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!status?.service_ready) {
      log('WARN', 'ORS', `ORS readiness check failed for region "${region}": service not ready (profile: ${orsProfile})`);
      return { ready: false, error: `ORS service for region "${region}" is not running (suspended or starting up). Resume it from the Service Lifecycle page or the Region Builder before generating.` };
    }
    const profiles = Object.keys(status.profiles || {});
    if (!profiles.includes(orsProfile)) {
      log('WARN', 'ORS', `ORS profile "${orsProfile}" not built for region "${region}". Available: ${profiles.join(', ')}`);
      return { ready: false, error: `ORS profile "${orsProfile}" is not built for region "${region}". Available profiles: ${profiles.join(', ') || 'none'}. Build the graph for this profile first.` };
    }
  } catch (e: any) {
    log('ERROR', 'ORS', `ORS readiness check exception for region "${region}": ${e.message?.slice(0, 200)}`);
    return { ready: false, error: `Cannot reach ORS service for region "${region}": ${e.message?.slice(0, 120)}. The app may not be installed.` };
  }
  return { ready: true };
}

export function createStudioRouter(snowSql: SnowSqlFn): Router {
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
      const rows = await snowSql(
        `SELECT REGION_NAME, BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON, ORS_PROFILES, STATUS
         FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY ORDER BY REGION_NAME`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
      res.json(rows);
    } catch (e: any) {
      log('WARN', 'Studio', `Failed to load regions: ${e.message?.slice(0, 200)}`);
      res.json([]);
    }
  });

  router.get('/coverage', async (_req, res) => {
    try {
      const telemetryStats = await snowSql(
        `SELECT VEHICLE_TYPE, REGION, ORS_PROFILE,
                COUNT(*) AS TELEMETRY_ROWS,
                COUNT(DISTINCT VEHICLE_ID) AS VEHICLES,
                COUNT(DISTINCT TRIP_ID) AS TRIPS
         FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
         GROUP BY VEHICLE_TYPE, REGION, ORS_PROFILE`,
        'SYNTHETIC_DATASETS', 'UNIFIED'
      );
      let tripStats: any[] = [];
      try {
        tripStats = await snowSql(
          `SELECT VEHICLE_TYPE, REGION, COUNT(*) AS TRIP_ROWS
           FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS
           GROUP BY VEHICLE_TYPE, REGION`,
          'SYNTHETIC_DATASETS', 'UNIFIED'
        );
      } catch (e: any) {
        log('WARN', 'Studio', `Failed to load trip stats for coverage: ${e.message?.slice(0, 200)}`);
      }
      const merged = telemetryStats.map((t: any) => {
        const ts = tripStats.find((s: any) => s.VEHICLE_TYPE === t.VEHICLE_TYPE && s.REGION === t.REGION);
        return { ...t, TRIP_ROWS: ts?.TRIP_ROWS || 0 };
      });
      res.json(merged);
    } catch (e: any) {
      log('WARN', 'Studio', `Failed to load coverage: ${e.message?.slice(0, 200)}`);
      res.json([]);
    }
  });

  router.get('/presets', async (_req, res) => {
    try {
      const rows = await snowSql(
        `SELECT PRESET_ID, NAME, ORS_PROFILE, REGION, CONFIG, IS_BUILTIN, CREATED_AT
         FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS ORDER BY IS_BUILTIN DESC, CREATED_AT`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
      const presets = rows.map((r: any) => ({
        preset_id: r.PRESET_ID,
        name: r.NAME,
        ors_profile: r.ORS_PROFILE,
        region: r.REGION,
        config: typeof r.CONFIG === 'string' ? JSON.parse(r.CONFIG) : r.CONFIG,
        is_builtin: r.IS_BUILTIN === true || r.IS_BUILTIN === 'true',
        created_at: r.CREATED_AT,
      }));
      res.json(presets);
    } catch (err: any) {
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
      await snowSql(
        `INSERT INTO FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS (PRESET_ID, NAME, ORS_PROFILE, REGION, CONFIG)
         SELECT UUID_STRING(), '${name.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '')}', '${ors_profile}', '${region}', PARSE_JSON($$${configJson}$$)`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/presets/:id', async (req, res) => {
    try {
      const { name, ors_profile, region, config } = req.body;
      const configJson = JSON.stringify(config).replace(/\$\$/g, '$ $');
      await snowSql(
        `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS
         SET NAME='${(name || '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '')}',
             ORS_PROFILE='${ors_profile || ''}',
             REGION='${region || ''}',
             CONFIG=PARSE_JSON($$${configJson}$$),
             UPDATED_AT=SYSDATE()
         WHERE PRESET_ID='${req.params.id}'`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/presets/:id', async (req, res) => {
    try {
      await snowSql(
        `DELETE FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS WHERE PRESET_ID='${req.params.id}' AND IS_BUILTIN = FALSE`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/generate', async (req, res) => {
    try {
      const { preset_id, config: rawConfig, preset_name } = req.body;
      let config: GenerationConfig;
      let name: string;

      if (preset_id) {
        const rows = await snowSql(
          `SELECT NAME, ORS_PROFILE, REGION, CONFIG FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS WHERE PRESET_ID='${preset_id}'`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
        if (!rows.length) return res.status(404).json({ error: 'Preset not found' });
        const preset = rows[0];
        const presetConfig = typeof preset.CONFIG === 'string' ? JSON.parse(preset.CONFIG) : preset.CONFIG;
        name = preset.NAME;
        config = {
          ...presetConfig,
          region: preset.REGION,
          ors_profile: preset.ORS_PROFILE,
        };
      } else if (rawConfig) {
        config = rawConfig;
        name = preset_name || `Custom ${config.ors_profile}`;
      } else {
        return res.status(400).json({ error: 'preset_id or config required' });
      }

      // Single source of truth: bbox is ALWAYS resolved from REGION_REGISTRY
      // by region name, regardless of code path. This prevents stale or
      // hardcoded client bboxes (e.g. SF default) from being used for other
      // regions like California, France, Spain, etc.
      try {
        config.bbox = await resolveRegionBbox(config.region, snowSql);
      } catch (e: any) {
        return res.status(400).json({ error: e.message, code: 'REGION_NOT_REGISTERED' });
      }

      const health = await checkOrsReadiness(snowSql, config.ors_profile, config.region);
      if (!health.ready) {
        return res.status(409).json({ error: health.error, code: 'ORS_NOT_READY' });
      }

      const jobId = await startGeneration(config, name, snowSql);
      res.json({ job_id: jobId, status: 'RUNNING' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/jobs', async (_req, res) => {
    try {
      const memoryJobs = getJobs();
      let dbJobs: any[] = [];
      try {
        dbJobs = await snowSql(
          `SELECT JOB_ID, PRESET_NAME, REGION, ORS_PROFILE, NUM_VEHICLES, STATUS,
                  POINTS_GENERATED, TRIPS_GENERATED,
                  TO_VARCHAR(CONVERT_TIMEZONE('UTC', STARTED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS STARTED_AT,
                  TO_VARCHAR(CONVERT_TIMEZONE('UTC', COMPLETED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS COMPLETED_AT,
                  ERROR_MESSAGE,
                  DATEDIFF('second', STARTED_AT, COALESCE(COMPLETED_AT, SYSDATE())) AS DURATION_SEC,
                  START_DATE, END_DATE
           FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS WHERE STATUS != 'DELETED' ORDER BY STARTED_AT DESC LIMIT 50`,
          'FLEET_INTELLIGENCE', 'CORE'
        );
      } catch (e: any) {
        log('WARN', 'Studio', `Failed to load job history: ${e.message?.slice(0, 200)}`);
      }
      res.json({ active: memoryJobs, history: dbJobs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/jobs/:id/stream', (req, res) => {
    const jobId = req.params.id;
    const job = getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: any) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('status', { jobId, status: job.status, points: job.pointsGenerated, trips: job.tripsGenerated });

    // Replay buffered events so reconnecting clients see the full history
    for (const ev of job.events) {
      send(ev.event, { ...ev.data, _replay: true, _ts: ev.ts });
    }
    send('replay-end', { jobId, count: job.events.length });

    if (job.status !== 'RUNNING') {
      send(job.status === 'COMPLETED' ? 'complete' : job.status === 'STOPPED' ? 'stopped' : 'error', { status: job.status });
      return res.end();
    }

    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (e: any) {
        log('DEBUG', 'Studio', `Heartbeat write failed (client likely disconnected)`);
      }
    }, 15000);

    const unsub = subscribeJob(jobId, send);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsub();
    });
  });

  router.get('/jobs/:id/logs', async (req, res) => {
    const jobId = req.params.id;
    try {
      const events = getJobEvents(jobId);
      if (events) {
        const job = getJob(jobId)!;
        return res.json({
          jobId,
          source: 'memory',
          status: job.status,
          pointsGenerated: job.pointsGenerated,
          tripsGenerated: job.tripsGenerated,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          error: job.error,
          events,
        });
      }
      const rows = await snowSql(
        `SELECT JOB_ID, STATUS, POINTS_GENERATED, TRIPS_GENERATED, ERROR_MESSAGE,
                TO_VARCHAR(CONVERT_TIMEZONE('UTC', STARTED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS STARTED_AT,
                TO_VARCHAR(CONVERT_TIMEZONE('UTC', COMPLETED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS COMPLETED_AT,
                LOG_TEXT
         FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS WHERE JOB_ID = '${jobId.replace(/'/g, "''")}'`,
        'FLEET_INTELLIGENCE', 'CORE'
      );
      if (!rows.length) return res.status(404).json({ error: 'Job not found' });
      const row = rows[0];
      const logRaw = row.LOG_TEXT;
      const log = typeof logRaw === 'string' ? (logRaw ? JSON.parse(logRaw) : null) : logRaw;
      res.json({
        jobId,
        source: 'db',
        status: row.STATUS,
        pointsGenerated: row.POINTS_GENERATED,
        tripsGenerated: row.TRIPS_GENERATED,
        startedAt: row.STARTED_AT,
        completedAt: row.COMPLETED_AT,
        error: row.ERROR_MESSAGE,
        events: log?.events || [],
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/jobs/:id/cancel', async (_req, res) => {
    const result = await cancelJob(_req.params.id, snowSql);
    if (!result.ok) {
      const code = result.mode === 'not-found' ? 404 : result.mode === 'error' ? 500 : 409;
      return res.status(code).json(result);
    }
    res.json(result);
  });

  router.delete('/jobs/:id', async (req, res) => {
    try {
      const job = getJob(req.params.id);
      if (job && job.status === 'RUNNING') {
        return res.status(409).json({ error: 'Cannot delete data for a running job. Cancel it first.' });
      }
      const result = await deleteJobData(req.params.id, snowSql);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/stats', async (_req, res) => {
    try {
      const rows = await snowSql(
        `SELECT ORS_PROFILE, VEHICLE_TYPE, REGION, COUNT(*) AS POINT_COUNT, COUNT(DISTINCT VEHICLE_ID) AS VEHICLES, COUNT(DISTINCT TRIP_ID) AS TRIPS
         FROM SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY
         GROUP BY ORS_PROFILE, VEHICLE_TYPE, REGION`,
        'SYNTHETIC_DATASETS', 'UNIFIED'
      );
      res.json(rows);
    } catch (e: any) {
      log('WARN', 'Studio', `Failed to load stats: ${e.message?.slice(0, 200)}`);
      res.json([]);
    }
  });

  return router;
}
