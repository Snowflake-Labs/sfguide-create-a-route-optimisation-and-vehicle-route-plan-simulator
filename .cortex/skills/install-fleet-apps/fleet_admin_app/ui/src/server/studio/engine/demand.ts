// Wave 4 universal-generation engine: neutral demand catalog.
//
// Replaces the static, domain-specific DEMO_DEMAND_CATALOG (a pharma drug list)
// with a neutral, region-derived handling catalog. One row per distinct Overture
// BASIC_CATEGORY present in the region, assigned a deterministic 1..3 handling
// tier (hash of the category - stable across runs, no domain labels). Written
// via server-side INSERT...SELECT.

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { regionBoundaryCte, spatialFilter, sqlLit } from './region-source';

const UNIFIED = 'SYNTHETIC_DATASETS.UNIFIED';
const TARGET = `${UNIFIED}.DIM_DEMAND_CATALOG`;
const COLS = '(ITEM_ID,REGION,CATEGORY,DEMAND_TIER,TIER_LABEL,HANDLING,JOB_ID)';
// Bounds the distinct-category scan; a region rarely has > a few hundred.
const MAX_CATEGORIES = 500;

/**
 * Generate a neutral demand catalog for the active region into
 * DIM_DEMAND_CATALOG. Returns rows inserted.
 */
export async function generateDemandCatalog(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  const region = sqlLit(config.region);
  // Deterministic neutral tier from the category name.
  const tier = 'MOD(ABS(HASH(c.CATEGORY)), 3) + 1';
  const sql = `
    INSERT INTO ${TARGET} ${COLS}
    WITH ${regionBoundaryCte(config.region)},
    cats AS (
      SELECT DISTINCT p.BASIC_CATEGORY AS CATEGORY
      FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
        LEFT JOIN region_boundary rb ON TRUE
      WHERE p.BASIC_CATEGORY IS NOT NULL
        AND p.GEOMETRY IS NOT NULL
        AND ${spatialFilter('p.GEOMETRY', config.bbox)}
      LIMIT ${MAX_CATEGORIES}
    )
    SELECT
      'item-' || c.CATEGORY,
      ${region},
      c.CATEGORY,
      ${tier},
      'Tier ' || (${tier}),
      CASE ${tier} WHEN 1 THEN 'Standard' WHEN 2 THEN 'Priority' ELSE 'Specialized' END,
      ${sqlLit(jobId)}
    FROM cats c`;
  const rows = await snowSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
  const n = Number(rows?.[0]?.['number of rows inserted'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}
