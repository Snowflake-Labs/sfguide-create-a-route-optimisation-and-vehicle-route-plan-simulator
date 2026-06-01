// /api/observability/*
//
// Surfaces the OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG table
// populated by the ORS_METRICS_INGEST_TASK Snowflake task (see #56 and
// app/modules/08_observability.sql).
//
// Endpoints:
//   GET  /api/observability/ors-metrics       -> p50/p95/error-rate per endpoint
//   GET  /api/observability/ors-events        -> recent raw events (tail)
//   POST /api/observability/ingest-now        -> on-demand ingest (manual refresh)

import { Router } from 'express';
import { runSql, callProcedure } from '../lib/sql.js';
import { log } from '../diagnostics.js';

export function createObservabilityRouter(): Router {
  const router = Router();

  router.get('/api/observability/ors-metrics', async (_req, res) => {
    try {
      const rows = await runSql(
        `SELECT WINDOW_NAME, ENDPOINT, REQ_COUNT, ERROR_COUNT, ERROR_RATE_PCT,
                P50_MS, P95_MS, MAX_MS, AVG_MS, AVG_REQ_BYTES, AVG_RESP_BYTES,
                TO_VARCHAR(LAST_EVENT_TS) AS LAST_EVENT_TS
         FROM OPENROUTESERVICE_APP.OBSERVABILITY.V_ORS_METRICS_SUMMARY`,
      );
      res.json({ rows: rows || [] });
    } catch (err: any) {
      const msg = err?.message?.slice(0, 300) || String(err);
      log('WARN', 'Observability', `/ors-metrics failed: ${msg}`);
      res.status(500).json({ error: msg, hint: 'Confirm module 08_observability.sql has been deployed and ORS_METRICS_INGEST_TASK is resumed.' });
    }
  });

  router.get('/api/observability/ors-events', async (req, res) => {
    const limitRaw = parseInt(String(req.query.limit || '200'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
    const endpoint = String(req.query.endpoint || '').trim();
    const onlyErrors = String(req.query.errors || '').trim() === '1';
    try {
      const filters: string[] = ['REQUEST_TS >= DATEADD(hour, -24, SYSDATE())'];
      if (endpoint && /^[a-z_]+$/i.test(endpoint)) {
        filters.push(`ENDPOINT = '${endpoint.toLowerCase()}'`);
      }
      if (onlyErrors) {
        filters.push('(STATUS_CODE >= 400 OR ERROR_CODE IS NOT NULL)');
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const rows = await runSql(
        `SELECT TO_VARCHAR(REQUEST_TS) AS REQUEST_TS, REQUEST_ID, ENDPOINT, PROFILE, REGION, ORS_HOST,
                STATUS_CODE, ERROR_CODE, LATENCY_MS, REQUEST_BYTES, RESPONSE_BYTES, CALLER
         FROM OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG
         ${where}
         ORDER BY REQUEST_TS DESC
         LIMIT ${limit}`,
      );
      res.json({ rows: rows || [] });
    } catch (err: any) {
      const msg = err?.message?.slice(0, 300) || String(err);
      res.status(500).json({ error: msg });
    }
  });

  // On-demand ingest for users who want to see fresh data without waiting
  // for the 1-minute task. Calls the same procedure the task does.
  router.post('/api/observability/ingest-now', async (_req, res) => {
    try {
      const result = await callProcedure('OPENROUTESERVICE_APP.OBSERVABILITY.INGEST_ORS_METRICS(5)');
      try {
        res.json(JSON.parse(result));
      } catch {
        res.json({ raw: result });
      }
    } catch (err: any) {
      const msg = err?.message?.slice(0, 300) || String(err);
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
