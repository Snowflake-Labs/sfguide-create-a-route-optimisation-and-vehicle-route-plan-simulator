// Universal-generation engine: route-optimization PLACES + LOOKUP.
//
// These two tables back the Route Optimisation demo and Overture place-search.
// PLACES is a region-scoped sample of Overture Places (one row per place with a
// primary category); LOOKUP is the small industry/skills config catalog the VRP
// job builder reads. Both are written here as first-class, JOB_ID-versioned
// generator output - exactly like anchors/demographics/hazard/demand - so that a
// single end-to-end Data Studio run is seed-complete with NO dependency on the
// external SEED_ROUTE_OPTIMIZATION_REGION stored proc (which may be absent) and
// NO blanket region re-tag (which would steal PLACES from prior datasets and
// break dataset versioning). Each run owns its own JOB_ID-tagged rows.
//
// Design mirrors engine/anchors.ts: server-side INSERT...SELECT straight from
// Overture, boundary-scoped via the shared region-source helpers, JOB_ID-stamped.

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { regionBoundaryCte, spatialFilter, sqlLit } from './region-source';
import { h3ResForArea } from './spatial';

const RO = 'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION';
const PLACES = `${RO}.PLACES`;
const LOOKUP = `${RO}.LOOKUP`;
const PLACES_COLS = '(REGION,GEOMETRY,PHONES,CATEGORY,NAME,ADDRESS,ALTERNATE,JOB_ID)';
const LOOKUP_COLS =
  '(REGION,INDUSTRY,PA,PB,PC,IND,IND2,CTYPE,STYPE,SOURCE_TABLE,DEPOT_CTYPE,DEPOT_LABEL,JOB_ID)';

// PLACES was previously a full, uncapped copy of every Overture place in the
// region (Europe = ~21-32M rows, ~5.5 min insert on every run). The only
// consumers are the route-optimization VRP demo (filters by CATEGORY; needs
// ~100+ per category) and sample-poi-points / place-search (LIMIT <= 200); no
// fleet dashboard reads PLACES. So we sample instead of cloning: keep up to
// PLACES_CAP_PER_CATEGORY rows per primary category, AND at most
// PLACES_CAP_PER_CATEGORY_CELL per (category, H3 cell) so density stays even
// across metros (a pure category cap could thin any single metro). Cuts ~21M
// to a few hundred k and the insert from minutes to seconds while preserving
// the demo's per-category density.
const PLACES_CAP_PER_CATEGORY = 1000;
const PLACES_CAP_PER_CATEGORY_CELL = 50;

export interface PlacesLookupResult {
  places: number;
  lookup: number;
}

/**
 * Insert the region's Overture Places into ROUTE_OPTIMIZATION.PLACES, stamped
 * with this run's JOB_ID. Idempotent per JOB_ID (deletes this job's rows first).
 */
async function insertPlaces(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  await snowSql(
    `DELETE FROM ${PLACES} WHERE JOB_ID = ${sqlLit(jobId)}`,
    'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
  );
  const h3Res = h3ResForArea(config.region_area_km2);
  const sql = `
    INSERT INTO ${PLACES} ${PLACES_COLS}
    WITH ${regionBoundaryCte(config.region)}
    SELECT
      ${sqlLit(config.region)},
      p.GEOMETRY,
      p.PHONES[0]::TEXT,
      p.CATEGORIES:primary::TEXT,
      p.NAMES:primary::TEXT,
      p.ADDRESSES[0],
      COALESCE(p.CATEGORIES:alternate:list, ARRAY_CONSTRUCT()),
      ${sqlLit(jobId)}
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
      LEFT JOIN region_boundary rb ON TRUE
    WHERE p.GEOMETRY IS NOT NULL
      AND p.CATEGORIES:primary IS NOT NULL
      AND ${spatialFilter('p.GEOMETRY', config.bbox)}
    QUALIFY ROW_NUMBER() OVER (
              PARTITION BY p.CATEGORIES:primary::TEXT,
                           H3_POINT_TO_CELL_STRING(p.GEOMETRY, ${h3Res})
              ORDER BY RANDOM()
            ) <= ${PLACES_CAP_PER_CATEGORY_CELL}
       AND ROW_NUMBER() OVER (
              PARTITION BY p.CATEGORIES:primary::TEXT
              ORDER BY RANDOM()
            ) <= ${PLACES_CAP_PER_CATEGORY}`;
  const rows = await snowSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
  const n = Number(rows?.[0]?.['number of rows inserted'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Insert the canonical industry/skills config rows into ROUTE_OPTIMIZATION.LOOKUP
 * for this region + JOB_ID. Region-agnostic content (the VRP job builder keys off
 * INDUSTRY), but written per-dataset so V_*_CURRENT-style consumers can scope it.
 * Idempotent per JOB_ID. Ported verbatim from the legacy
 * SEED_ROUTE_OPTIMIZATION_REGION proc's fallback INSERT.
 */
async function insertLookup(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  await snowSql(
    `DELETE FROM ${LOOKUP} WHERE JOB_ID = ${sqlLit(jobId)}`,
    'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
  );
  const r = sqlLit(config.region);
  const j = sqlLit(jobId);
  const sql = `
    INSERT INTO ${LOOKUP} ${LOOKUP_COLS}
    SELECT ${r}, 'healthcare', 'flammable', 'sharps', 'temperature-controlled',
        ARRAY_CONSTRUCT('hospital health pharmaceutical drug healthcare pharmacy surgical'),
        ARRAY_CONSTRUCT('supplies warehouse depot distribution wholesaler distributors'),
        ARRAY_CONSTRUCT('hospital', 'family_practice', 'dentist', 'pharmacy'),
        ARRAY_CONSTRUCT('Can handle potentially explosive goods', 'Can handle instruments that could be used as weapons', 'Has a fridge'),
        NULL,
        ARRAY_CONSTRUCT('warehouses', 'medical_supply', 'storage_facility'),
        'Supplier Depot', ${j}
    UNION ALL
    SELECT ${r}, 'Food', 'Fresh Food Order', 'Frozen Food Order', 'Non Perishable Food Order',
        ARRAY_CONSTRUCT('food vegetables meat'),
        ARRAY_CONSTRUCT('wholesaler warehouse factory processing distribution distributors'),
        ARRAY_CONSTRUCT('supermarket', 'restaurant', 'butcher_shop'),
        ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery'),
        NULL,
        ARRAY_CONSTRUCT('warehouses', 'food_beverage_service_distribution', 'storage_facility'),
        'Distribution Depot', ${j}
    UNION ALL
    SELECT ${r}, 'Cosmetics', 'Hair Products', 'Electronic Goods', 'Make-up',
        ARRAY_CONSTRUCT('hair cosmetics make-up beauty'),
        ARRAY_CONSTRUCT('wholesaler warehouse factory supplies distribution distributors'),
        ARRAY_CONSTRUCT('supermarket', 'outlet', 'fashion'),
        ARRAY_CONSTRUCT('Can deliver Fresh Food', 'Has a Fridge', 'Premium Delivery'),
        NULL,
        ARRAY_CONSTRUCT('warehouses', 'distribution_services', 'storage_facility'),
        'Distribution Centre', ${j}
    UNION ALL
    SELECT ${r}, 'Beverages', 'Alcoholic Beverages', 'Carbonated Drinks', 'Still Water',
        ARRAY_CONSTRUCT('beverage drink brewery distillery bottling winery'),
        ARRAY_CONSTRUCT('warehouse distribution depot factory wholesaler'),
        ARRAY_CONSTRUCT('bar', 'pub', 'restaurant', 'hotel', 'supermarket', 'convenience_store'),
        ARRAY_CONSTRUCT('Age Verification Required', 'Fragile Goods Handler', 'Heavy Load Capacity'),
        NULL,
        ARRAY_CONSTRUCT('warehouses', 'brewery', 'distillery', 'winery'),
        'Distribution Depot', ${j}
    UNION ALL
    SELECT ${r}, 'SEN Transport', 'Solo Taxi (1 child, chaperone required)', 'Shared Taxi (2-3 children)', 'Minibus (6-8 children)',
        ARRAY_CONSTRUCT('special needs school education SEN disability autism ADHD'),
        ARRAY_CONSTRUCT('school academy college nursery pupil referral unit'),
        ARRAY_CONSTRUCT('school', 'elementary_school', 'high_school', 'middle_school'),
        ARRAY_CONSTRUCT('Solo Taxi + Chaperone', 'Shared Taxi (Behavioural)', 'Accessible Minibus'),
        'FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS',
        ARRAY_CONSTRUCT('school', 'elementary_school', 'high_school', 'middle_school', 'private_school'),
        'School Destinations', ${j}`;
  const rows = await snowSql(sql, 'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION');
  const n = Number(rows?.[0]?.['number of rows inserted'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Generate route-optimization PLACES + LOOKUP for the active region, JOB_ID-scoped.
 * Returns the row counts inserted for each. Throws if PLACES yields zero rows so
 * the caller can mark the dataset NOT seed-ready (a silent empty PLACES is the
 * exact failure this generator exists to prevent).
 */
export async function generatePlacesAndLookup(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<PlacesLookupResult> {
  const places = await insertPlaces(config, snowSql, jobId);
  const lookup = await insertLookup(config, snowSql, jobId);
  if (places === 0) {
    throw new Error(
      `PLACES generation produced 0 rows for region=${config.region}. ` +
      `Check Overture Places coverage and the region boundary in REGION_CATALOG.`,
    );
  }
  return { places, lookup };
}
