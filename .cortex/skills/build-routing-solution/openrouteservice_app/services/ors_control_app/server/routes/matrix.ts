// Matrix endpoints — region listing, cost estimate, build/status/inventory,
// viewer queries, reachability, ring stats. Includes internal helpers
// parseViewerTableName / getViewerInventory / validateViewerTable that
// are only used by the viewer endpoints.

import { Router } from 'express';
import { SF_DATABASE } from '../constants.js';
import { runSql, callProcedure, submitSqlAsync, cancelStatement } from '../lib/sql.js';
import { sanitizeIdentifier, sanitizeFloat, sanitizeInt, escapeString, toIso } from '../lib/sanitize.js';
import { safeRegionIdent, orsServiceName } from '../lib/region.js';
import { log } from '../diagnostics.js';

export function createMatrixRouter(): Router {
  const router = Router();

  router.get('/api/matrix/regions', async (_req, res) => {
    try {
      const orsRegions = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP`);
      // Bulk-fetch boundary areas from REGION_CATALOG so we can match each
      // ORS region to its actual polygon area (used by the matrix builder
      // fast-estimate so it matches BUILD_HEXAGONS output, not bbox).
      const catalogAreas: Record<string, number> = {};
      try {
        const rows = await runSql(
          `SELECT UPPER(REGION_KEY) AS K1, UPPER(LOOKUP_NAME) AS K2, BOUNDARY_AREA_KM2 AS A
           FROM ${SF_DATABASE}.CORE.REGION_CATALOG
           WHERE BOUNDARY IS NOT NULL AND BOUNDARY_AREA_KM2 > 0`
        );
        for (const r of rows || []) {
          const a = Number(r.A);
          if (r.K1) catalogAreas[r.K1] = a;
          if (r.K2 && !catalogAreas[r.K2]) catalogAreas[r.K2] = a;
        }
      } catch {}
      const regions: any[] = [];

      for (const c of orsRegions) {
        const safeRegion = sanitizeIdentifier(c.REGION || '');
        let serviceStatus = 'NOT_FOUND';
        try {
          const rows = await runSql(`SHOW SERVICES LIKE '${orsServiceName(safeRegion)}' IN SCHEMA ${SF_DATABASE}.CORE`);
          serviceStatus = rows?.[0]?.status || 'NOT_FOUND';
        } catch {}

        const upperRegion = (c.REGION || '').toUpperCase();
        const boundaryAreaKm2 = catalogAreas[upperRegion] ?? null;

        regions.push({
          region: c.REGION, label: c.DISPLAY_NAME || c.REGION,
          bounds: { minLat: Number(c.MIN_LAT), maxLat: Number(c.MAX_LAT), minLon: Number(c.MIN_LON), maxLon: Number(c.MAX_LON) },
          boundaryAreaKm2,
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
        // v1.1.0: legacy bare ORS_SERVICE was renamed to ORS_SERVICE_SANFRANCISCO.
        const rows = await runSql(`SHOW SERVICES LIKE 'ORS_SERVICE_SANFRANCISCO' IN SCHEMA ${SF_DATABASE}.CORE`);
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
          boundaryAreaKm2: catalogAreas[defaultRegion.toUpperCase()] ?? null,
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

  router.get('/api/matrix/road-filter-available', async (_req, res) => {
    try {
      await runSql('SELECT 1 FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT LIMIT 1',
                   'OVERTURE_MAPS__TRANSPORTATION', 'CARTO');
      res.json({ available: true });
    } catch (e: any) {
      res.json({
        available: false,
        reason: 'OVERTURE_MAPS__TRANSPORTATION not accessible. Install from Snowflake Marketplace (CARTO provider) and grant IMPORTED PRIVILEGES.',
        detail: e.message?.slice(0, 200),
      });
    }
  });

  const COST_ESTIMATE_TIMEOUT_MS = 60_000;
  const MAX_CONCURRENT_ESTIMATE_QUERIES = 2;
  let activeEstimateQueries = 0;

  router.post('/api/matrix/cost-estimate', async (req, res) => {
    try {
      const { region, resolutions, profile, road_filter } = req.body;
      if (!region || !resolutions) return res.status(400).json({ error: 'region and resolutions required' });

      let safeRegion: string;
      try { safeRegion = sanitizeIdentifier(region); }
      catch { return res.status(400).json({ error: 'Invalid region' }); }

      let bbox = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
      try {
        const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
        if (cityRow?.[0]) bbox = cityRow[0];
      } catch {}

      // Polygon-aware area: prefer REGION_CATALOG.BOUNDARY_AREA_KM2 over the
      // bbox rectangle so estimates match what BUILD_HEXAGONS will actually
      // produce (California bbox = ~580k km^2 but real polygon = ~424k km^2).
      let polygonAreaSqKm: number | null = null;
      let hasPolygon = false;
      try {
        const polyRow = await runSql(
          `SELECT BOUNDARY_AREA_KM2 AS AREA
           FROM ${SF_DATABASE}.CORE.REGION_CATALOG
           WHERE BOUNDARY IS NOT NULL
             AND (UPPER(LOOKUP_NAME) = UPPER('${escapeString(safeRegion)}')
                  OR UPPER(REGION_KEY) = UPPER('${escapeString(safeRegion)}'))
           ORDER BY BOUNDARY_AREA_KM2 ASC LIMIT 1`
        );
        if (polyRow?.[0]?.AREA != null) {
          polygonAreaSqKm = Number(polyRow[0].AREA);
          hasPolygon = polygonAreaSqKm > 0;
        }
      } catch {}

      const latSpan = Math.abs(Number(bbox.MAX_LAT) - Number(bbox.MIN_LAT));
      const lonSpan = Math.abs(Number(bbox.MAX_LON) - Number(bbox.MIN_LON));
      const bboxAreaSqKm = latSpan * 111 * lonSpan * 111 * Math.cos(((Number(bbox.MIN_LAT) + Number(bbox.MAX_LAT)) / 2) * Math.PI / 180);
      const areaSqKm = hasPolygon ? polygonAreaSqKm! : bboxAreaSqKm;

      const hexAreaKm2: Record<number, number> = { 5: 252.9, 6: 36.13, 7: 5.16, 8: 0.737, 9: 0.105, 10: 0.015 };
      const pairsPerSecond = 30000;
      const computePoolNodes = 10;
      const computePoolCreditPerNodeHr = 1;
      const warehouseCreditPerHr = 10;
      const flattenCredits = 2;
      const creditPriceDollars = 3;
      const useRoadFilter = road_filter === true;

      // Polygon SQL fragment used by the road-aware estimator. When a catalog
      // polygon exists we use it for both ST_INTERSECTS (road segment filter)
      // AND ST_WITHIN (final cell-centroid clip), exactly matching
      // BUILD_HEXAGONS_ROAD_AWARE. Otherwise fall back to bbox rectangle.
      const polyExpr = hasPolygon
        ? `(SELECT BOUNDARY FROM ${SF_DATABASE}.CORE.REGION_CATALOG
           WHERE BOUNDARY IS NOT NULL
             AND (UPPER(LOOKUP_NAME) = UPPER('${escapeString(safeRegion)}')
                  OR UPPER(REGION_KEY) = UPPER('${escapeString(safeRegion)}'))
           ORDER BY BOUNDARY_AREA_KM2 ASC LIMIT 1)`
        : `TO_GEOGRAPHY('POLYGON((${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MIN_LAT)},${sanitizeFloat(bbox.MAX_LON)} ${sanitizeFloat(bbox.MIN_LAT)},${sanitizeFloat(bbox.MAX_LON)} ${sanitizeFloat(bbox.MAX_LAT)},${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MAX_LAT)},${sanitizeFloat(bbox.MIN_LON)} ${sanitizeFloat(bbox.MIN_LAT)}))')`;

      const computeEstimate = async (resolution: number) => {
        let hexCount = Math.ceil(areaSqKm / (hexAreaKm2[resolution] || 1));
        const hexCountBbox = Math.ceil(bboxAreaSqKm / (hexAreaKm2[resolution] || 1));
        let filteredApplied = false;

        if (useRoadFilter) {
          while (activeEstimateQueries >= MAX_CONCURRENT_ESTIMATE_QUERIES) {
            await new Promise(r => setTimeout(r, 200));
          }
          activeEstimateQueries++;
          try {
            const sampleClause = resolution >= 9 ? 'SAMPLE (20)' : '';
            const scaleFactor = resolution >= 9 ? 5 : 1;
            const sql = `
              WITH region_geom AS (
                SELECT ${polyExpr} AS poly
              ),
              rs AS (
                SELECT s.geometry FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT s ${sampleClause}, region_geom r
                WHERE s.subtype = 'road'
                  AND s.bbox:xmin::FLOAT <= ${sanitizeFloat(bbox.MAX_LON)} AND s.bbox:xmax::FLOAT >= ${sanitizeFloat(bbox.MIN_LON)}
                  AND s.bbox:ymin::FLOAT <= ${sanitizeFloat(bbox.MAX_LAT)} AND s.bbox:ymax::FLOAT >= ${sanitizeFloat(bbox.MIN_LAT)}
                  AND ST_INTERSECTS(s.geometry, r.poly)
              )
              SELECT COUNT(DISTINCT c.value) AS CNT
              FROM rs, TABLE(FLATTEN(H3_COVERAGE_STRINGS(rs.geometry, ${resolution}))) c, region_geom r
              WHERE ST_WITHIN(H3_CELL_TO_POINT(c.value::VARCHAR), r.poly)`;
            const rows = await runSql(sql, 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO');
            const raw = parseInt(rows?.[0]?.CNT || '0');
            if (raw > 0) {
              hexCount = raw * scaleFactor;
              filteredApplied = true;
            }
          } finally {
            activeEstimateQueries--;
          }
        }

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
          hex_count_bbox: hexCountBbox,
          road_filter_applied: filteredApplied,
          polygon_applied: hasPolygon,
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
      };

      const safeResolutions = (resolutions as number[]).filter((r) => r >= 5 && r <= 10);

      const estimatesPromise = Promise.all(safeResolutions.map(computeEstimate));
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('COST_ESTIMATE_TIMEOUT')), COST_ESTIMATE_TIMEOUT_MS)
      );

      let estimates: Awaited<ReturnType<typeof computeEstimate>>[];
      try {
        estimates = await Promise.race([estimatesPromise, timeoutPromise]);
      } catch (e: any) {
        if (e.message === 'COST_ESTIMATE_TIMEOUT') {
          return res.json({
            region: safeRegion,
            profile: profile || 'driving-car',
            road_filter: useRoadFilter,
            area_sq_km: Math.round(areaSqKm),
            resolutions: safeResolutions.map((r) => ({
              resolution: `RES${r}`,
              hex_count: Math.ceil(areaSqKm / (hexAreaKm2[r] || 1)),
              hex_count_bbox: Math.ceil(bboxAreaSqKm / (hexAreaKm2[r] || 1)),
              road_filter_applied: false,
              polygon_applied: hasPolygon,
              total_pairs: 0,
              estimated_build_time_minutes: 0,
              timed_out: true,
            })),
            error: 'Road-aware cost estimate timed out (>60s). The Overture query is too expensive for this region/resolution combination. Estimates shown use bbox approximation.',
            timed_out: true,
          });
        }
        throw e;
      }

      const totalCredits = estimates.reduce((sum, e) => sum + e.cost_breakdown.total_credits, 0);
      res.json({
        region: safeRegion,
        profile: profile || 'driving-car',
        road_filter: useRoadFilter,
        area_sq_km: Math.round(areaSqKm),
        bbox_area_sq_km: Math.round(bboxAreaSqKm),
        polygon_applied: hasPolygon,
        bbox: { min_lat: bbox.MIN_LAT, max_lat: bbox.MAX_LAT, min_lon: bbox.MIN_LON, max_lon: bbox.MAX_LON },
        resolutions: estimates,
        total_estimated_credits: Math.round(totalCredits * 10) / 10,
        total_estimated_cost_usd: Math.round(totalCredits * creditPriceDollars * 100) / 100,
        credit_price_usd: creditPriceDollars,
        note: useRoadFilter
          ? 'Road-aware estimate uses actual Overture road segments clipped to the region polygon. Res 9-10 use 20% sampling scaled 5x.'
          : (hasPolygon
              ? 'Estimates use the actual region polygon area (REGION_CATALOG.BOUNDARY). Throughput model: 30K pairs/sec on 10-node compute pool.'
              : 'Estimates based on bbox rectangle area (no REGION_CATALOG polygon match). Throughput model: 30K pairs/sec on 10-node compute pool.'),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  router.get('/api/matrix/existing', async (req, res) => {
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

  router.post('/api/matrix/build', async (req, res) => {
    const { region, resolutions, profile: reqProfile, road_filter, force } = req.body;
    if (!region || !resolutions) return res.status(400).json({ error: 'region and resolutions required' });
    const profile = reqProfile || 'driving-car';
    const roadFilter = road_filter === true;

    let safeRegion: string;
    try {
      safeRegion = sanitizeIdentifier(region);
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid region: ${err.message}` });
    }
    const safeResolutions = (resolutions as number[]).filter((r) => r >= 5 && r <= 10);
    if (safeResolutions.length === 0) return res.status(400).json({ error: 'resolutions must be between 5 and 10' });
    const safeProfile = escapeString(profile);
    const safeProfileUpper = profile.replace(/-/g, '_').toUpperCase();

    try {
      const preflightWarnings: string[] = [];
      for (const resolution of safeResolutions) {
        const listTable = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion.toUpperCase()}_${safeProfileUpper}_LIST_RES${resolution}`;
        let hexCount = 0;
        try {
          const rows = await runSql(`SELECT COUNT(*) AS CNT FROM ${listTable}`);
          hexCount = parseInt(rows?.[0]?.CNT || '0');
        } catch {
          continue;
        }
        const impliedPairs = hexCount * (hexCount - 1);
        if (impliedPairs > 10_000_000_000 && !force) {
          return res.status(422).json({
            error: `Region too large for RES${resolution}: ${hexCount.toLocaleString()} hexagons implies ${(impliedPairs / 1e9).toFixed(1)}B pairs. Split the region or use a coarser resolution. Pass force:true to override.`,
            hex_count: hexCount,
            implied_pairs: impliedPairs,
            resolution,
            requires_force: true,
          });
        }
        if (impliedPairs > 625_000_000) {
          preflightWarnings.push(`RES${resolution}: ${hexCount.toLocaleString()} hexagons (${(impliedPairs / 1e9).toFixed(1)}B pairs) — recommend XLARGE warehouse`);
        } else if (impliedPairs > 25_000_000) {
          preflightWarnings.push(`RES${resolution}: ${hexCount.toLocaleString()} hexagons (${(impliedPairs / 1e6).toFixed(0)}M pairs) — recommend LARGE warehouse`);
        }
      }

      let bbox = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
      try {
        const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`);
        if (cityRow?.[0]) bbox = cityRow[0];
      } catch {}

      let matrixFn = `${SF_DATABASE}.CORE.MATRIX_TABULAR`;
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

      res.json({
        status: 'launched',
        jobs,
        ...(preflightWarnings.length > 0 ? { warning: preflightWarnings.join('; ') } : {}),
      });

      (async () => {
        for (const { job_id: jobId, resolution } of jobs) {
          try {
            const callSql = `CALL ${SF_DATABASE}.CORE.BUILD_MATRIX_JOB_WRAPPER('${escapeString(jobId)}', 'RES${resolution}', ${sanitizeFloat(bbox.MIN_LAT)}, ${sanitizeFloat(bbox.MAX_LAT)}, ${sanitizeFloat(bbox.MIN_LON)}, ${sanitizeFloat(bbox.MAX_LON)}, '${escapeString(matrixFn)}', '${escapeString(regionDb)}', '${safeProfile}', ${roadFilter ? 'TRUE' : 'FALSE'})`;
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
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  router.get('/api/matrix/status', async (req, res) => {
    try {
      let jobs: any[] = [];
      try {
        const rows = await runSql(
          `SELECT JOB_ID, REGION, PROFILE, RESOLUTION, STATUS, STAGE,
                  HEXAGONS, WORK_QUEUE_ROWS, RAW_ROWS, MATRIX_ROWS,
                  PCT_COMPLETE, ERROR_MSG, STATEMENT_HANDLE,
                  TO_VARCHAR(CREATED_AT,   'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS CREATED_AT,
                  TO_VARCHAR(STARTED_AT,   'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS STARTED_AT,
                  TO_VARCHAR(COMPLETED_AT, 'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS COMPLETED_AT
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
          created_at: toIso(r.CREATED_AT),
          started_at: toIso(r.STARTED_AT),
          completed_at: toIso(r.COMPLETED_AT),
        }));

        // Live progress: BUILD_MATRIX_JOB_WRAPPER only updates RAW_ROWS / PCT_COMPLETE
        // at the very end of the procedure, leaving the UI at 0% for the entire
        // BUILDING stage. Compute live counts from the MATRIX_RAW table directly.
        await Promise.all(
          jobs
            .filter((j) => j.stage === 'BUILDING' && j.work_queue_rows > 0)
            .map(async (j) => {
              const safeProfile = String(j.profile || '').toUpperCase().replace(/-/g, '_');
              const safeRegion = String(j.region || '').toUpperCase();
              const rawTable = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion}_${safeProfile}_MATRIX_RAW_${j.resolution}`;
              try {
                const liveRows = await runSql(`SELECT COUNT(*) AS C FROM ${rawTable}`);
                const c = Number(liveRows?.[0]?.C) || 0;
                j.raw_rows = c;
                j.pct_complete = Math.min(100, Math.round((c * 100) / j.work_queue_rows));
              } catch {
                // raw table may not exist yet; leave fallback values
              }
            })
        );
      } catch {}
      res.json({ jobs });
    } catch (err: any) {
      res.json({ jobs: [], error: err.message });
    }
  });

  router.get('/api/matrix/inventory', async (_req, res) => {
    try {
      let roadFilterMap: Record<string, boolean> = {};
      try {
        const rfRows = await runSql(
          `SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER AS RF
           FROM (
             SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER,
                    ROW_NUMBER() OVER (PARTITION BY REGION, PROFILE, RESOLUTION ORDER BY COMPLETED_AT DESC NULLS LAST) AS RN
             FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
             WHERE STATUS = 'COMPLETE'
           ) WHERE RN = 1`
        );
        for (const r of rfRows || []) {
          const key = `${(r.REGION || '').toUpperCase()}_${(r.PROFILE || '').replace(/-/g, '_').toUpperCase()}_${r.RESOLUTION}`;
          roadFilterMap[key] = r.RF === true || r.RF === 'true';
        }
      } catch {}
      let inventory: any[] = [];
      try {
        const rows = await runSql(
          `SELECT TABLE_NAME, ROW_COUNT, BYTES,
                  TO_VARCHAR(CREATED::TIMESTAMP_LTZ, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS CREATED
           FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES
           WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX'
             AND TABLE_NAME LIKE '%_MATRIX_RES%'
             AND ROW_COUNT > 0
           ORDER BY CREATED DESC`
        );
        inventory = (rows || []).map((t: any) => {
          const name = (t.TABLE_NAME || '').toUpperCase();
          const parts = name.match(/^(.+?)_(DRIVING_CAR|DRIVING_HGV|CYCLING_ROAD|CYCLING_REGULAR|CYCLING_ELECTRIC|FOOT_WALKING|FOOT_HIKING|WHEELCHAIR)_MATRIX_(RES\d+)$/);
          if (!parts) return null;
          const tableRegion = parts[1];
          const region = tableRegion.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).replace(/ /g, '');
          const profileName = parts[2].toLowerCase().replace(/_/g, '-');
          const resolution = parts[3];
          const lookupKey = `${tableRegion}_${parts[2]}_${resolution}`;
          return { region, table_region: tableRegion, profile: profileName, resolution, row_count: parseInt(t.ROW_COUNT || '0'), bytes: parseInt(t.BYTES || '0'), created: t.CREATED || '', table_name: name, execution_time_secs: 0, road_filter: roadFilterMap[lookupKey] === true };
        }).filter(Boolean);
      } catch {}
      res.json({ inventory });
    } catch (err: any) {
      res.json({ inventory: [], error: err.message });
    }
  });

  router.delete('/api/matrix/:region/:profile/:resolution', async (req, res) => {
    try {
      const safeRegion = sanitizeIdentifier(req.params.region);
      const safeProfile = escapeString(req.params.profile);
      const safeRes = sanitizeIdentifier(req.params.resolution);
      const tablePrefix = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion}_${safeProfile.toUpperCase().replace(/-/g,'_')}_`;
      const tables = [`${tablePrefix}MATRIX_${safeRes}`, `${tablePrefix}MATRIX_RAW_${safeRes}`, `${tablePrefix}WORK_QUEUE_${safeRes}`, `${tablePrefix}LIST_${safeRes}`];
      let droppedCount = 0;
      for (const t of tables) {
        try {
          const checkRows = await runSql(`SELECT 1 FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX' AND TABLE_NAME = '${t.split('.').pop()}'`);
          if (checkRows && checkRows.length > 0) {
            await runSql(`DROP TABLE IF EXISTS ${t}`);
            droppedCount++;
          }
        } catch {}
      }
      await runSql(`DELETE FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE REGION = '${escapeString(req.params.region)}' AND PROFILE = '${safeProfile}' AND RESOLUTION = '${escapeString(safeRes)}'`);
      res.json({ status: droppedCount > 0 ? 'ok' : 'not_found', dropped_count: droppedCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/matrix/:region/:profile/:resolution/restore', async (req, res) => {
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

  router.post('/api/matrix/cancel', async (req, res) => {
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
    let roadFilterMap: Record<string, boolean> = {};
    try {
      const jobRows = await runSql(
        `SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER AS RF
         FROM (
           SELECT REGION, PROFILE, RESOLUTION, ROAD_FILTER,
                  ROW_NUMBER() OVER (PARTITION BY REGION, PROFILE, RESOLUTION ORDER BY COMPLETED_AT DESC NULLS LAST) AS RN
           FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
           WHERE STATUS = 'COMPLETE'
         ) WHERE RN = 1`
      );
      for (const r of jobRows || []) {
        const key = `${(r.REGION || '').toUpperCase()}_${(r.PROFILE || '').replace(/-/g, '_').toUpperCase()}_${r.RESOLUTION}`;
        roadFilterMap[key] = r.RF === true || r.RF === 'true';
      }
    } catch {}
    const tables = rows.map((r: any) => {
      const parsed = parseViewerTableName(r.TABLE_NAME);
      if (!parsed) return null;
      const lookupKey = `${(parsed.region || '').toUpperCase()}_${(parsed.profile || '').replace(/-/g, '_').toUpperCase()}_${parsed.resolution}`;
      return {
        ...parsed,
        row_count: parseInt(r.ROW_COUNT || '0'),
        bytes: parseInt(r.BYTES || '0'),
        table_name: r.TABLE_NAME,
        full_table: `${SF_DATABASE}.TRAVEL_MATRIX.${r.TABLE_NAME}`,
        road_filter: roadFilterMap[lookupKey] === true,
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

  router.get('/api/matrix/viewer-inventory', async (_req, res) => {
    try {
      const tables = await getViewerInventory();
      res.json({ tables });
    } catch (err: any) {
      res.json({ tables: [], error: err.message });
    }
  });

  router.get('/api/matrix/random-origin', async (req, res) => {
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

  router.get('/api/matrix/all-hexes', async (req, res) => {
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

  router.get('/api/matrix/reachability', async (req, res) => {
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
          TRAVEL_TIME_SECONDS,
          TRAVEL_DISTANCE_METERS
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

  router.get('/api/matrix/ring-stats', async (req, res) => {
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

  return router;
}
