// Matrix viewer endpoints — read-only queries against built MATRIX_RES tables.
// Includes inventory, random origin, all hexes, reachability, and ring stats.
// Local helpers (parseViewerTableName / getViewerInventory / validateViewerTable)
// are used only by these handlers.

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql } from '../../lib/sql.js';

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

export function createMatrixQueryRouter(): Router {
  const router = Router();

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

  router.get('/api/matrix/od-pair', async (req, res) => {
    try {
      const tableParam = req.query.table as string;
      const origin = req.query.origin as string;
      const dest = req.query.dest as string;
      if (!tableParam || !origin || !dest) {
        return res.status(400).json({ error: 'table, origin, dest required' });
      }
      await getViewerInventory();
      const table = validateViewerTable(tableParam);
      if (!table) return res.status(400).json({ error: 'Invalid table name' });
      const safeO = origin.replace(/[^a-fA-F0-9]/g, '');
      const safeD = dest.replace(/[^a-fA-F0-9]/g, '');
      if (safeO === safeD) {
        const ll = await runSql(
          `SELECT ST_Y(H3_CELL_TO_POINT('${safeO}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safeO}')) AS LON`
        );
        const lat = Number(ll[0]?.LAT || 0);
        const lon = Number(ll[0]?.LON || 0);
        return res.json({
          found: true,
          travel_time_secs: 0,
          distance_meters: 0,
          origin_lat: lat, origin_lon: lon,
          dest_lat: lat, dest_lon: lon,
        });
      }
      const rows = await runSql(`
        SELECT TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS,
               ST_Y(H3_CELL_TO_POINT('${safeO}')) AS O_LAT,
               ST_X(H3_CELL_TO_POINT('${safeO}')) AS O_LON,
               ST_Y(H3_CELL_TO_POINT('${safeD}')) AS D_LAT,
               ST_X(H3_CELL_TO_POINT('${safeD}')) AS D_LON
        FROM ${table}
        WHERE ORIGIN_H3 = '${safeO}' AND DEST_H3 = '${safeD}'
        LIMIT 1
      `);
      const r = rows[0];
      if (!r) return res.json({ found: false });
      res.json({
        found: true,
        travel_time_secs: Number(r.TRAVEL_TIME_SECONDS),
        distance_meters: Number(r.TRAVEL_DISTANCE_METERS),
        origin_lat: Number(r.O_LAT), origin_lon: Number(r.O_LON),
        dest_lat: Number(r.D_LAT), dest_lon: Number(r.D_LON),
      });
    } catch (err: any) {
      console.error('OD-pair error:', err.message);
      res.json({ found: false, error: err.message });
    }
  });

  router.get('/api/matrix/hex-latlon', async (req, res) => {
    try {
      const hex = req.query.hex as string;
      if (!hex) return res.status(400).json({ error: 'hex parameter required' });
      const safe = hex.replace(/[^a-fA-F0-9]/g, '');
      if (!safe) return res.status(400).json({ error: 'Invalid hex' });
      const rows = await runSql(
        `SELECT ST_Y(H3_CELL_TO_POINT('${safe}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safe}')) AS LON`
      );
      res.json({ lat: Number(rows[0]?.LAT || 0), lon: Number(rows[0]?.LON || 0) });
    } catch (err: any) {
      console.error('hex-latlon error:', err.message);
      res.json({ lat: 0, lon: 0, error: err.message });
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
