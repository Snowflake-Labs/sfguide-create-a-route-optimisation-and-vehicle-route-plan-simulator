// Wave 2 universal-generation engine: area demographics (source-with-fallback).
//
// Primary source: the free SafeGraph Open Census share (US-only, ACS 2020 census
// block groups). One row per CBG intersecting the active region. For US regions
// this yields real demographics. Outside the US (e.g. Europe) the SafeGraph
// share has no coverage, so the census insert returns 0 rows and we fall back to
// a worldwide PROCEDURAL H3 generator (mirrors engine/hazard.ts): synthetic but
// deterministic population/age/income per hexagon over the region boundary, so a
// non-US dataset is still seed-complete and the catchment/location demos work.
// The fallback only fires when the census source produced 0 rows, so US regions
// keep their real SafeGraph census untouched.
//
// SafeGraph source tables (SAFEGRAPH_OPEN_CENSUS_FREE.PUBLIC, ACS 2020):
//   2020_METADATA_CBG_GEOGRAPHIC_DATA  centroid lat/lon, land area, FIPS
//   2020_CBG_B01  sex-by-age (B01001e*) + median age (B01002e1)
//   2020_CBG_B19  median household income (B19013e1)
//   2020_CBG_GEOMETRY_WKT  CBG polygon (WKT)

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { regionBoundaryCte, sqlLit } from './region-source';
import { log } from '../../diagnostics';

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
 * Real US demographics from SafeGraph Open Census, one row per CBG intersecting
 * the region (AREA_TYPE='CBG', SOURCE='safegraph_open_census'). Returns rows
 * inserted; 0 for regions outside US census coverage.
 */
async function insertDemographicsFromCensus(
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

/**
 * Worldwide procedural fallback: one row per H3 cell covering the region boundary
 * (or its bbox), with deterministic synthetic demographics seeded by region+jobId
 * (reproducible). AREA_TYPE='H3', SOURCE='procedural_h3', STATE/COUNTY_FIPS NULL.
 * Mirrors engine/hazard.ts: area-adaptive resolution keeps large regions bounded.
 * Population = a smooth low-frequency gradient + urban hotspots, scaled to a
 * plausible people/km^2 density and multiplied by each cell's land area.
 */
async function insertDemographicsProcedural(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  const region = sqlLit(config.region);
  const job = sqlLit(jobId);
  const bx = config.bbox;
  // WKT is (lng lat) ordered. Used only when the region has no catalog polygon.
  const bboxWkt = `POLYGON((${bx.min_lng} ${bx.min_lat}, ${bx.max_lng} ${bx.min_lat}, ${bx.max_lng} ${bx.max_lat}, ${bx.min_lng} ${bx.max_lat}, ${bx.min_lng} ${bx.min_lat}))`;

  const sql = `
    INSERT INTO ${TARGET} ${COLS}
    WITH ${regionBoundaryCte(config.region)},
    area AS (
      SELECT COALESCE(
        (SELECT BOUNDARY FROM region_boundary),
        TO_GEOGRAPHY(${sqlLit(bboxWkt)})
      ) AS GEOM
    ),
    res AS (
      SELECT GEOM,
        CASE
          WHEN ST_AREA(GEOM)/1e6 <= 1105   THEN 8
          WHEN ST_AREA(GEOM)/1e6 <= 7740   THEN 7
          WHEN ST_AREA(GEOM)/1e6 <= 54000  THEN 6
          WHEN ST_AREA(GEOM)/1e6 <= 378000 THEN 5
          ELSE 4
        END AS R
      FROM area
    ),
    cov AS (
      SELECT c.value::INTEGER AS H3
      FROM res, LATERAL FLATTEN(input => H3_COVERAGE(res.GEOM, res.R)) c
    ),
    geo AS (
      SELECT H3, H3_CELL_TO_BOUNDARY(H3) AS GEOM,
             ST_X(H3_CELL_TO_POINT(H3)) AS LON, ST_Y(H3_CELL_TO_POINT(H3)) AS LAT,
             GREATEST(ST_AREA(H3_CELL_TO_BOUNDARY(H3))/1e6, 0.01) AS AREA_KM2
      FROM cov
    ),
    bb AS (SELECT MIN(LON) mnx, MAX(LON) mxx, MIN(LAT) mny, MAX(LAT) mxy FROM geo),
    seed AS (SELECT ABS(HASH(${region} || ${job})) AS S),
    ph AS (
      SELECT (S%628)/100.0 p1, ((S/7)%628)/100.0 p2,
             0.15+((S/23)%70)/100.0 hx, 0.15+((S/29)%70)/100.0 hy
      FROM seed
    ),
    norm AS (
      SELECT g.H3, g.GEOM, g.LAT, g.LON, g.AREA_KM2,
        CASE WHEN bb.mxx>bb.mnx THEN (g.LON-bb.mnx)/(bb.mxx-bb.mnx) ELSE 0.5 END AS nx,
        CASE WHEN bb.mxy>bb.mny THEN (g.LAT-bb.mny)/(bb.mxy-bb.mny) ELSE 0.5 END AS ny
      FROM geo g, bb
    ),
    dens AS (
      SELECT n.H3, n.GEOM, n.LAT, n.LON, n.AREA_KM2,
        LEAST(1, GREATEST(0,
          0.32 + 0.30*SIN(2.4*n.nx*PI()+ph.p1)*COS(2.3*n.ny*PI()+ph.p2)
               + 0.50*EXP(-(POW(n.nx-ph.hx,2)+POW(n.ny-ph.hy,2))/0.015)
               + (MOD(ABS(HASH(n.H3)),100)/100.0-0.5)*0.08)) AS dens_n
      FROM norm n, ph
    ),
    pop AS (
      SELECT H3, GEOM, LAT, LON, AREA_KM2, dens_n,
        -- people/km^2: rural ~20-120, urban hotspots up to ~4000 (dens_n^2 skews low).
        (20 + POW(dens_n,2)*3980) AS DENSITY,
        ROUND((20 + POW(dens_n,2)*3980) * AREA_KM2) AS TOTPOP
      FROM dens
    )
    SELECT
      H3::VARCHAR,
      ${region},
      'H3',
      NULL::VARCHAR,
      NULL::VARCHAR,
      LAT, LON,
      GEOM,
      TOTPOP,
      ROUND(32 + MOD(ABS(HASH(H3,7)),160)/10.0, 1),               -- MEDIAN_AGE 32.0-48.0
      28000 + MOD(ABS(HASH(H3,11)),62001),                        -- MEDIAN_HOUSEHOLD_INCOME 28k-90k
      ROUND(TOTPOP * (0.15 + MOD(ABS(HASH(H3,13)),8)/100.0)),     -- POP_ELDERLY 15-22%
      ROUND(TOTPOP * (0.16 + MOD(ABS(HASH(H3,17)),10)/100.0)),    -- POP_CHILDREN 16-25%
      ROUND(DENSITY, 1),
      'procedural_h3',
      ${job}
    FROM pop`;
  const rows = await snowSql(sql, 'SYNTHETIC_DATASETS', 'UNIFIED');
  const n = Number(rows?.[0]?.['number of rows inserted'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Generate area demographics into DIM_AREA_DEMOGRAPHICS for the active region,
 * JOB_ID-scoped and idempotent. Tries the real SafeGraph US census first; when
 * that yields 0 rows (region outside US coverage) it falls back to the worldwide
 * procedural H3 generator so every region is seed-complete. Returns rows inserted.
 */
export async function generateDemographics(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  await snowSql(
    `DELETE FROM ${TARGET} WHERE JOB_ID = ${sqlLit(jobId)}`,
    'SYNTHETIC_DATASETS', 'UNIFIED',
  );
  const census = await insertDemographicsFromCensus(config, snowSql, jobId);
  if (census > 0) {
    log('INFO', 'Studio', `Demographics: ${census} CBG rows from SafeGraph census (${config.region})`, { jobId });
    return census;
  }
  const proc = await insertDemographicsProcedural(config, snowSql, jobId);
  log('INFO', 'Studio', `Demographics: SafeGraph had no coverage for ${config.region}; inserted ${proc} procedural H3 areas (fallback)`, { jobId });
  return proc;
}
