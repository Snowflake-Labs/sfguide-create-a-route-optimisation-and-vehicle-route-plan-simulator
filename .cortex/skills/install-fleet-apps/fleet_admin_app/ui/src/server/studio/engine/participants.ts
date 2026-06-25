// Universal-generation engine: participant/passenger locations.
//
// Participants are a raw sample of real Overture addresses within a straight-line
// radius (participant_radius_km, via ST_DWITHIN) of the region's HEALTH_FACILITY
// anchors. They replace the runtime random-point sampling that TOOL_EVAC_SEED
// used to do: the persisted raw sample is generated here at build time, and the
// emergency-response wizard's isochrone step filters it at demo time.
//
// Design mirrors engine/anchors.ts: a single server-side INSERT...SELECT straight
// from Overture (no Node row marshalling). Reads the centers just inserted for
// this run (same JOB_ID) so it MUST run after generateAnchors. All rows carry the
// run's JOB_ID for dataset versioning.

import type { SnowSqlFn } from './types';
import type { GenerationConfig } from '../profiles';
import { log } from '../../diagnostics';
import { sqlLit } from './region-source';

const UNIFIED = 'SYNTHETIC_DATASETS.UNIFIED';
const ANCHORS = `${UNIFIED}.DIM_ANCHORS`;
const PARTICIPANTS = `${UNIFIED}.DIM_PARTICIPANTS`;
const ADDRESSES = 'OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS';
const PARTICIPANT_COLS =
  '(PARTICIPANT_ID,REGION,LAT,LNG,GEOM,ADDRESS,CITY,STATE,POSTCODE,NEAREST_ANCHOR_ID,SOURCE,JOB_ID)';

const DEFAULT_RADIUS_KM = 50;
const DEFAULT_SAMPLE_SIZE = 3000;

/**
 * Generate participant/passenger locations for the active region into
 * DIM_PARTICIPANTS. Samples real Overture addresses within
 * participant_radius_km of this run's HEALTH_FACILITY anchors and tags each
 * with its nearest center. Returns the number of participant rows inserted.
 */
export async function generateParticipants(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  jobId: string,
): Promise<number> {
  const region = sqlLit(config.region);
  const radiusKm = Number.isFinite(config.participant_radius_km) && (config.participant_radius_km as number) > 0
    ? (config.participant_radius_km as number)
    : DEFAULT_RADIUS_KM;
  const radiusM = Math.round(radiusKm * 1000);
  const sampleSize = Number.isFinite(config.participant_sample_size) && (config.participant_sample_size as number) > 0
    ? Math.floor(config.participant_sample_size as number)
    : DEFAULT_SAMPLE_SIZE;

  // 1. centers: the HEALTH_FACILITY anchors generated for THIS run.
  // 2. cand: Overture addresses spatially joined to the centers within radiusM,
  //    deduped to the nearest center per address (QUALIFY rn=1) -> also yields
  //    NEAREST_ANCHOR_ID. A correlated EXISTS with a spatial predicate cannot be
  //    decorrelated by Snowflake ("Unsupported subquery type"), so this MUST be a
  //    spatial JOIN, not WHERE EXISTS(... ST_DWITHIN ...).
  // 3. samp: random subsample down to sampleSize distinct addresses.
  const sql = `
    INSERT INTO ${PARTICIPANTS} ${PARTICIPANT_COLS}
    WITH centers AS (
      SELECT ANCHOR_ID, GEOM
      FROM ${ANCHORS}
      WHERE REGION = ${region}
        AND JOB_ID = ${sqlLit(jobId)}
        AND ANCHOR_TYPE = 'HEALTH_FACILITY'
        AND GEOM IS NOT NULL
    ),
    cand AS (
      SELECT a.ID AS AID, a.GEOMETRY AS G,
             a.STREET AS STREET, a.NUMBER AS NUM,
             a.POSTAL_CITY AS CITY, a.POSTCODE AS PC,
             c.ANCHOR_ID AS NEAREST
      FROM ${ADDRESSES} a
      JOIN centers c ON ST_DWITHIN(a.GEOMETRY, c.GEOM, ${radiusM})
      WHERE a.GEOMETRY IS NOT NULL
      QUALIFY ROW_NUMBER() OVER (PARTITION BY a.ID ORDER BY ST_DISTANCE(a.GEOMETRY, c.GEOM)) = 1
    ),
    samp AS (
      SELECT * FROM cand ORDER BY RANDOM() LIMIT ${sampleSize}
    )
    SELECT
      AID,
      ${region},
      ST_Y(G), ST_X(G), G,
      NULLIF(TRIM(COALESCE(NUM, '') || ' ' || COALESCE(STREET, '')), ''),
      CITY,
      NULL,
      PC,
      NEAREST,
      'overture_addresses',
      ${sqlLit(jobId)}
    FROM samp`;
  try {
    const rows = await snowSql(sql, 'OVERTURE_MAPS__ADDRESSES', 'CARTO');
    const n = Number(rows?.[0]?.['number of rows inserted'] ?? rows?.[0]?.['rows_inserted'] ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch (e: any) {
    log('WARN', 'Studio', `DIM_PARTICIPANTS generation failed (non-fatal): ${e.message?.slice(0, 200)}`, { jobId });
    return 0;
  }
}
