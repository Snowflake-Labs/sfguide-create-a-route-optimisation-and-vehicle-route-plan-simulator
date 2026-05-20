// Matrix status endpoints — job progress and built-table inventory.
// Read-only views over MATRIX_BUILD_JOBS plus a live RAW row count
// for jobs in the BUILDING stage.

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql } from '../../lib/sql.js';
import { toIso } from '../../lib/sanitize.js';

export function createMatrixStatusRouter(): Router {
  const router = Router();

  router.get('/api/matrix/status', async (_req, res) => {
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

  return router;
}
