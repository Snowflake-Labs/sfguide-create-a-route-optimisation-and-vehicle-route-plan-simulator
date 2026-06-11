// /api/query — read-only SQL passthrough used by demo views.
// /api/tiles/:z/:x/:y — Carto basemap tile proxy with in-memory LRU cache.

import { Router } from 'express';
import { runSql, submitSqlAsync, fetchResultByHandle } from '../lib/sql.js';
import { log } from '../diagnostics.js';

const tileCache = new Map<string, { buf: Buffer; ts: number }>();
const TILE_CACHE_TTL = 3600_000;

const READONLY_ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'CALL', 'WITH'];

export function createQueryRouter(): Router {
  const router = Router();

  router.post('/api/query', async (req, res) => {
    try {
      const { sql, database, schema } = req.body;
      if (!sql) return res.status(400).json({ error: 'sql required' });
      const trimmed = sql.trim().replace(/;+$/, '').trim();
      const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
      if (!READONLY_ALLOWED.includes(firstWord)) {
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

  // Async submit for long-running read-only queries (e.g. multi-minute ORS
  // isochrone seeds / VROOM solves). Returns a statementHandle immediately so
  // the browser can poll /api/query-result/:handle in short requests instead
  // of holding one HTTP connection open past the SPCS ingress timeout.
  router.post('/api/query-async', async (req, res) => {
    try {
      const { sql, database, schema } = req.body;
      if (!sql) return res.status(400).json({ error: 'sql required' });
      const trimmed = sql.trim().replace(/;+$/, '').trim();
      const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
      if (!READONLY_ALLOWED.includes(firstWord)) {
        return res.status(403).json({ error: `Only read-only queries allowed. Got: ${firstWord}` });
      }
      log('INFO', 'Query', `[async submit] DB:${database} Schema:${schema} SQL:${trimmed.slice(0, 300)}`);
      const handle = await submitSqlAsync(trimmed, database, schema);
      if (!handle) return res.json({ error: 'Failed to submit query (no handle returned)' });
      res.json({ handle });
    } catch (err: any) {
      log('ERROR', 'Query', `/api/query-async error: ${err.message?.slice(0, 300)}`);
      res.json({ error: err.message });
    }
  });

  router.get('/api/query-result/:handle', async (req, res) => {
    try {
      const out = await fetchResultByHandle(req.params.handle);
      if ('status' in out) return res.json({ status: out.status });
      res.json({ result: out.rows });
    } catch (err: any) {
      log('ERROR', 'Query', `/api/query-result error: ${err.message?.slice(0, 300)}`);
      res.json({ error: err.message });
    }
  });

  router.get('/api/tiles/:z/:x/:y', async (req, res) => {
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

  return router;
}
