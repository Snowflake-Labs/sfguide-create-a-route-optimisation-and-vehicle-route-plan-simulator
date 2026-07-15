// Wave 2 universal-generation engine: area demographics.
//
// Replaces the static DEMO_AREA_DEMOGRAPHICS table with live, region-scoped
// US Census demographics from the free SafeGraph Open Census share (full
// coverage: 242k census block groups). One row per CBG intersecting the active
// region, written via server-side INSERT...SELECT (no Node marshalling).
//
// Source tables (SAFEGRAPH_OPEN_CENSUS_FREE.PUBLIC, ACS 2020):
//   2020_METADATA_CBG_GEOGRAPHIC_DATA  centroid lat/lon, land area, FIPS
//   2020_CBG_B01  sex-by-age (B01001e*) + median age (B01002e1)
//   2020_CBG_B19  median household income (B19013e1)
//   2020_CBG_GEOMETRY_WKT  CBG polygon (WKT)
// Children (<18) and elderly (65+) are summed from the B01001 age brackets so
// the generator depends on a single demographic table. Table/column identifiers
// are quoted (digit-leading names, mixed-case ACS columns).

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { regionBoundaryCte, sqlLit } from './region-source';

const UNIFIED = 'SYNTHETIC_DATASETS.UNIFIED';
const TARGET = `${UNIFIED}.DIM_AREA_DEMOGRAPHICS`;
const SG = 'SAFEGRAPH_OPEN_CENSUS_FREE.PUBLIC';
const COLS =
  '(AREA_ID,REGION,AREA_TYPE,STATE_FIPS,COUNTY_FIPS,LAT,LNG,GEOM,' +
  'TOTAL_POPULATION,MEDIAN_AGE,MEDIAN_HOUSEHOLD_INCOME,POP_ELDERLY,POP_CHILDREN,POPULATION_DENSITY,SOURCE,JOB_ID)';

// 65+ : male 65-66,67-69,70-74,75-79,80-84,85+ (e20-e25) + female (e44-e49).
const ELDERLY = ['B01001e20', 'B01001e21', 'B01001e22', 'B01001e23', 'B01001e24', 'B01001e25',
  'B01001e44', 'B01001e45', 'B01001e46', 'B01001e47', 'B01001e48', 'B01001e49']
  .map(c => `b01."${c}"`).join('+');
// <18 : male <5,5-9,10-14,15-17 (e3-e6) + female (e27-e30).
const CHILDREN = ['B01001e3', 'B01001e4', 'B01001e5', 'B01001e6',
  'B01001e27', 'B01001e28', 'B01001e29', 'B01001e30']
  .map(c => `b01."${c}"`).join('+');

/**
 * Generate area demographics (one row per census block group intersecting the
 * region) into DIM_AREA_DEMOGRAPHICS. Returns rows inserted.
 */
export async function generateDemographics(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  const region = sqlLit(config.region);
  const { bbox } = config;
  const sql = `
    INSERT INTO ${TARGET} ${COLS}
    WITH ${regionBoundaryCte(config.region)}
    SELECT
      m.CENSUS_BLOCK_GROUP,
      ${region},
      'CBG',
      g.STATE_FIPS,
      g.COUNTY_FIPS,
      m.LATITUDE, m.LONGITUDE,
      TRY_TO_GEOGRAPHY(g.GEOMETRY),
      b01."B01001e1",
      b01."B01002e1",
      b19."B19013e1",
      (${ELDERLY}),
      (${CHILDREN}),
      CASE WHEN m.AMOUNT_LAND > 0 THEN b01."B01001e1" / (m.AMOUNT_LAND / 1000000.0) ELSE NULL END,
      'safegraph_open_census',
      ${sqlLit(jobId)}
    FROM ${SG}."2020_METADATA_CBG_GEOGRAPHIC_DATA" m
    JOIN ${SG}."2020_CBG_B01" b01 ON b01.CENSUS_BLOCK_GROUP = m.CENSUS_BLOCK_GROUP
    LEFT JOIN ${SG}."2020_CBG_B19" b19 ON b19.CENSUS_BLOCK_GROUP = m.CENSUS_BLOCK_GROUP
    LEFT JOIN ${SG}."2020_CBG_GEOMETRY_WKT" g ON g.CENSUS_BLOCK_GROUP = m.CENSUS_BLOCK_GROUP
    LEFT JOIN region_boundary rb ON TRUE
    WHERE m.LATITUDE BETWEEN ${bbox.min_lat} AND ${bbox.max_lat}
      AND m.LONGITUDE BETWEEN ${bbox.min_lng} AND ${bbox.max_lng}
      AND COALESCE(ST_INTERSECTS(ST_MAKEPOINT(m.LONGITUDE, m.LATITUDE), rb.BOUNDARY), TRUE)`;
  const rows = await snowSql(sql, 'SAFEGRAPH_OPEN_CENSUS_FREE', 'PUBLIC');
  const n = Number(rows?.[0]?.['number of rows inserted'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}
