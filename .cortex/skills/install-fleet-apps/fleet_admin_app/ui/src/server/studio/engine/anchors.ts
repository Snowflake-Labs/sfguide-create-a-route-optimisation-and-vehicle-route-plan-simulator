// Wave 1 universal-generation engine: location anchors.
//
// Anchors are the fixed real-world sites a use case routes to or from: health /
// PACE centres, key sites (branded retail), delivery stops, and a depot. They
// replace the static DEMO_DELIVERY_STOPS / DEMO_KEY_SITES / DEMO_DEPOT tables
// and the CareConnect CSV with live, region-scoped Overture data.
//
// Design: server-side INSERT...SELECT straight from Overture (no Node row
// marshalling), mirroring scripts/analytic_layer.sql. Each ANCHOR_TYPE in
// config.anchor_categories runs one bounded INSERT; the depot is the centroid
// of a bounded sample of Overture Buildings (fallback: centroid of the inserted
// anchors). All rows carry the run's JOB_ID for dataset versioning.

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { log } from '../../diagnostics';
import { regionBoundaryCte, spatialFilter, sqlLit } from './region-source';

const UNIFIED = 'SYNTHETIC_DATASETS.UNIFIED';
const ANCHORS = `${UNIFIED}.DIM_ANCHORS`;
const ANCHOR_COLS =
  '(ANCHOR_ID,REGION,ANCHOR_TYPE,NAME,CATEGORY,LAT,LNG,GEOM,ADDRESS,CITY,STATE,POSTCODE,SOURCE,JOB_ID)';

// Per-anchor-type row cap. Keeps the catalog representative without loading an
// entire metro's worth of POIs (a depot/key-site list is a curated set, not a
// density map).
const MAX_PER_TYPE = 2000;
// Buildings sampled for the depot centroid. Bounds the ST_COLLECT cost.
const DEPOT_BUILDING_SAMPLE = 5000;

// Default anchor taxonomy when a preset does not declare anchor_categories.
// Neutral, domain-agnostic Overture BASIC_CATEGORY families. Category names are
// verified against the live Overture Places taxonomy (e.g. there is no bare
// 'pharmacy'/'grocery_store' - the real values are 'pharmacy_and_drug_store',
// 'shopping_mall', etc.).
const DEFAULT_ANCHOR_CATEGORIES: Record<string, string[]> = {
  HEALTH_FACILITY: [
    'hospital', 'specialty_hospital', 'pharmacy_and_drug_store', 'urgent_care_center',
    'emergency_or_urgent_care_facility', 'primary_care_or_general_clinic', 'walk_in_clinic',
    'outpatient_care_facility', 'specialized_medical_facility', 'medical_service',
  ],
  KEY_SITE: ['shopping_mall', 'department_store', 'discount_store', 'electronics_store', 'warehouse_club_store'],
  DELIVERY_STOP: ['restaurant', 'fast_food_restaurant', 'cafe', 'coffee_shop', 'convenience_store', 'specialty_store'],
};

async function insertAnchorsForType(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
  anchorType: string,
  categories: string[],
): Promise<number> {
  if (!categories || categories.length === 0) return 0;
  const catFilter = categories.map(c => sqlLit(c)).join(',');
  // Per-type row cap: a preset may pin a small, demo-sized set for one anchor
  // type (e.g. { HEALTH_FACILITY: 10 }) via config.anchor_limits without
  // shrinking the others. Falls back to MAX_PER_TYPE. ORDER BY RANDOM() so a
  // capped set is a representative random sample, not the first N by scan order.
  const rawLimit = config.anchor_limits?.[anchorType];
  const limit = Number.isFinite(rawLimit) && (rawLimit as number) > 0
    ? Math.floor(rawLimit as number)
    : MAX_PER_TYPE;
  const sql = `
    INSERT INTO ${ANCHORS} ${ANCHOR_COLS}
    WITH ${regionBoundaryCte(config.region)}
    SELECT
      p.ID,
      ${sqlLit(config.region)},
      ${sqlLit(anchorType)},
      p.NAMES:primary::VARCHAR,
      p.BASIC_CATEGORY,
      ST_Y(p.GEOMETRY), ST_X(p.GEOMETRY), p.GEOMETRY,
      COALESCE(p.ADDRESSES[0]:freeform::VARCHAR, ''),
      p.ADDRESSES[0]:locality::VARCHAR,
      p.ADDRESSES[0]:region::VARCHAR,
      p.ADDRESSES[0]:postcode::VARCHAR,
      'overture_places',
      ${sqlLit(jobId)}
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
      LEFT JOIN region_boundary rb ON TRUE
    WHERE p.GEOMETRY IS NOT NULL
      AND p.BASIC_CATEGORY IN (${catFilter})
      AND ${spatialFilter('p.GEOMETRY', config.bbox)}
    ORDER BY RANDOM()
    LIMIT ${limit}`;
  const rows = await snowSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
  // Snowflake INSERT returns a single row with "number of rows inserted".
  const n = Number(rows?.[0]?.['number of rows inserted'] ?? rows?.[0]?.['rows_inserted'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function insertDepot(config: GenerationConfig, snowSql: SnowSqlFn, jobId: string): Promise<number> {
  // Depot = centroid of a bounded sample of Overture Buildings within the
  // region. BUILDING.GEOMETRY is a polygon, so we reduce each to its centroid
  // (ST_Y/ST_X reject polygons) and average the points. Falls back to the
  // centroid of the just-inserted anchors when Buildings is unavailable/empty.
  const region = sqlLit(config.region);
  const bldgCentroid = 'ST_CENTROID(b.GEOMETRY)';
  const buildingsSql = `
    INSERT INTO ${ANCHORS} ${ANCHOR_COLS}
    WITH ${regionBoundaryCte(config.region)},
    bldg_sample AS (
      SELECT ${bldgCentroid} AS G
      FROM OVERTURE_MAPS__BUILDINGS.CARTO.BUILDING b
        LEFT JOIN region_boundary rb ON TRUE
      WHERE b.GEOMETRY IS NOT NULL
        AND ${spatialFilter(bldgCentroid, config.bbox)}
      LIMIT ${DEPOT_BUILDING_SAMPLE}
    ),
    c AS (SELECT AVG(ST_Y(G)) AS LAT, AVG(ST_X(G)) AS LNG, COUNT(*) AS N FROM bldg_sample)
    SELECT
      'depot-' || ${region},
      ${region},
      'DEPOT',
      'Central Depot',
      NULL,
      c.LAT, c.LNG, ST_MAKEPOINT(c.LNG, c.LAT),
      NULL, NULL, NULL, NULL,
      'overture_buildings_centroid',
      ${sqlLit(jobId)}
    FROM c
    WHERE c.N > 0`;
  try {
    const rows = await snowSql(buildingsSql, 'OVERTURE_MAPS__BUILDINGS', 'CARTO');
    const n = Number(rows?.[0]?.['number of rows inserted'] ?? 0);
    if (n > 0) return n;
  } catch (e: any) {
    log('WARN', 'Studio', `Depot from Buildings failed, falling back to anchor centroid: ${e.message?.slice(0, 160)}`, { jobId });
  }
  // Fallback: centroid of the anchors already inserted for this job.
  const fallbackSql = `
    INSERT INTO ${ANCHORS} ${ANCHOR_COLS}
    SELECT
      'depot-' || ${region}, ${region}, 'DEPOT', 'Central Depot', NULL,
      AVG(LAT), AVG(LNG), ST_MAKEPOINT(AVG(LNG), AVG(LAT)),
      NULL, NULL, NULL, NULL, 'anchor_centroid', ${sqlLit(jobId)}
    FROM ${ANCHORS}
    WHERE REGION = ${region} AND JOB_ID = ${sqlLit(jobId)} AND ANCHOR_TYPE <> 'DEPOT'
    HAVING COUNT(*) > 0`;
  try {
    const rows = await snowSql(fallbackSql, 'SYNTHETIC_DATASETS', 'UNIFIED');
    return Number(rows?.[0]?.['number of rows inserted'] ?? 0);
  } catch (e: any) {
    log('WARN', 'Studio', `Depot fallback failed (non-fatal): ${e.message?.slice(0, 160)}`, { jobId });
    return 0;
  }
}

/**
 * Generate location anchors for the active region into DIM_ANCHORS.
 * Returns the total number of anchor rows inserted (including the depot).
 */
export async function generateAnchors(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  const cats = config.anchor_categories && Object.keys(config.anchor_categories).length > 0
    ? config.anchor_categories
    : DEFAULT_ANCHOR_CATEGORIES;
  let total = 0;
  for (const [anchorType, categories] of Object.entries(cats)) {
    try {
      const n = await insertAnchorsForType(config, snowSql, jobId, anchorType, categories);
      total += n;
      log('INFO', 'Studio', `Anchors: inserted ${n} ${anchorType}`, { jobId, detail: { categories } });
    } catch (e: any) {
      log('WARN', 'Studio', `Anchor type ${anchorType} failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
    }
  }
  total += await insertDepot(config, snowSql, jobId);
  return total;
}
