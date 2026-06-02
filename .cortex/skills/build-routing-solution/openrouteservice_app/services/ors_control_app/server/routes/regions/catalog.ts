// Region catalog endpoints — list catalog rows and refresh the geofabrik /
// bbbike PBF download index. The refresh handler is large because it parses
// HTML index pages, fetches bbox metadata, and bulk-INSERTs into REGION_CATALOG.
//
// For full polygon boundaries (Geofabrik MultiPolygon support, holes):
// see scripts/region_catalog/build_boundaries.py — that offline bake populates
// REGION_CATALOG.BOUNDARY for shipped regions. Newly discovered regions via
// this dynamic-refresh path will have NULL BOUNDARY until the bake re-runs.

import { Router } from 'express';
import { SF_DATABASE } from '../../constants.js';
import { runSql } from '../../lib/sql.js';
import { escapeString } from '../../lib/sanitize.js';
import { refreshRegionCatalog } from '../../lib/refresh-region-catalog.js';

export function createRegionsCatalogRouter(): Router {
  const router = Router();

  router.get('/api/regions/catalog', async (req, res) => {
    try {
      const search = (req.query.search as string || '').trim();
      const source = (req.query.source as string || '').trim();
      const level = (req.query.level as string || '').trim();
      let where = 'WHERE 1=1';
      if (search) where += ` AND LOWER(REGION_NAME) LIKE '%${escapeString(search.toLowerCase())}%'`;
      if (source) where += ` AND SOURCE = '${escapeString(source)}'`;
      if (level) where += ` AND LEVEL = '${escapeString(level)}'`;
      const rows = await runSql(`SELECT CATALOG_ID, SOURCE, REGION_NAME, REGION_KEY, HIERARCHY, CONTINENT, COUNTRY, PBF_URL, PBF_SIZE_MB, LEVEL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, CAST(ST_ASGEOJSON(BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON FROM ${SF_DATABASE}.CORE.REGION_CATALOG ${where} QUALIFY ROW_NUMBER() OVER (PARTITION BY SOURCE, REGION_KEY, COALESCE(COUNTRY,'') ORDER BY CATALOG_ID) = 1 ORDER BY SOURCE, CONTINENT, COUNTRY, REGION_NAME`);
      res.json({ catalog: rows || [] });
    } catch (err: any) {
      res.json({ catalog: [], error: err.message });
    }
  });

  router.post('/api/regions/catalog/refresh', async (_req, res) => {
    try {
      const result = await refreshRegionCatalog(runSql);
      res.json({ status: 'ok', result });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  return router;
}
