// Region registry / lookup endpoints — provisioned region listing, build
// history, retry strategy, healthcheck, and largest-family resolver. These
// are read-only views over CORE.REGION_REGISTRY / ORS_BUILD_HISTORY plus a
// few diagnostic procedure calls.

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql, callProcedure } from '../../lib/sql.js';
import { sanitizeIdentifier, toIso } from '../../lib/sanitize.js';
import { orsServiceName } from '../../lib/region.js';
import { getExpectedProfiles } from '../../lib/ors.js';

export function createRegionsRegistryRouter(): Router {
  const router = Router();

  // Returns the largest high-memory SPCS instance family available in the
  // current cloud + region. Used by the UI to show users which family will
  // back any non-city XXL build before they click Deploy.
  router.get('/api/regions/largest-family', async (_req, res) => {
    try {
      const family = (await callProcedure('RESOLVE_LARGEST_HIGHMEM_FAMILY()')) || 'HIGHMEM_X64_M';
      res.json({ family: family.trim() });
    } catch (err: any) {
      res.status(500).json({ family: 'HIGHMEM_X64_M', error: err.message });
    }
  });

  // Healthcheck for the new build-routing-solution procedures and tables.
  // Surfaces partial deploys (e.g. image updated but SQL modules skipped) so
  // the UI can warn instead of silently degrading to hardcoded fallbacks.
  router.get('/api/regions/healthcheck', async (_req, res) => {
    const status: Record<string, 'ok' | 'missing' | 'error'> = {};
    const errors: Record<string, string> = {};

    const probes: { key: string; sql: string }[] = [
      { key: 'resolver',          sql: `CALL ${SF_DATABASE}.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY()` },
      { key: 'retry_strategy',    sql: `CALL ${SF_DATABASE}.CORE.RECOMMEND_RETRY_STRATEGY('__HEALTHCHECK__')` },
      { key: 'build_history',     sql: `SELECT 1 FROM ${SF_DATABASE}.CORE.ORS_BUILD_HISTORY LIMIT 1` },
      { key: 'build_spec',        sql: `SELECT ${SF_DATABASE}.CORE.BUILD_ORS_SERVICE_SPEC('X','XXL','false')` },
      { key: 'downsize_proc',     sql: `SHOW PROCEDURES LIKE 'DOWNSIZE_REGION_AFTER_BUILD' IN SCHEMA ${SF_DATABASE}.CORE` },
    ];

    await Promise.all(probes.map(async ({ key, sql }) => {
      try {
        const rows = await runSql(sql);
        if (key === 'downsize_proc') {
          status[key] = (rows && rows.length > 0) ? 'ok' : 'missing';
        } else {
          status[key] = 'ok';
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (/does not exist|not authorized|unknown function/i.test(msg)) {
          status[key] = 'missing';
        } else {
          status[key] = 'error';
          errors[key] = msg.slice(0, 200);
        }
      }
    }));

    const overall = Object.values(status).every((v) => v === 'ok') ? 'ok' : 'degraded';
    res.json({ overall, status, errors });
  });

  // Returns the recommended retry strategy for a region whose previous build
  // failed: REUSE / REBUILD_SAME / SPLIT_PROFILES / NO_HISTORY.
  router.get('/api/regions/:region/retry-strategy', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const strategy = await callProcedure(`RECOMMEND_RETRY_STRATEGY('${safeRegion}')`);
      res.json({ region: safeRegion, strategy: (strategy || 'NO_HISTORY').trim() });
    } catch (err: any) {
      res.status(500).json({ strategy: 'NO_HISTORY', error: err.message });
    }
  });

  // Last 25 build attempts for a region from ORS_BUILD_HISTORY. Powers the UI
  // build-history card so users can see past compute size, instance family,
  // elapsed minutes, and exit status without inspecting Snowflake directly.
  router.get('/api/regions/:region/build-history', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const rows = await runSql(
        `SELECT BUILD_ID, JOB_ID, REGION, INSTANCE_FAMILY, COMPUTE_SIZE,
                PROFILES, JVM_XMX_GIB, STARTED_AT, FINISHED_AT, ELAPSED_MINUTES,
                EXIT_STATUS, PEAK_RSS_GIB, OUTPUT_GRAPH_GIB
         FROM ${SF_DATABASE}.CORE.ORS_BUILD_HISTORY
         WHERE UPPER(REGION) = UPPER('${safeRegion}')
         ORDER BY STARTED_AT DESC
         LIMIT 25`
      );
      const history = (rows || []).map((r: any) => ({
        ...r,
        STARTED_AT: toIso(r.STARTED_AT),
        FINISHED_AT: toIso(r.FINISHED_AT),
      }));
      res.json({ region: safeRegion, history });
    } catch (err: any) {
      res.status(500).json({ region: req.params.region, history: [], error: err.message });
    }
  });

  router.get('/api/regions/provisioned', async (_req, res) => {
    try {
      const result = await callProcedure('LIST_REGIONS()');
      const regions = JSON.parse(result || '[]');
      const enriched = await Promise.all(regions.map(async (c: any) => {
        let serviceStatus = 'UNKNOWN';
        try {
          const rows = await runSql(`SHOW SERVICES LIKE '${orsServiceName(c.region)}' IN SCHEMA ${SF_DATABASE}.CORE`);
          serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
        } catch { serviceStatus = 'NOT_FOUND'; }

        let bbox = c.bbox;
        let boundaryGeoJson: string | null = null;
        const bboxInvalid = !bbox
          || bbox.min_lat == null || bbox.max_lat == null || bbox.min_lon == null || bbox.max_lon == null
          || (bbox.min_lat === 0 && bbox.max_lat === 0 && bbox.min_lon === 0 && bbox.max_lon === 0);
        try {
          const safeRegion = sanitizeIdentifier(c.region);
          const catRows = await runSql(`SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, CAST(ST_ASGEOJSON(BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE UPPER(LOOKUP_NAME) = UPPER('${safeRegion}') OR UPPER(REGION_KEY) = UPPER('${safeRegion}') OR UPPER(REGION_NAME) = UPPER('${safeRegion}') ORDER BY CASE WHEN UPPER(LOOKUP_NAME) = UPPER('${safeRegion}') THEN 0 WHEN UPPER(REGION_KEY) = UPPER('${safeRegion}') THEN 1 ELSE 2 END LIMIT 1`);
          const cat = catRows?.[0];
          if (cat) {
            const catBboxOk = cat.MIN_LAT != null && cat.MAX_LAT != null && cat.MIN_LON != null && cat.MAX_LON != null
              && !(cat.MIN_LAT === 0 && cat.MAX_LAT === 0 && cat.MIN_LON === 0 && cat.MAX_LON === 0);
            if (bboxInvalid && catBboxOk) {
              bbox = { min_lat: cat.MIN_LAT, max_lat: cat.MAX_LAT, min_lon: cat.MIN_LON, max_lon: cat.MAX_LON };
            } else if (catBboxOk && bbox && cat.MIN_LAT <= bbox.min_lat && cat.MAX_LAT >= bbox.max_lat
                       && cat.MIN_LON <= bbox.min_lon && cat.MAX_LON >= bbox.max_lon) {
              // Catalog bbox is a superset of REGION_ORS_MAP bbox — prefer it so
              // road-point sampling covers the full PBF/graph extent. SF case:
              // ORS_MAP stores a narrow city-center bbox (37.71-37.81) but the
              // BBBike PBF + graph cover 37.54-37.93. Without this override,
              // road points only land in the inner bbox while the graph routes
              // a 4x larger area.
              bbox = { min_lat: cat.MIN_LAT, max_lat: cat.MAX_LAT, min_lon: cat.MIN_LON, max_lon: cat.MAX_LON };
            }
            if (cat.BOUNDARY_GEOJSON) boundaryGeoJson = cat.BOUNDARY_GEOJSON;
          }
        } catch {}

        let graphReadiness: any = null;
        if (serviceStatus === 'RUNNING' || serviceStatus === 'READY') {
          try {
            const safeRegion = sanitizeIdentifier(c.region);
            const orsRows = await runSql(`SELECT TO_VARCHAR(${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')) AS S`);
            const raw = orsRows?.[0]?.S;
            if (raw) {
              const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
              const builtProfiles = Object.keys(data.profiles || {});
              const expectedProfiles = await getExpectedProfiles(c.region);
              const allProfiles = [...new Set([...expectedProfiles, ...builtProfiles])];
              graphReadiness = {
                service_ready: data.service_ready ?? false,
                profiles_loaded: builtProfiles,
                expected_profiles: expectedProfiles,
                graphs: allProfiles.map((p: string) => ({
                  profile: p,
                  ready: builtProfiles.includes(p),
                  build_date: (data.bounds_info || {})[p]?.graph_build_date || null,
                })),
              };
            }
          } catch (e: any) {
            graphReadiness = { service_ready: false, error: e.message, profiles_loaded: [], expected_profiles: [], graphs: [] };
          }
        }

        return { ...c, isDefault: c.is_default === true, bbox, boundaryGeoJson, serviceStatus, functionExists: true, graphReadiness };
      }));

      res.json({ regions: enriched });
    } catch (err: any) {
      res.json({ regions: [], error: err.message });
    }
  });

  return router;
}
