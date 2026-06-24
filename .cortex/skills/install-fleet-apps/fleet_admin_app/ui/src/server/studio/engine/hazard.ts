// Wave 3 universal-generation engine: hazard / disaster zones.
//
// Generalises the emergency-response V_ZIP_RISK view into a region-scoped,
// JOB_ID-versioned FACT_HAZARD_ZONES table. Source = FEMA National Risk Index
// (county granularity) joined to Overture Divisions county polygons that
// intersect the active region boundary. This drops the fragile ZIP-code share
// dependency (the old view required a "pre-installed" U_S__ZIP_CODE share) and
// makes hazard generation work for any US region with a boundary polygon.
//
// FEMA is US-only, so this generator is a no-op (0 rows) for non-US regions.
// Emits three hazard rows per county: WILDFIRE, FLOOD (max of riverine/coastal),
// and COMPOSITE (overall NRI rating + score). RISK_LEVEL is the 1..5 ordinal
// (0 = no/insufficient rating).

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { regionBoundaryCte, sqlLit } from './region-source';

const UNIFIED = 'SYNTHETIC_DATASETS.UNIFIED';
const TARGET = `${UNIFIED}.FACT_HAZARD_ZONES`;
const NRI = 'FEMA_NATIONAL_RISK_INDEX.NRI_SCH.NRI_COUNTIES';
const DIVISIONS = 'OVERTURE_MAPS__DIVISIONS.CARTO.DIVISION_AREA';
const COLS =
  '(ZONE_ID,REGION,STATE,COUNTY,FIPS,HAZARD_TYPE,RISK_SCORE,RISK_RATING,RISK_LEVEL,GEOM,SOURCE,JOB_ID)';
const SOURCE = 'fema_nri+overture_divisions';

/**
 * Generate hazard zones for the active region into FACT_HAZARD_ZONES.
 * Returns rows inserted (0 for non-US regions / no FEMA coverage).
 */
export async function generateHazardZones(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  const region = sqlLit(config.region);
  const job = sqlLit(jobId);
  const src = sqlLit(SOURCE);
  const sql = `
    INSERT INTO ${TARGET} ${COLS}
    WITH ${regionBoundaryCte(config.region)},
    counties AS (
      SELECT div.NAMES:primary::VARCHAR AS CNAME, div.REGION AS STREG, div.GEOMETRY AS GEOM,
             ROW_NUMBER() OVER (PARTITION BY div.REGION, div.NAMES:primary::VARCHAR
                                ORDER BY ST_AREA(div.GEOMETRY) DESC) AS RN
      FROM ${DIVISIONS} div
        LEFT JOIN region_boundary rb ON TRUE
      WHERE div.COUNTRY = 'US' AND div.SUBTYPE = 'county' AND div.GEOMETRY IS NOT NULL
        AND COALESCE(ST_INTERSECTS(div.GEOMETRY, rb.BOUNDARY), TRUE)
    ),
    joined AS (
      SELECT n.STCOFIPS, n.COUNTY, n.STATEABBRV,
             n.WFIR_RISKR, n.RFLD_RISKR, n.CFLD_RISKR, n.RISK_RATNG, n.RISK_SCORE,
             c.GEOM
      FROM counties c
      JOIN ${NRI} n
        ON UPPER(n.COUNTY) = UPPER(c.CNAME) AND ('US-' || n.STATEABBRV) = c.STREG
      WHERE c.RN = 1
    ),
    rate AS (
      SELECT * FROM VALUES
        ('Very Low',1),('Relatively Low',2),('Relatively Moderate',3),
        ('Relatively High',4),('Very High',5) AS r(LABEL, LVL)
    )
    SELECT j.STCOFIPS || '-WILDFIRE', ${region}, j.STATEABBRV, j.COUNTY, j.STCOFIPS,
           'WILDFIRE', NULL::FLOAT, j.WFIR_RISKR, COALESCE(wf.LVL, 0), j.GEOM, ${src}, ${job}
    FROM joined j LEFT JOIN rate wf ON wf.LABEL = j.WFIR_RISKR
    UNION ALL
    SELECT j.STCOFIPS || '-FLOOD', ${region}, j.STATEABBRV, j.COUNTY, j.STCOFIPS,
           'FLOOD', NULL::FLOAT,
           CASE WHEN COALESCE(rf.LVL,0) >= COALESCE(cf.LVL,0) THEN j.RFLD_RISKR ELSE j.CFLD_RISKR END,
           GREATEST(COALESCE(rf.LVL,0), COALESCE(cf.LVL,0)), j.GEOM, ${src}, ${job}
    FROM joined j LEFT JOIN rate rf ON rf.LABEL = j.RFLD_RISKR LEFT JOIN rate cf ON cf.LABEL = j.CFLD_RISKR
    UNION ALL
    SELECT j.STCOFIPS || '-COMPOSITE', ${region}, j.STATEABBRV, j.COUNTY, j.STCOFIPS,
           'COMPOSITE', j.RISK_SCORE, j.RISK_RATNG, COALESCE(rr.LVL, 0), j.GEOM, ${src}, ${job}
    FROM joined j LEFT JOIN rate rr ON rr.LABEL = j.RISK_RATNG`;
  const rows = await snowSql(sql, 'SYNTHETIC_DATASETS', 'UNIFIED');
  const n = Number(rows?.[0]?.['number of rows inserted'] ?? 0);
  return Number.isFinite(n) ? n : 0;
}
