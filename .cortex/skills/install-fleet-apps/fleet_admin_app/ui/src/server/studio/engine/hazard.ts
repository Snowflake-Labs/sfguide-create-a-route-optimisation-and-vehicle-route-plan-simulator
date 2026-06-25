// Wave 3 universal-generation engine: hazard / disaster zones.
//
// Emits a region-scoped, JOB_ID-versioned FACT_HAZARD_ZONES table at
// sub-county granularity using a procedural H3 hexagon grid. This replaces the
// old FEMA National Risk Index (county-level) source, which produced a single
// coarse polygon per county — too blunt for a city-scale demo (the whole city
// rendered as one risk blob). The H3 approach is:
//   * Worldwide — works for any region with a boundary polygon (or its bbox),
//     not just the US (FEMA is US-only).
//   * Granular — hundreds-to-low-thousands of hexagons per region, so the
//     choropleth shows real intra-city variation.
//   * Free + deterministic — no marketplace data dependency. The risk field is
//     a smooth low-frequency gradient + deterministic hotspots seeded by
//     region+JOB_ID, so re-runs are reproducible.
//
// Resolution is chosen in-SQL from the covered area so small regions get fine
// hexagons and large regions stay bounded (~<=1500 cells). Emits three hazard
// rows per cell: WILDFIRE, FLOOD, and COMPOSITE (blend of the two). RISK_LEVEL
// is the 1..5 ordinal; RISK_SCORE is 0..100. STATE/COUNTY/FIPS are NULL (the
// grid is not county-keyed); the per-cell H3 id lives in ZONE_ID.

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { regionBoundaryCte, sqlLit } from './region-source';

const UNIFIED = 'SYNTHETIC_DATASETS.UNIFIED';
const TARGET = `${UNIFIED}.FACT_HAZARD_ZONES`;
const COLS =
  '(ZONE_ID,REGION,STATE,COUNTY,FIPS,HAZARD_TYPE,RISK_SCORE,RISK_RATING,RISK_LEVEL,GEOM,SOURCE,JOB_ID)';
const SOURCE = 'procedural_h3';

// Map a 1..5 risk level to the FEMA-style rating label (kept for UI/agent
// continuity with the previous NRI-sourced data).
const RATING_DECODE = (lvl: string) =>
  `DECODE(${lvl},1,'Very Low',2,'Relatively Low',3,'Relatively Moderate',4,'Relatively High',5,'Very High')`;

/**
 * Generate hazard zones for the active region into FACT_HAZARD_ZONES.
 * Returns rows inserted (3 per H3 cell). Works worldwide; falls back to the
 * region bbox polygon when no catalog boundary exists.
 */
export async function generateHazardZones(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  const region = sqlLit(config.region);
  const job = sqlLit(jobId);
  const src = sqlLit(SOURCE);
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
             ST_X(H3_CELL_TO_POINT(H3)) AS LON, ST_Y(H3_CELL_TO_POINT(H3)) AS LAT
      FROM cov
    ),
    bb AS (SELECT MIN(LON) mnx, MAX(LON) mxx, MIN(LAT) mny, MAX(LAT) mxy FROM geo),
    seed AS (SELECT ABS(HASH(${region} || ${job})) AS S),
    ph AS (
      SELECT (S%628)/100.0 p1, ((S/7)%628)/100.0 p2, ((S/13)%628)/100.0 p3, ((S/17)%628)/100.0 p4,
             0.15+((S/23)%70)/100.0 fhx, 0.15+((S/29)%70)/100.0 fhy,
             0.15+((S/31)%70)/100.0 lhx, 0.15+((S/37)%70)/100.0 lhy
      FROM seed
    ),
    norm AS (
      SELECT g.H3, g.GEOM,
        CASE WHEN bb.mxx>bb.mnx THEN (g.LON-bb.mnx)/(bb.mxx-bb.mnx) ELSE 0.5 END AS nx,
        CASE WHEN bb.mxy>bb.mny THEN (g.LAT-bb.mny)/(bb.mxy-bb.mny) ELSE 0.5 END AS ny
      FROM geo g, bb
    ),
    fld AS (
      SELECT n.H3, n.GEOM,
        LEAST(1, GREATEST(0,
          0.45 + 0.33*SIN(2.6*n.nx*PI()+ph.p1)*COS(2.2*n.ny*PI()+ph.p2)
               + 0.45*EXP(-(POW(n.nx-ph.fhx,2)+POW(n.ny-ph.fhy,2))/0.02)
               + (MOD(ABS(HASH(n.H3)),100)/100.0-0.5)*0.10)) AS fire_n,
        LEAST(1, GREATEST(0,
          0.40 + 0.30*SIN(2.1*n.ny*PI()+ph.p3)*COS(2.8*n.nx*PI()+ph.p4)
               + 0.45*EXP(-(POW(n.nx-ph.lhx,2)+POW(n.ny-ph.lhy,2))/0.02)
               + (MOD(ABS(HASH(n.H3,999)),100)/100.0-0.5)*0.10)) AS flood_n
      FROM norm n, ph
    ),
    lv AS (
      SELECT H3, GEOM,
        fire_n*100 AS FIRE_S, flood_n*100 AS FLOOD_S,
        (0.5*GREATEST(fire_n,flood_n) + 0.5*((fire_n+flood_n)/2))*100 AS COMP_S,
        LEAST(5,GREATEST(1,CEIL(fire_n*100/20))) AS FIRE_L,
        LEAST(5,GREATEST(1,CEIL(flood_n*100/20))) AS FLOOD_L,
        LEAST(5,GREATEST(1,CEIL((0.5*GREATEST(fire_n,flood_n)+0.5*((fire_n+flood_n)/2))*100/20))) AS COMP_L
      FROM fld
    )
    SELECT H3::VARCHAR||'-WILDFIRE', ${region}, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR,
           'WILDFIRE', ROUND(FIRE_S,1), ${RATING_DECODE('FIRE_L')}, FIRE_L, GEOM, ${src}, ${job}
    FROM lv
    UNION ALL
    SELECT H3::VARCHAR||'-FLOOD', ${region}, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR,
           'FLOOD', ROUND(FLOOD_S,1), ${RATING_DECODE('FLOOD_L')}, FLOOD_L, GEOM, ${src}, ${job}
    FROM lv
    UNION ALL
    SELECT H3::VARCHAR||'-COMPOSITE', ${region}, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR,
           'COMPOSITE', ROUND(COMP_S,1), ${RATING_DECODE('COMP_L')}, COMP_L, GEOM, ${src}, ${job}
    FROM lv`;
  const rows = await snowSql(sql, 'SYNTHETIC_DATASETS', 'UNIFIED');
  const n = Number(rows?.[0]?.['number of rows inserted'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}
