// /api/diagnostics/* — log retrieval, env snapshot, connectivity probe.

import { Router } from 'express';
import { IS_SPCS, SF_DATABASE, SF_WAREHOUSE } from '../constants.js';
import { runSql } from '../lib/sql.js';
import { formatUptime } from '../lib/cache.js';
import { log, getEntries, clearEntries, getUptimeMs } from '../diagnostics.js';

export function createDiagnosticsRouter(appVersion: string): Router {
  const router = Router();

  router.get('/api/diagnostics/logs', (_req, res) => {
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

  router.get('/api/diagnostics/env', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      version: appVersion,
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

  router.get('/api/diagnostics/probe', async (_req, res) => {
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

    t = Date.now();
    try {
      await runSql('SELECT 1 FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT LIMIT 1', 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO');
      results.overtureTransportation = { ok: true, ms: Date.now() - t };
    } catch (e: any) {
      results.overtureTransportation = { ok: false, ms: Date.now() - t, detail: e.message?.slice(0, 200) };
    }

    log('INFO', 'Diagnostics', 'Connectivity probe completed', { detail: results });
    res.json(results);
  });

  router.post('/api/diagnostics/logs/clear', (_req, res) => {
    clearEntries();
    res.json({ ok: true });
  });

  return router;
}
